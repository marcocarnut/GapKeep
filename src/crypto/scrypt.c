/*
 * scrypt.c - scrypt (RFC 7914) in steps (see scrypt.h), written from the
 * RFC: Salsa20/8 (section 3), scryptBlockMix (4), scryptROMix (5) and
 * scrypt (6), with PBKDF2-HMAC-SHA256 (pbkdf2.c).
 *
 * The blocks are kept as little-endian 32-bit words (B is converted when a
 * lane starts and ends); X and Y alternate as BlockMix's input and output,
 * so which one holds X follows from the count of BlockMix calls done.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "scrypt.h"
#include "pbkdf2.h"
#include "wipe.h"
#include "hexcheck.h"
#include <stdlib.h>
#include <string.h>

typedef uint8_t u8;
typedef uint32_t u32;

enum { FILLING, WIPING, DONE };

static u32 load32_le (const u8 *s)
{
	return (u32) s[0] | (u32) s[1] << 8 | (u32) s[2] << 16 | (u32) s[3] << 24;
}

static void store32_le (u8 *out, u32 in)
{
	out[0] = (u8) in; out[1] = (u8) (in >> 8); out[2] = (u8) (in >> 16); out[3] = (u8) (in >> 24);
}

#define R(a, b) (((a) << (b)) | ((a) >> (32 - (b))))

/* Salsa20/8 core (RFC 7914, 3), in place: b = b + rounds (b) */
static void salsa20_8 (u32 b[16])
{
	u32 x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3], x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7];
	u32 x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11], x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15];
	for (int i = 0; i < 8; i += 2)
	{
		/* columns */
		x4 ^= R (x0 + x12, 7);   x8 ^= R (x4 + x0, 9);
		x12 ^= R (x8 + x4, 13);  x0 ^= R (x12 + x8, 18);
		x9 ^= R (x5 + x1, 7);    x13 ^= R (x9 + x5, 9);
		x1 ^= R (x13 + x9, 13);  x5 ^= R (x1 + x13, 18);
		x14 ^= R (x10 + x6, 7);  x2 ^= R (x14 + x10, 9);
		x6 ^= R (x2 + x14, 13);  x10 ^= R (x6 + x2, 18);
		x3 ^= R (x15 + x11, 7);  x7 ^= R (x3 + x15, 9);
		x11 ^= R (x7 + x3, 13);  x15 ^= R (x11 + x7, 18);
		/* rows */
		x1 ^= R (x0 + x3, 7);    x2 ^= R (x1 + x0, 9);
		x3 ^= R (x2 + x1, 13);   x0 ^= R (x3 + x2, 18);
		x6 ^= R (x5 + x4, 7);    x7 ^= R (x6 + x5, 9);
		x4 ^= R (x7 + x6, 13);   x5 ^= R (x4 + x7, 18);
		x11 ^= R (x10 + x9, 7);  x8 ^= R (x11 + x10, 9);
		x9 ^= R (x8 + x11, 13);  x10 ^= R (x9 + x8, 18);
		x12 ^= R (x15 + x14, 7); x13 ^= R (x12 + x15, 9);
		x14 ^= R (x13 + x12, 13); x15 ^= R (x14 + x13, 18);
	}
	b[0] += x0; b[1] += x1; b[2] += x2; b[3] += x3; b[4] += x4; b[5] += x5; b[6] += x6; b[7] += x7;
	b[8] += x8; b[9] += x9; b[10] += x10; b[11] += x11; b[12] += x12; b[13] += x13; b[14] += x14; b[15] += x15;
}

/* scryptBlockMix (RFC 7914, 4): in (2r blocks of 16 words) to out, which
   must not overlap it; t: 16 words of scratch */
static void block_mix (const u32 *in, u32 *out, u32 r, u32 *t)
{
	memcpy (t, in + (2 * r - 1) * 16, 64);
	for (u32 i = 0; i < 2 * r; i++)
	{
		for (int k = 0; k < 16; k++) t[k] ^= in[i * 16 + k];
		salsa20_8 (t);
		/* Y_0, Y_2, ... first, then Y_1, Y_3, ... */
		memcpy (out + ((i >> 1) + (i & 1) * r) * 16, t, 64);
	}
}

size_t gk_scrypt_memory (uint32_t n, uint32_t r)
{
	unsigned long long bytes = 128ull * r * n;
	return (size_t) bytes == bytes ? (size_t) bytes : 0;
}

int gk_scrypt_begin (gk_scrypt_job_t *job, void *work, uint32_t n, uint32_t r, uint32_t p,
		     const void *password, size_t passlen, const void *salt, size_t saltlen, uint32_t outlen)
{
	memset (job, 0, sizeof *job);
	if (   n < 2 || (n & (n - 1)) != 0 || (r < 2 && n >= 65536u)	/* N < 2^(128 r / 8) */
	    || r < 1 || p < 1 || r > GK_SCRYPT_MAX_RP || p > GK_SCRYPT_MAX_RP || r * p > GK_SCRYPT_MAX_RP
	    || outlen < 1 || outlen > GK_SCRYPT_MAX_OUT || gk_scrypt_memory (n, r) == 0)
	{
		return -4;
	}
	size_t blen = (size_t) p * 128 * r;
	job->b = (u8 *) malloc (blen);
	job->xy = (u32 *) malloc ((2 * 32 * r + 16) * sizeof (u32));
	job->password = (u8 *) malloc (passlen ? passlen : 1);
	if (job->b == 0 || job->xy == 0 || job->password == 0)
	{
		free (job->b);
		free (job->xy);
		free (job->password);
		memset (job, 0, sizeof *job);
		return -3;
	}
	memcpy (job->password, password, passlen);
	job->passlen = passlen;
	job->v = (u32 *) work;
	job->n = n;
	job->r = r;
	job->p = p;
	job->vwords = (size_t) 32 * r * n;
	job->outlen = outlen;

	/* B = PBKDF2-HMAC-SHA256 (P, S, 1, p * 128 r) */
	gk_pbkdf2 (&gk_hash_sha256, password, passlen, salt, saltlen, 1, job->b, blen);
	job->phase = FILLING;
	return 0;
}

