/*
 * s2k.c - OpenPGP string-to-key (RFC 9580, 3.7.1.1 to 3.7.1.3), written
 * from the RFC.
 *
 * Every type is the same loop: each output hash takes its index's zero
 * bytes, then the first `total` bytes of an endless repetition of a
 * pattern (the passphrase for type 0; the salt and passphrase for types 1
 * and 3, once for type 1, to the count for type 3). The pattern sits in a
 * buffer of whole copies, so any run from a position in the first copy to
 * the buffer's end is the stream's continuation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "s2k.h"
#include "wipe.h"
#include "hexcheck.h"
#include <stdlib.h>
#include <string.h>

#define CHUNK		1024		/* the pattern's copies, at most (one if longer) */
#define STOP_EVERY	(1024 * 1024)	/* bytes hashed between stop() questions */

uint32_t gk_s2k_count (uint8_t c)
{
	return (uint32_t) (16 + (c & 15)) << ((c >> 4) + 6);
}

int gk_s2k_begin (gk_s2k_job_t *job, const gk_hash_t *hash, int type, const void *passphrase,
		  size_t passlen, const uint8_t *salt, uint8_t coded_count, size_t outlen)
{
	memset (job, 0, sizeof *job);
	if (type != GK_S2K_SIMPLE && type != GK_S2K_SALTED && type != GK_S2K_ITERATED)
	{
		return -2;
	}
	if (outlen < 1 || outlen > GK_S2K_MAX_OUTPUT)
	{
		return -4;
	}

	/* RFC 9580, 3.7.1.3: a count below one salt and passphrase hashes
	   them once, as type 1 does */
	size_t saltlen = type == GK_S2K_SIMPLE ? 0 : GK_S2K_SALT_SIZE;
	job->period = saltlen + passlen;
	job->total = job->period;
	if (type == GK_S2K_ITERATED && gk_s2k_count (coded_count) > job->period)
	{
		job->total = gk_s2k_count (coded_count);
	}

	if (job->period > 0)
	{
		size_t copies = job->period <= CHUNK ? CHUNK / job->period : 1;
		job->bufsize = copies * job->period;
		job->buf = malloc (job->bufsize);
		if (job->buf == 0)
		{
			return -3;
		}
		for (size_t i = 0; i < copies; i++)
		{
			if (saltlen > 0)
			{
				memcpy (job->buf + i * job->period, salt, saltlen);
			}
			memcpy (job->buf + i * job->period + saltlen, passphrase, passlen);
		}
	}

	job->hash = hash;
	job->outlen = outlen;
	return 0;
}

int gk_s2k_step (gk_s2k_job_t *job, size_t budget)
{
	static const uint8_t zeros[GK_S2K_MAX_OUTPUT] = { 0 };
	const gk_hash_t *hash = job->hash;

	while (job->done < job->outlen)
	{
		if (!job->active)
		{
			/* the next hash (fewer than GK_S2K_MAX_OUTPUT of them) */
			hash->init (&job->ctx);
			hash->update (&job->ctx, zeros, job->index);
			job->left = job->total;
			job->pos = 0;
			job->active = 1;
		}

		while (job->left > 0 && budget > 0)
		{
			size_t n = job->bufsize - job->pos;
			if (n > job->left) n = (size_t) job->left;
			if (n > budget) n = budget;
			hash->update (&job->ctx, job->buf + job->pos, n);
			job->pos = (job->pos + n) % job->period;
			job->left -= n;
			budget -= n;
		}
		if (job->left > 0)
		{
			return 1;		/* the budget is spent */
		}

		uint8_t digest[GK_HASH_MAX_DIGEST];
		hash->final (&job->ctx, digest);	/* wipes ctx */
		job->active = 0;
		size_t n = job->outlen - job->done;
		if (n > hash->digest_size) n = hash->digest_size;
		memcpy (job->out + job->done, digest, n);
		gk_wipe (digest, sizeof digest);
		job->done += n;
		job->index++;
		if (budget == 0 && job->done < job->outlen)
		{
			return 1;
		}
	}
	return 0;
}

double gk_s2k_progress (const gk_s2k_job_t *job)
{
	if (job->hash == 0 || job->outlen == 0)
	{
		return 0;
	}
	size_t hashes = (job->outlen + job->hash->digest_size - 1) / job->hash->digest_size;
	double each = job->total > 0 ? (double) job->total : 1;
	double done = (double) job->index * each + (job->active ? each - (double) job->left : 0);
	return done / (each * (double) hashes);
}

