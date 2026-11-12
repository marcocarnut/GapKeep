/*
 * gcm.c - GCM with AES (see gcm.h), written from NIST SP 800-38D.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "gcm.h"
#include "wipe.h"
#include <mbedtls/aes.h>
#include <stdlib.h>
#include <string.h>

static uint64_t be64 (const uint8_t *p)
{
	uint64_t x = 0;
	for (int i = 0; i < 8; i++) x = x << 8 | p[i];
	return x;
}

static void put64 (uint8_t *p, uint64_t x)
{
	for (int i = 7; i >= 0; i--) { p[i] = (uint8_t) x; x >>= 8; }
}

static void enc (const gk_gcm_key_t *key, const uint8_t in[16], uint8_t out[16])
{
	mbedtls_aes_crypt_ecb ((mbedtls_aes_context *) key->enc, MBEDTLS_AES_ENCRYPT, in, out);
}

/* X = X * H in GF(2^128) (SP 800-38D, 6.3), bit by bit: every bit of X
   costs the same, whatever it is */
static void gmul (uint64_t x[2], const uint64_t h[2])
{
	uint64_t z0 = 0, z1 = 0, v0 = h[0], v1 = h[1];
	for (int i = 0; i < 128; i++)
	{
		uint64_t bit = (i < 64 ? x[0] >> (63 - i) : x[1] >> (127 - i)) & 1;
		uint64_t m = 0 - bit;
		z0 ^= v0 & m;
		z1 ^= v1 & m;
		uint64_t lsb = 0 - (v1 & 1);
		v1 = (v1 >> 1) | (v0 << 63);
		v0 = (v0 >> 1) ^ (0xe100000000000000ULL & lsb);
	}
	x[0] = z0;
	x[1] = z1;
}

static void ghash_block (gk_gcm_t *st, const gk_gcm_key_t *key, const uint8_t b[16])
{
	st->x[0] ^= be64 (b);
	st->x[1] ^= be64 (b + 8);
	gmul (st->x, key->h);
}

static void ghash_padded (gk_gcm_t *st, const gk_gcm_key_t *key, const uint8_t *p, size_t len)
{
	uint8_t b[16];
	for (; len >= 16; p += 16, len -= 16)
	{
		ghash_block (st, key, p);
	}
	if (len > 0)
	{
		memset (b, 0, 16);
		memcpy (b, p, len);
		ghash_block (st, key, b);
	}
}

static void inc32 (uint8_t ctr[16])
{
	for (int i = 15; i >= 12; i--)
	{
		if (++ctr[i] != 0) break;
	}
}

int gk_gcm_key_init (gk_gcm_key_t *key, const uint8_t *k, size_t klen)
{
	memset (key, 0, sizeof *key);
	if (klen != 16 && klen != 24 && klen != 32)
	{
		return -2;
	}
	mbedtls_aes_context *e = calloc (1, sizeof *e);
	if (e == 0)
	{
		return -3;
	}
	mbedtls_aes_init (e);
	if (mbedtls_aes_setkey_enc (e, k, (unsigned) klen * 8) != 0)
	{
		mbedtls_aes_free (e);
		free (e);
		return -2;
	}
	key->enc = e;
	static const uint8_t zeros[16] = { 0 };
	uint8_t h[16];
	enc (key, zeros, h);
	key->h[0] = be64 (h);
	key->h[1] = be64 (h + 8);
	gk_wipe (h, sizeof h);
	return 0;
}

void gk_gcm_key_free (gk_gcm_key_t *key)
{
	if (key->enc != 0)
	{
		mbedtls_aes_free ((mbedtls_aes_context *) key->enc);
		free (key->enc);
	}
	gk_wipe (key, sizeof *key);
}

void gk_gcm_start (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t nonce[GK_GCM_NONCE],
		   const uint8_t *ad, size_t adlen)
{
	memset (st, 0, sizeof *st);
	memcpy (st->j0, nonce, 12);		/* J0 = IV || 0^31 || 1 */
	st->j0[15] = 1;
	memcpy (st->ctr, st->j0, 16);
	inc32 (st->ctr);
	ghash_padded (st, key, ad, adlen);
	st->adlen = adlen;
}

static void ctr_xor (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	uint8_t ks[16];
	enc (key, st->ctr, ks);
	inc32 (st->ctr);
	for (size_t i = 0; i < len; i++)
	{
		out[i] = in[i] ^ ks[i];
	}
	gk_wipe (ks, sizeof ks);
}

void gk_gcm_encrypt_blocks (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	for (size_t at = 0; at + 16 <= len; at += 16)
	{
		ctr_xor (key, st, in + at, out + at, 16);
		ghash_block (st, key, out + at);
	}
	st->clen += len;
}

void gk_gcm_decrypt_blocks (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	uint8_t c[16];
	for (size_t at = 0; at + 16 <= len; at += 16)
	{
		memcpy (c, in + at, 16);
		ghash_block (st, key, c);
		ctr_xor (key, st, c, out + at, 16);
	}
	st->clen += len;
}