static void finish (gk_scrypt_job_t *job)
{
	/* DK = PBKDF2-HMAC-SHA256 (P, B, 1, dkLen) */
	size_t blen = (size_t) job->p * 128 * job->r;
	gk_pbkdf2 (&gk_hash_sha256, job->password, job->passlen, job->b, blen, 1, job->out, job->outlen);
	gk_wipe (job->b, blen);
	gk_wipe (job->xy, (2 * 32 * job->r + 16) * sizeof (u32));
	gk_wipe (job->password, job->passlen);
	job->phase = WIPING;
}

void gk_scrypt_abort (gk_scrypt_job_t *job)
{
	if (job->phase == FILLING)
	{
		if (job->b != 0)
		{
			gk_wipe (job->b, (size_t) job->p * 128 * job->r);
			gk_wipe (job->xy, (2 * 32 * job->r + 16) * sizeof (u32));
			gk_wipe (job->password, job->passlen);
		}
		job->phase = WIPING;
	}
	gk_wipe (job->out, sizeof job->out);
}

int gk_scrypt_step (gk_scrypt_job_t *job, uint32_t budget)
{
	const u32 r = job->r, n = job->n, words = 32 * r;
	u32 *t = job->xy + 2 * words;
	while (budget > 0 && job->phase == FILLING)
	{
		u8 *b = job->b + (size_t) job->lane * 128 * r;
		if (job->i == 0)
		{
			/* X = B_lane */
			for (u32 k = 0; k < words; k++) job->xy[k] = load32_le (b + 4 * k);
		}
		/* X is the output of the last BlockMix: xy's half i mod 2 */
		u32 *x = job->xy + (job->i & 1) * words, *y = job->xy + ((job->i + 1) & 1) * words;
		if (job->i < n)
		{
			/* V_i = X; X = BlockMix (X) */
			memcpy (job->v + (size_t) job->i * words, x, words * sizeof (u32));
		}
		else
		{
			/* j = Integerify (X) mod N; X = BlockMix (X xor V_j) */
			const u32 *vj = job->v + (size_t) (x[(2 * r - 1) * 16] & (n - 1)) * words;
			for (u32 k = 0; k < words; k++) x[k] ^= vj[k];
		}
		block_mix (x, y, r, t);
		budget--;
		if (++job->i == 2 * n)
		{
			/* B_lane = X (2N calls: back in the first half) */
			for (u32 k = 0; k < words; k++) store32_le (b + 4 * k, job->xy[k]);
			job->i = 0;
			if (++job->lane == job->p)
			{
				finish (job);
			}
		}
	}
	if (job->phase == WIPING)
	{
		/* the work area, a part a step (about 8 times what a BlockMix
		   touches, per unit of budget) */
		size_t m = ((size_t) budget * 8 + 64) * words;
		if (m > job->vwords - job->wiped) m = job->vwords - job->wiped;
		gk_wipe (job->v + job->wiped, m * sizeof (u32));
		job->wiped += m;
		if (job->wiped == job->vwords)
		{
			job->phase = DONE;
		}
	}
	return job->phase != DONE;
}

double gk_scrypt_progress (const gk_scrypt_job_t *job)
{
	if (job->phase != FILLING)
	{
		return job->vwords ? 0.97 + 0.03 * (double) job->wiped / (double) job->vwords : 1;
	}
	double per_lane = 2.0 * job->n;
	return 0.97 * ((double) job->lane * per_lane + job->i) / (per_lane * job->p);
}

void gk_scrypt_end (gk_scrypt_job_t *job)
{
	if (job->b != 0)
	{
		gk_wipe (job->b, (size_t) job->p * 128 * job->r);
		gk_wipe (job->xy, (2 * 32 * job->r + 16) * sizeof (u32));
		gk_wipe (job->password, job->passlen);
	}
	free (job->b);
	free (job->xy);
	free (job->password);
	gk_wipe (job, sizeof *job);
}

int gk_scrypt_selftest_step (gk_scrypt_selftest_t *st, void *work, uint32_t budget)
{
	switch (st->stage)
	{
	case 0:
		/* RFC 7914, 12: P "", S "", N 16, r 1, p 1, 64 bytes */
		if (gk_scrypt_begin (&st->job, work, 16, 1, 1, "", 0, "", 0, 64) != 0)
		{
			return -1;
		}
		st->stage = 1;
		return 1;
	case 1:
		if (gk_scrypt_step (&st->job, budget))
		{
			return 1;
		}
		if (!gk_hex_equal (st->job.out, 64, "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442"
						    "fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"))
		{
			gk_scrypt_end (&st->job);
			return -2;
		}
		gk_scrypt_end (&st->job);
		/* P "password", S "NaCl", N 1024, r 8, p 16 (1 MiB) */
		if (gk_scrypt_begin (&st->job, work, 1024, 8, 16, "password", 8, "NaCl", 4, 64) != 0)
		{
			return -3;
		}
		st->stage = 2;
		return 1;
	case 2:
		if (gk_scrypt_step (&st->job, budget))
		{
			return 1;
		}
		{
			int ok = gk_hex_equal (st->job.out, 64, "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162"
								"2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640");
			gk_scrypt_end (&st->job);
			st->stage = 3;
			return ok ? 0 : -4;
		}
	default:
		return 0;
	}
}