void gk_s2k_end (gk_s2k_job_t *job)
{
	if (job->buf != 0)
	{
		gk_wipe (job->buf, job->bufsize);
		free (job->buf);
	}
	gk_wipe (job, sizeof *job);
}

int gk_s2k (const gk_hash_t *hash, int type, const void *passphrase, size_t passlen,
	    const uint8_t *salt, uint8_t coded_count, uint8_t *out, size_t outlen,
	    int (*stop) (void *), void *arg)
{
	gk_s2k_job_t job;
	int result = gk_s2k_begin (&job, hash, type, passphrase, passlen, salt, coded_count, outlen);
	if (result != 0)
	{
		return result;
	}
	while (gk_s2k_step (&job, STOP_EVERY))
	{
		if (stop != 0 && stop (arg))
		{
			gk_s2k_end (&job);
			gk_wipe (out, outlen);
			return -1;
		}
	}
	memcpy (out, job.out, outlen);
	gk_s2k_end (&job);
	return 0;
}

int gk_s2k_selftest (void)
{
	static const uint8_t salt[GK_S2K_SALT_SIZE] = { 1, 2, 3, 4, 5, 6, 7, 8 };
	uint8_t pass[1100], d[48];

	/* type 3, SHA-1, 65536 bytes, two hashes (the second preloaded) */
	gk_s2k (&gk_hash_sha1, GK_S2K_ITERATED, "hello world", 11, salt, 0x60, d, 32, 0, 0);
	if (!gk_hex_equal (d, 32, "3251cc71bbba6d556b738cd47f5070e3634833e818a6d2bafab4a582d1deba88")) return 1;
	/* the same in uneven steps */
	gk_s2k_job_t job;
	if (gk_s2k_begin (&job, &gk_hash_sha1, GK_S2K_ITERATED, "hello world", 11, salt, 0x60, 32) != 0)
	{
		return 8;
	}
	size_t budget = 1;
	while (gk_s2k_step (&job, budget))
	{
		budget = budget * 3 + 1;
		if (budget > 5000) budget = 7;
	}
	int same = gk_hex_equal (job.out, 32, "3251cc71bbba6d556b738cd47f5070e3634833e818a6d2bafab4a582d1deba88");
	gk_s2k_end (&job);
	if (!same) return 9;
	/* type 1, SHA-256 */
	gk_s2k (&gk_hash_sha256, GK_S2K_SALTED, "password", 8, salt, 0, d, 32, 0, 0);
	if (!gk_hex_equal (d, 32, "401cee42f1e78e4ce02e01102870bd121c252c9f617db439352f749ceecaadfc")) return 2;
	/* type 0, SHA-512, an empty passphrase: SHA-512 ("") */
	gk_s2k (&gk_hash_sha512, GK_S2K_SIMPLE, "", 0, 0, 0, d, 16, 0, 0);
	if (!gk_hex_equal (d, 16, "cf83e1357eefb8bdf1542850d66d8007")) return 3;
	/* type 3, the count (1024) below salt and passphrase (1108): once */
	memset (pass, 'x', 1100);
	gk_s2k (&gk_hash_sha256, GK_S2K_ITERATED, pass, 1100, salt, 0, d, 24, 0, 0);
	if (!gk_hex_equal (d, 24, "5700f356ee4b5ed8ee30f871f124824ce3c670ab149d5dde")) return 4;
	/* type 3, SHA-384, 2048 bytes of 1008-byte copies */
	memset (pass, 'y', 1000);
	gk_s2k (&gk_hash_sha384, GK_S2K_ITERATED, pass, 1000, salt, 0x10, d, 48, 0, 0);
	if (!gk_hex_equal (d, 48, "15df07f7f9714360a825341a3adaf218250961891f21a4c5"
				  "c0ad76783bfdeae5f34e501f1fb30b766c76cd3aa802cee0")) return 5;
	/* type 0, SHA-224, 40 bytes: two hashes */
	gk_s2k (&gk_hash_sha224, GK_S2K_SIMPLE, "abc", 3, 0, 0, d, 40, 0, 0);
	if (!gk_hex_equal (d, 40, "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"
				  "a5b29b7d277ee5f8472f0c9f")) return 6;
	if (gk_s2k_count (0) != 1024 || gk_s2k_count (0x60) != 65536 || gk_s2k_count (255) != 65011712)
	{
		return 7;
	}

	gk_wipe (pass, sizeof pass);
	gk_wipe (d, sizeof d);
	return 0;
}
