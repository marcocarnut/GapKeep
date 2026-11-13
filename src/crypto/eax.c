/*
 * eax.c - EAX with AES (see eax.h): CTR, and OMAC^t (M) = CMAC (K, [t] || M)
 * with t a whole block (SP 800-38B for CMAC).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "eax.h"
#include "wipe.h"
#include <mbedtls/aes.h>
#include <stdlib.h>
#include <string.h>

static void enc (const gk_eax_key_t *key, const uint8_t in[16], uint8_t out[16])
{
	mbedtls_aes_crypt_ecb ((mbedtls_aes_context *) key->enc, MBEDTLS_AES_ENCRYPT, in, out);
}

/* L * x in GF(2^128), for CMAC's subkeys (constant-time) */
static void dbl (const uint8_t in[16], uint8_t out[16])
{
	uint8_t carry = (uint8_t) (0 - (in[0] >> 7));
	for (int i = 0; i < 15; i++)
	{
		out[i] = (uint8_t) (in[i] << 1 | in[i + 1] >> 7);
	}
	out[15] = (uint8_t) ((in[15] << 1) ^ (carry & 0x87));
}

/* CMAC in steps; the last block held back for the final step's subkey */
typedef struct
{
	uint8_t x[16], last[16];
	size_t lastlen;
}
cmac_t;

static void cmac_update (const gk_eax_key_t *key, uint8_t x[16], uint8_t last[16], size_t *lastlen,
			 const uint8_t *p, size_t len)
{
	while (len > 0)
	{
		if (*lastlen == 16)
		{
			for (int i = 0; i < 16; i++) x[i] ^= last[i];
			enc (key, x, x);
			*lastlen = 0;
		}
		size_t n = 16 - *lastlen < len ? 16 - *lastlen : len;
		memcpy (last + *lastlen, p, n);
		*lastlen += n;
		p += n;
		len -= n;
	}
}

static void cmac_final (const gk_eax_key_t *key, uint8_t x[16], uint8_t last[16], size_t lastlen, uint8_t out[16])
{
	const uint8_t *k = key->k1;
	if (lastlen < 16)
	{
		last[lastlen] = 0x80;
		memset (last + lastlen + 1, 0, 15 - lastlen);
		k = key->k2;
	}
	for (int i = 0; i < 16; i++) x[i] ^= last[i] ^ k[i];
	enc (key, x, out);
}

/* OMAC^t (M), all at once */
static void omac (const gk_eax_key_t *key, uint8_t t, const uint8_t *p, size_t len, uint8_t out[16])
{
	cmac_t c;
	memset (&c, 0, sizeof c);
	c.last[15] = t;
	c.lastlen = 16;
	cmac_update (key, c.x, c.last, &c.lastlen, p, len);
	cmac_final (key, c.x, c.last, c.lastlen, out);
	gk_wipe (&c, sizeof c);
}

int gk_eax_key_init (gk_eax_key_t *key, const uint8_t *k, size_t klen)
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
	uint8_t l[16] = { 0 };
	enc (key, l, l);
	dbl (l, key->k1);
	dbl (key->k1, key->k2);
	gk_wipe (l, sizeof l);
	return 0;
}

void gk_eax_key_free (gk_eax_key_t *key)
{
	if (key->enc != 0)
	{
		mbedtls_aes_free ((mbedtls_aes_context *) key->enc);
		free (key->enc);
	}
	gk_wipe (key, sizeof *key);
}

void gk_eax_start (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *nonce, size_t nlen,
		   const uint8_t *ad, size_t adlen)
{
	memset (st, 0, sizeof *st);
	omac (key, 0, nonce, nlen, st->n);
	omac (key, 1, ad, adlen, st->h);
	memcpy (st->ctr, st->n, 16);
	st->last[15] = 2;			/* OMAC^2 of the ciphertext, under way */
	st->lastlen = 16;
}

static void ctr_xor (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	uint8_t ks[16];
	enc (key, st->ctr, ks);
	for (int i = 15; i >= 0; i--)		/* the whole block counts */
	{
		if (++st->ctr[i] != 0) break;
	}
	for (size_t i = 0; i < len; i++)
	{
		out[i] = in[i] ^ ks[i];
	}
	gk_wipe (ks, sizeof ks);
}

void gk_eax_encrypt_blocks (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	for (size_t at = 0; at + 16 <= len; at += 16)
	{
		ctr_xor (key, st, in + at, out + at, 16);
		cmac_update (key, st->x, st->last, &st->lastlen, out + at, 16);
	}
}

void gk_eax_decrypt_blocks (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *in, uint8_t *out, size_t len)
{
	uint8_t c[16];
	for (size_t at = 0; at + 16 <= len; at += 16)
	{
		memcpy (c, in + at, 16);
		cmac_update (key, st->x, st->last, &st->lastlen, c, 16);
		ctr_xor (key, st, c, out + at, 16);
	}
}

