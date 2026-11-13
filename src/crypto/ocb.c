/*
 * ocb.c - OCB3 (RFC 7253), AES, 128-bit tags (see ocb.h), written from the
 * RFC's section 4.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "ocb.h"
#include "wipe.h"
#include "hexcheck.h"
#include <mbedtls/aes.h>
#include <stdlib.h>
#include <string.h>

/* double (S): S << 1, xor 0x87 if the top bit was set (RFC 7253, 2) */
static void dbl (uint8_t out[16], const uint8_t in[16])
{
	uint8_t carry = in[0] >> 7;
	for (int i = 0; i < 15; i++)
	{
		out[i] = (uint8_t) (in[i] << 1 | in[i + 1] >> 7);
	}
	out[15] = (uint8_t) (in[15] << 1) ^ (uint8_t) (0x87 & (0u - carry));
}

static void xor16 (uint8_t *out, const uint8_t *a, const uint8_t *b)
{
	for (int i = 0; i < 16; i++)
	{
		out[i] = a[i] ^ b[i];
	}
}

static void enc (const gk_ocb_key_t *key, const uint8_t in[16], uint8_t out[16])
{
	mbedtls_aes_crypt_ecb ((mbedtls_aes_context *) key->enc, MBEDTLS_AES_ENCRYPT, in, out);
}

static unsigned ntz (uint64_t i)
{
	unsigned n = 0;
	while ((i & 1) == 0)
	{
		i >>= 1;
		n++;
	}
	return n;
}

int gk_ocb_key_init (gk_ocb_key_t *key, const uint8_t *k, size_t klen)
{
	memset (key, 0, sizeof *key);
	if (klen != 16 && klen != 24 && klen != 32)
	{
		return -2;
	}
	mbedtls_aes_context *e = calloc (1, sizeof *e), *d = calloc (1, sizeof *d);
	if (e == 0 || d == 0)
	{
		free (e);
		free (d);
		return -3;
	}
	mbedtls_aes_init (e);
	mbedtls_aes_init (d);
	if (   mbedtls_aes_setkey_enc (e, k, (unsigned) klen * 8) != 0
	    || mbedtls_aes_setkey_dec (d, k, (unsigned) klen * 8) != 0)
	{
		mbedtls_aes_free (e);
		mbedtls_aes_free (d);
		free (e);
		free (d);
		return -2;
	}
	key->enc = e;
	key->dec = d;

	static const uint8_t zeros[16] = { 0 };
	enc (key, zeros, key->lstar);			/* L_* = ENCIPHER (K, zeros) */
	dbl (key->ldollar, key->lstar);			/* L_$ = double (L_*) */
	dbl (key->l[0], key->ldollar);			/* L_0 = double (L_$) */
	for (int i = 1; i < 32; i++)
	{
		dbl (key->l[i], key->l[i - 1]);		/* L_i = double (L_{i-1}) */
	}
	return 0;
}

void gk_ocb_key_free (gk_ocb_key_t *key)
{
	if (key->enc != 0)
	{
		mbedtls_aes_free ((mbedtls_aes_context *) key->enc);	/* wipes the schedules */
		mbedtls_aes_free ((mbedtls_aes_context *) key->dec);
		free (key->enc);
		free (key->dec);
	}
	gk_wipe (key, sizeof *key);
}

void gk_ocb_start (const gk_ocb_key_t *key, gk_ocb_t *st, const uint8_t *nonce, size_t nlen)
{
	/* Nonce = num2str (TAGLEN mod 128, 7) || zeros || 1 || N: with a
	   128-bit tag the first seven bits are 0 */
	uint8_t n[16], ktop[16], stretch[24];
	memset (n, 0, sizeof n);
	memcpy (n + 16 - nlen, nonce, nlen);
	n[15 - nlen] |= 1;
	unsigned bottom = n[15] & 0x3f;
	n[15] &= 0xc0;
	enc (key, n, ktop);				/* Ktop = ENCIPHER (K, Nonce[1..122] || zeros (6)) */
	memcpy (stretch, ktop, 16);			/* Stretch = Ktop || (Ktop[1..64] xor Ktop[9..72]) */
	for (int i = 0; i < 8; i++)
	{
		stretch[16 + i] = ktop[i] ^ ktop[i + 1];
	}
	/* Offset_0 = Stretch[1 + bottom .. 128 + bottom] */
	unsigned bytes = bottom / 8, bits = bottom % 8;
	for (int i = 0; i < 16; i++)
	{
		st->offset[i] = bits == 0 ? stretch[i + bytes]
			: (uint8_t) (stretch[i + bytes] << bits | stretch[i + bytes + 1] >> (8 - bits));
	}
	memset (st->checksum, 0, 16);
	st->blocks = 0;
	gk_wipe (ktop, sizeof ktop);
	gk_wipe (stretch, sizeof stretch);
}

