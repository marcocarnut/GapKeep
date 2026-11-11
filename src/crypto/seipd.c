/*
 * seipd.c - OpenPGP SEIPD version 1 decryption, AES only (see seipd.h).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "seipd.h"
#include "wipe.h"
#include "hexcheck.h"
#include <mbedtls/aes.h>
#include <stdlib.h>
#include <string.h>

int gk_seipd1_begin (gk_seipd1_job_t *job, const uint8_t *key, size_t keylen, const uint8_t *data, size_t len)
{
	memset (job, 0, sizeof *job);
	if (keylen != 16 && keylen != 24 && keylen != 32)
	{
		return -2;
	}
	if (len < GK_SEIPD1_MIN)
	{
		return -4;
	}
	mbedtls_aes_context *aes = calloc (1, sizeof *aes);
	job->buf = malloc (len);
	if (aes == 0 || job->buf == 0)
	{
		free (aes);
		free (job->buf);
		job->buf = 0;
		return -3;
	}
	mbedtls_aes_init (aes);
	if (mbedtls_aes_setkey_enc (aes, key, (unsigned) keylen * 8) != 0)	/* CFB: forwards */
	{
		mbedtls_aes_free (aes);
		free (aes);
		free (job->buf);
		job->buf = 0;
		return -2;
	}
	job->aes = aes;
	memcpy (job->buf, data, len);
	job->len = len;
	gk_sha1_init (&job->sha);		/* feedback: the zero IV */
	return 0;
}

int gk_seipd1_step (gk_seipd1_job_t *job, size_t budget)
{
	size_t n = job->len - job->pos;
	if (n > budget) n = budget;
	uint8_t *p = job->buf + job->pos;
	mbedtls_aes_crypt_cfb128 ((mbedtls_aes_context *) job->aes, MBEDTLS_AES_DECRYPT, n, &job->offset,
				  job->feedback, p, p);
	/* the MDC's hash covers everything before its own 20 bytes */
	size_t hashed_end = job->len - 20;
	if (job->pos < hashed_end)
	{
		size_t h = job->pos + n < hashed_end ? n : hashed_end - job->pos;
		gk_sha1_update (&job->sha, p, h);
	}
	job->pos += n;
	return job->pos < job->len;
}

double gk_seipd1_progress (const gk_seipd1_job_t *job)
{
	return job->len > 0 ? (double) job->pos / (double) job->len : 0;
}

int gk_seipd1_result (gk_seipd1_job_t *job, const uint8_t **plain, size_t *plainlen)
{
	*plain = 0;
	*plainlen = 0;
	if (job->buf == 0 || job->pos != job->len)
	{
		return -1;
	}
	uint8_t digest[20];
	gk_sha1_final (&job->sha, digest);
	const uint8_t *mdc = job->buf + job->len - GK_SEIPD1_MDC;
	/* the MDC packet's header and hash, compared without a shortcut;
	   the prefix's repeated bytes are not looked at */
	uint8_t diff = (uint8_t) ((mdc[0] ^ 0xd3) | (mdc[1] ^ 0x14));
	for (int i = 0; i < 20; i++)
	{
		diff |= digest[i] ^ mdc[2 + i];
	}
	gk_wipe (digest, sizeof digest);
	if (diff != 0)
	{
		return -1;
	}
	*plain = job->buf + GK_SEIPD1_PREFIX;
	*plainlen = job->len - GK_SEIPD1_MIN;
	return 0;
}

void gk_seipd1_end (gk_seipd1_job_t *job)
{
	if (job->aes != 0)
	{
		mbedtls_aes_free ((mbedtls_aes_context *) job->aes);	/* wipes the key schedule */
		free (job->aes);
	}
	if (job->buf != 0)
	{
		gk_wipe (job->buf, job->len);
		free (job->buf);
	}
	gk_wipe (job, sizeof *job);
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

/* 0: decrypted to want; 1: refused; -1: something else */
static int decrypt (const uint8_t *key, const uint8_t *c, size_t len, const char *want, size_t budget)
{
	gk_seipd1_job_t job;
	if (gk_seipd1_begin (&job, key, 16, c, len) != 0)
	{
		return -1;
	}
	while (gk_seipd1_step (&job, budget))
	{
	}
	const uint8_t *plain;
	size_t plainlen;
	int result = gk_seipd1_result (&job, &plain, &plainlen) == 0
		     ? (gk_hex_equal (plain, plainlen, want) ? 0 : -1) : 1;
	gk_seipd1_end (&job);
	return result;
}

int gk_seipd1_selftest (void)
{
	/* made with Python's cryptography: key 00 01 .. 0f, a literal data
	   packet; the second's prefix doesn't repeat its last two bytes */
	static const char Plain[] = "cb186200000000004761704b656570205345495044207631";
	static const char Good[] =
		"a2c45d50efe631e90322ef0dd1b9aa0a04429abc84839f390526c3b005306eef"
		"8bd0d47e38e105f8f146aee5f8b6106d02cc7c4814bdabaf6445e18210e8f223";
	static const char NoQuickCheck[] =
		"a2c45d50efe631e90322ef0dd1b9aa0a76319abc84839f390526c3b005306eef"
		"90cf06bfe3a878ac37b3c3a7a8eca7cfe95d89eb485d3e0b44a33d5ffc513f54";
	uint8_t key[16], c[64];
	for (int i = 0; i < 16; i++) key[i] = (uint8_t) i;

	size_t len = unhex (Good, c);
	if (decrypt (key, c, len, Plain, 64) != 0) return 1;
	if (decrypt (key, c, len, Plain, 5) != 0) return 2;		/* in uneven steps */
	c[30] ^= 1;
	if (decrypt (key, c, len, Plain, 64) != 1) return 3;	/* the ciphertext */
	c[30] ^= 1;
	c[63] ^= 0x80;
	if (decrypt (key, c, len, Plain, 64) != 1) return 4;	/* the MDC */
	c[63] ^= 0x80;
	if (decrypt (key, c, len - 1, "", 64) != 1) return 5;	/* truncated */
	len = unhex (NoQuickCheck, c);
	if (decrypt (key, c, len, Plain, 64) != 0) return 6;	/* the quick check ignored */
	key[0] ^= 1;
	if (decrypt (key, c, len, Plain, 64) != 1) return 7;	/* another key */
	return 0;
}