void gk_eax_finish (const gk_eax_key_t *key, gk_eax_t *st, int decrypt, const uint8_t *in, uint8_t *out,
		    size_t len, uint8_t tag[GK_EAX_TAG])
{
	uint8_t c[16];
	if (len > 0)
	{
		memcpy (c, in, len);
		if (decrypt)
		{
			cmac_update (key, st->x, st->last, &st->lastlen, c, len);
			ctr_xor (key, st, c, out, len);
		}
		else
		{
			ctr_xor (key, st, c, out, len);
			cmac_update (key, st->x, st->last, &st->lastlen, out, len);
		}
	}
	cmac_final (key, st->x, st->last, st->lastlen, tag);
	for (int i = 0; i < 16; i++)
	{
		tag[i] ^= st->n[i] ^ st->h[i];
	}
	gk_wipe (c, sizeof c);
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

int gk_eax_selftest (void)
{
	/* the EAX paper's (eprint.iacr.org/2003/069, appendix): key, nonce,
	   header, message, ciphertext || tag */
	static const struct { const char *k, *n, *a, *p, *c; } v[] =
	{
		{ "233952dee4d5ed5f9b9c6d6ff80ff478", "62ec67f9c3a4a407fcb2a8c49031a8b3", "6bfb914fd07eae6b",
		  "", "e037830e8389f27b025a2d6527e79d01" },
		{ "91945d3f4dcbee0bf45ef52255f095a4", "becaf043b0a23d843194ba972c66debd", "fa3bfd4806eb53fa",
		  "f7fb", "19dd5c4c9331049d0bdab0277408f67967e5" },
		{ "01f74ad64077f2e704c0f60ada3dd523", "70c3db4f0d26368400a10ed05d2bff5e", "234a3463c1264ac6",
		  "1a47cb4933", "d851d5bae03a59f238a23e39199dc9266626c40f80" },
		{ "d07cf6cbb7f313bdde66b727afd3c5e8", "8408dfff3c1a2b1292dc199e46b7d617", "33cce2eabff5a79d",
		  "481c9e39b1", "632a9d131ad4c168a4225d8e1ff755939974a7bede" },
		{ "35b6d0580005bbc12b0587124557d2c2", "fdb6b06676eedc5c61d74276e1f8e816", "aeb96eaebe2970e9",
		  "40d0c07da5e4", "071dfe16c675cb0677e536f73afe6a14b74ee49844dd" },
		{ "bd8e6e11475e60b268784c38c62feb22", "6eac5c93072d8e8513f750935e46da1b", "d4482d1ca78dce0f",
		  "4de3b35c3fc039245bd1fb7d", "835bb4f15d743e350e728414abb8644fd6ccb86947c5e10590210a4f" },
		{ "7c77d6e813bed5ac98baa417477a2e7d", "1a8c98dcd73d38393b2bf1569deefc19", "65d2017990d62528",
		  "8b0a79306c9ce7ed99dae4f87f8dd61636", "02083e3979da014812f59f11d52630da30137327d10649b0aa6e1c181db617d7f2" },
		{ "5fff20cafab119ca2fc73549e20f5b0d", "dde59b97d722156d4d9aff2bc7559826", "54b9f04e6a09189a",
		  "1bda122bce8a8dbaf1877d962b8592dd2d56", "2ec47b2c4954a489afc7ba4897edcdae8cc33b60450599bd02c96382902aef7f832a" },
		{ "a4a4782bcffd3ec5e7ef6d8c34a56123", "b781fcf2f75fa5a8de97a9ca48e522ec", "899a175897561d7e",
		  "6cf36720872b8513f6eab1a8a44438d5ef11", "0de18fd0fdd91e7af19f1d8ee8733938b1e8e7f6d2231618102fdb7fe55ff1991700" },
		{ "8395fcf1e95bebd697bd010bc766aac3", "22e7add93cfc6393c57ec0b3c17d6b44", "126735fcc320d25a",
		  "ca40d7446e545ffaed3bd12a740a659ffbbb3ceab7", "cb8920f87a6c75cff39627b56e3ed197c552d295a7cfc46afc253b4652b1af3795b124ab6e" },
	};
	uint8_t k[16], n[16], a[16], p[32], c[48], out[48], tag[16];
	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		size_t kl = unhex (v[i].k, k), nl = unhex (v[i].n, n), al = unhex (v[i].a, a);
		size_t pl = unhex (v[i].p, p), cl = unhex (v[i].c, c);
		gk_eax_key_t key;
		gk_eax_t st;
		if (gk_eax_key_init (&key, k, kl) != 0) return 100;
		size_t whole = pl & ~(size_t) 15;
		gk_eax_start (&key, &st, n, nl, a, al);
		gk_eax_encrypt_blocks (&key, &st, p, out, whole);
		gk_eax_finish (&key, &st, 0, p + whole, out + whole, pl - whole, tag);
		int bad = cl != pl + 16 || memcmp (out, c, pl) != 0 || memcmp (tag, c + pl, 16) != 0;
		gk_eax_start (&key, &st, n, nl, a, al);
		gk_eax_decrypt_blocks (&key, &st, c, out, whole);
		gk_eax_finish (&key, &st, 1, c + whole, out + whole, pl - whole, tag);
		bad |= memcmp (out, p, pl) != 0 || memcmp (tag, c + pl, 16) != 0;
		gk_eax_key_free (&key);
		if (bad) return 1 + (int) i;
	}
	return 0;
}