void gk_ocb_encrypt_blocks (const gk_ocb_key_t *key, gk_ocb_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	uint8_t b[16], p[16];
	for (size_t at = 0; at + 16 <= len; at += 16)
	{
		/* Offset_i = Offset_{i-1} xor L_{ntz (i)}; C_i = Offset_i xor ENCIPHER (K, P_i xor Offset_i) */
		st->blocks++;
		xor16 (st->offset, st->offset, key->l[ntz (st->blocks)]);
		memcpy (p, in + at, 16);
		xor16 (st->checksum, st->checksum, p);
		xor16 (b, p, st->offset);
		enc (key, b, b);
		xor16 (out + at, b, st->offset);
	}
	gk_wipe (b, sizeof b);
	gk_wipe (p, sizeof p);
}

void gk_ocb_decrypt_blocks (const gk_ocb_key_t *key, gk_ocb_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	uint8_t b[16];
	for (size_t at = 0; at + 16 <= len; at += 16)
	{
		/* P_i = Offset_i xor DECIPHER (K, C_i xor Offset_i) */
		st->blocks++;
		xor16 (st->offset, st->offset, key->l[ntz (st->blocks)]);
		xor16 (b, in + at, st->offset);
		mbedtls_aes_crypt_ecb ((mbedtls_aes_context *) key->dec, MBEDTLS_AES_DECRYPT, b, b);
		xor16 (out + at, b, st->offset);
		xor16 (st->checksum, st->checksum, out + at);
	}
	gk_wipe (b, sizeof b);
}

/* HASH (K, A) */
static void hash_ad (const gk_ocb_key_t *key, const uint8_t *ad, size_t adlen, uint8_t sum[16])
{
	uint8_t offset[16], b[16];
	memset (sum, 0, 16);
	memset (offset, 0, 16);
	uint64_t i = 0;
	size_t at = 0;
	for (; at + 16 <= adlen; at += 16)
	{
		i++;
		xor16 (offset, offset, key->l[ntz (i)]);
		xor16 (b, ad + at, offset);
		enc (key, b, b);
		xor16 (sum, sum, b);
	}
	if (at < adlen)
	{
		xor16 (offset, offset, key->lstar);
		memset (b, 0, 16);
		memcpy (b, ad + at, adlen - at);
		b[adlen - at] = 0x80;
		xor16 (b, b, offset);
		enc (key, b, b);
		xor16 (sum, sum, b);
	}
	gk_wipe (offset, sizeof offset);
	gk_wipe (b, sizeof b);
}

void gk_ocb_finish (const gk_ocb_key_t *key, gk_ocb_t *st, int decrypt, const uint8_t *in, uint8_t *out,
		    size_t len, const uint8_t *ad, size_t adlen, uint8_t tag[GK_OCB_TAG_SIZE])
{
	uint8_t pad[16], b[16];
	if (len > 0)
	{
		/* Offset_* = Offset_m xor L_*; Pad = ENCIPHER (K, Offset_*);
		   C_* = P_* xor Pad[1..bitlen (P_*)];
		   Checksum_* = Checksum_m xor (P_* || 1 || zeros) */
		xor16 (st->offset, st->offset, key->lstar);
		enc (key, st->offset, pad);
		memset (b, 0, 16);
		for (size_t i = 0; i < len; i++)
		{
			uint8_t x = in[i] ^ pad[i];
			b[i] = decrypt ? x : in[i];
			out[i] = x;
		}
		b[len] = 0x80;
		xor16 (st->checksum, st->checksum, b);
	}
	/* Tag = ENCIPHER (K, Checksum xor Offset xor L_$) xor HASH (K, A) */
	xor16 (b, st->checksum, st->offset);
	xor16 (b, b, key->ldollar);
	enc (key, b, tag);
	hash_ad (key, ad, adlen, b);
	xor16 (tag, tag, b);
	gk_wipe (pad, sizeof pad);
	gk_wipe (b, sizeof b);
	gk_wipe (st, sizeof *st);
}

void gk_ocb_encrypt (const gk_ocb_key_t *key, const uint8_t *nonce, size_t nlen, const uint8_t *ad, size_t adlen,
		     const uint8_t *in, uint8_t *out, size_t len, uint8_t tag[GK_OCB_TAG_SIZE])
{
	gk_ocb_t st;
	size_t whole = len & ~(size_t) 15;
	gk_ocb_start (key, &st, nonce, nlen);
	gk_ocb_encrypt_blocks (key, &st, in, out, whole);
	gk_ocb_finish (key, &st, 0, in + whole, out + whole, len - whole, ad, adlen, tag);
}

int gk_ocb_decrypt (const gk_ocb_key_t *key, const uint8_t *nonce, size_t nlen, const uint8_t *ad, size_t adlen,
		    const uint8_t *in, uint8_t *out, size_t len, const uint8_t tag[GK_OCB_TAG_SIZE])
{
	gk_ocb_t st;
	uint8_t want[16];
	size_t whole = len & ~(size_t) 15;
	gk_ocb_start (key, &st, nonce, nlen);
	gk_ocb_decrypt_blocks (key, &st, in, out, whole);
	gk_ocb_finish (key, &st, 1, in + whole, out + whole, len - whole, ad, adlen, want);
	uint8_t diff = 0;
	for (int i = 0; i < 16; i++)
	{
		diff |= want[i] ^ tag[i];
	}
	gk_wipe (want, sizeof want);
	if (diff != 0)
	{
		gk_wipe (out, len);
		return -1;
	}
	return 0;
}