void gk_gcm_finish (const gk_gcm_key_t *key, gk_gcm_t *st, int decrypt, const uint8_t *in, uint8_t *out,
		    size_t len, uint8_t tag[GK_GCM_TAG])
{
	uint8_t c[16], b[16];
	if (len > 0)
	{
		memcpy (c, in, len);
		if (decrypt)
		{
			ghash_padded (st, key, c, len);
			ctr_xor (key, st, c, out, len);
		}
		else
		{
			ctr_xor (key, st, c, out, len);
			ghash_padded (st, key, out, len);
		}
		st->clen += len;
	}
	/* len (A) || len (C), in bits */
	put64 (b, st->adlen * 8);
	put64 (b + 8, st->clen * 8);
	ghash_block (st, key, b);
	/* T = E (K, J0) xor S */
	enc (key, st->j0, tag);
	put64 (b, st->x[0]);
	put64 (b + 8, st->x[1]);
	for (int i = 0; i < 16; i++)
	{
		tag[i] ^= b[i];
	}
	gk_wipe (c, sizeof c);
	gk_wipe (b, sizeof b);
	gk_wipe (st, sizeof *st);
}

static size_t unhex (const char *hex, uint8_t *out)
{
	size_t n = 0;
	for (; hex[0] && hex[1]; hex += 2)
	{
		int hi = hex[0] <= '9' ? hex[0] - '0' : hex[0] - 'a' + 10;
		int lo = hex[1] <= '9' ? hex[1] - '0' : hex[1] - 'a' + 10;
		out[n++] = (uint8_t) (hi << 4 | lo);
	}
	return n;
}

int gk_gcm_selftest (void)
{
	/* made with Python's cryptography (AESGCM): key, nonce, AD,
	   plaintext, ciphertext || tag */
	static const struct { const char *k, *n, *a, *p, *c; } v[] =
	{
		{ "457c769f39d8644199c0e5bdbcfbc85b", "37ce91cbde1fc1b0ea6b44f1",
		  "", "",
		  "6bd7d2b76ede4ad2aa95e785aacf4aa8" },
		{ "30436dd729fe69bd9e8ceba6a07d1dec", "25b1b087efe26c07ff0d21d7",
		  "db0b33777738a5c674d37ff136eac13f553223a6", "3841460d3b6aa1e68d682728f610fb1c7fd92d5fa2e81478007152dea8651f3fce59796168e9338b87fe1a1a45cfed925923d43f99735b0320db2ebb",
		  "00d5851d6ba83841daa78e4c51f172af5c54359b6cd25d306c69c4a562d89e315948dcc53cabbcef807ec9dc929e5282f6fc66c47b574c3588fb9e84dc0646e7cecc2884143e58bca762719d" },
		{ "a29a7b376c967c681d288c47b1829c2e219c95ea9dcc11de", "459506c4f129b2635ed2db28",
		  "768b0dc3cc", "481e6a12ea4286231c69309e4b5e119e",
		  "95d4ddbb631b5d8dba5d5495205edef6381b42961be8188fbd7793af5d45a8f2" },
		{ "7ec0e071665c6f207889da2130517400b918ebf8aa6114dfb2335c01fbee9e35", "ab3c0ac619c62937bfe3caf5",
		  "37f37ffb5991752a801d56df2a", "5de70f4aba744b50f26b23f62869ea32968c0a8a8e5449e0444c86ada1da2fa034",
		  "b369ef87a9a8f24e2bb3ee6648a1644b9aef4890939b48c6fc39018bfd0859722622a6ebed7231200b1c2c8140e61392c7" },
		{ "6dd6812e97cde3f03456f3f717e9cdb03baa663226c270f7968e10f73241cce4", "57ef1a62f06d7d4c1ca08505",
		  "", "8af1765c9153376a80187c2a931b90ef64b84c25fc2d894300ffac10696af454b3de254d842541d1af6a659a8f5a0d964db7dd00961392984a198dadab432ab5",
		  "34bd1ec74c4503fc280ebd773e98a8dfbe5b230b8fcf7e8643512c416c1b52d8cc08f7de9e2ceccd6bbd0dcf18263ffebc87e90fca5ed74309372ef8ab3304727a33c35ebeff3c5be9b1938f2f08fffb" },
	};
	uint8_t k[32], n[12], a[64], p[64], c[80], out[80], tag[16];
	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		size_t kl = unhex (v[i].k, k), al = unhex (v[i].a, a), pl = unhex (v[i].p, p);
		unhex (v[i].n, n);
		size_t cl = unhex (v[i].c, c);
		gk_gcm_key_t key;
		gk_gcm_t st;
		if (gk_gcm_key_init (&key, k, kl) != 0) return 100;
		size_t whole = pl & ~(size_t) 15;
		gk_gcm_start (&key, &st, n, a, al);
		gk_gcm_encrypt_blocks (&key, &st, p, out, whole);
		gk_gcm_finish (&key, &st, 0, p + whole, out + whole, pl - whole, tag);
		int bad = cl != pl + 16 || memcmp (out, c, pl) != 0 || memcmp (tag, c + pl, 16) != 0;
		gk_gcm_start (&key, &st, n, a, al);
		gk_gcm_decrypt_blocks (&key, &st, c, out, whole);
		gk_gcm_finish (&key, &st, 1, c + whole, out + whole, pl - whole, tag);
		bad |= memcmp (out, p, pl) != 0 || memcmp (tag, c + pl, 16) != 0;
		gk_gcm_key_free (&key);
		if (bad) return 1 + (int) i;
	}
	return 0;
}