static size_t unhex (const char *hex, uint8_t *out)
{
	size_t n = 0;
	for (; hex[0] && hex[1]; hex += 2)
	{
		int hi = hex[0] <= '9' ? hex[0] - '0' : (hex[0] | 0x20) - 'a' + 10;
		int lo = hex[1] <= '9' ? hex[1] - '0' : (hex[1] | 0x20) - 'a' + 10;
		out[n++] = (uint8_t) (hi << 4 | lo);
	}
	return n;
}

int gk_ocb_selftest (void)
{
	/* RFC 7253, Appendix A: K = 000102...0F; N = BBAA9988776655443322110x;
	   A and P are prefixes of 000102...; lengths (A, P) and C */
	static const struct { unsigned alen, plen; const char *c; } v[] =
	{
		{ 0, 0, "785407bfffc8ad9edcc5520ac9111ee6" },
		{ 8, 8, "6820b3657b6f615a5725bda0d3b4eb3a257c9af1f8f03009" },
		{ 8, 0, "81017f8203f081277152fade694a0a00" },
		{ 0, 8, "45dd69f8f5aae72414054cd1f35d82760b2cd00d2f99bfa9" },
		{ 16, 16, "571d535b60b277188be5147170a9a22c3ad7a4ff3835b8c5701c1ccec8fc3358" },
		{ 16, 0, "8cf761b6902ef764462ad86498ca6b97" },
		{ 0, 16, "5ce88ec2e0692706a915c00aeb8b2396f40e1c743f52436bdf06d8fa1eca343d" },
		{ 24, 24, "1ca2207308c87c010756104d8840ce1952f09673a448a122c92c62241051f57356d7f3c90bb0e07f" },
		{ 24, 0, "6dc225a071fc1b9f7c69f93b0f1e10de" },
		{ 0, 24, "221bd0de7fa6fe993eccd769460a0af2d6cded0c395b1c3ce725f32494b9f914d85c0b1eb38357ff" },
		{ 32, 32, "bd6f6c496201c69296c11efd138a467abd3c707924b964deaffc40319af5a48540fbba186c5553c68ad9f592a79a4240" },
		{ 32, 0, "fe80690bee8a485d11f32965bc9d2a32" },
		{ 0, 32, "2942bfc773bda23cabc6acfd9bfd5835bd300f0973792ef46040c53f1432bcdfb5e1dde3bc18a5f840b52e653444d5df" },
		{ 40, 40, "d5ca91748410c1751ff8a2f618255b68a0a12e093ff454606e59f9c1d0ddc54b65e8628e568bad7aed07ba06a4a69483"
			  "a7035490c5769e60" },
		{ 40, 0, "c5cd9d1850c141e358649994ee701b68" },
		{ 0, 40, "4412923493c57d5de0d700f753cce0d1d2d95060122e9f15a5ddbfc5787e50b5cc55ee507bcb084e479ad363ac366b95"
			 "a98ca5f3000b1479" },
	};
	uint8_t k[16], nonce[12], data[48], out[64], tag[16];
	gk_ocb_key_t key;
	for (int i = 0; i < 16; i++) k[i] = (uint8_t) i;
	for (int i = 0; i < 48; i++) data[i] = (uint8_t) i;
	unhex ("bbaa99887766554433221100", nonce);
	if (gk_ocb_key_init (&key, k, 16) != 0)
	{
		return 100;
	}
	int result = 0;
	for (unsigned i = 0; i < sizeof v / sizeof v[0] && result == 0; i++)
	{
		uint8_t want[64];
		size_t clen = unhex (v[i].c, want);
		nonce[11] = (uint8_t) i;
		gk_ocb_encrypt (&key, nonce, 12, data, v[i].alen, data, out, v[i].plen, tag);
		if (clen != v[i].plen + 16 || memcmp (out, want, v[i].plen) != 0 || memcmp (tag, want + v[i].plen, 16) != 0)
		{
			result = 1 + 10 * (int) i;
		}
		else if (   gk_ocb_decrypt (&key, nonce, 12, data, v[i].alen, want, out, v[i].plen, want + v[i].plen) != 0
			 || memcmp (out, data, v[i].plen) != 0)
		{
			result = 2 + 10 * (int) i;
		}
		else
		{
			want[v[i].plen] ^= 1;
			if (gk_ocb_decrypt (&key, nonce, 12, data, v[i].alen, want, out, v[i].plen, want + v[i].plen) != -1)
			{
				result = 3 + 10 * (int) i;
			}
		}
	}
	gk_ocb_key_free (&key);
	return result;
}
