/*
 * inflate.c - DEFLATE decompression in steps, on zlib (see inflate.h).
 *
 * The output goes into blocks of BLOCK bytes, allocated as it grows (never
 * copied while growing: a copy of megabytes would be one long step); at
 * the end the blocks are copied into one buffer, a block per step, each
 * wiped and freed once copied (or, after a failure, just wiped and freed,
 * a block per step).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "inflate.h"
#include "../crypto/wipe.h"
#include <zlib.h>
#include <stdlib.h>
#include <string.h>

#define BLOCK		(256 * 1024)
#define HEAD		16		/* before the output buffer: its length */

enum { INFLATING, ASSEMBLING, WIPING, DONE };

/* zlib's memory from the heap, wiped when freed (Circle's heap zeroes
   freed blocks too; the simulator's doesn't): the window holds output */
static voidpf zalloc (voidpf opaque, uInt items, uInt size)
{
	(void) opaque;
	size_t n = (size_t) items * size;
	uint8_t *p = calloc (1, HEAD + n);
	if (p == 0)
	{
		return Z_NULL;
	}
	memcpy (p, &n, sizeof n);
	return p + HEAD;
}

static void zfree (voidpf opaque, voidpf p)
{
	(void) opaque;
	if (p != Z_NULL)
	{
		gk_inflate_free_output (p);
	}
}

void gk_inflate_free_output (void *p)
{
	if (p != 0)
	{
		uint8_t *h = (uint8_t *) p - HEAD;
		size_t n;
		memcpy (&n, h, sizeof n);
		gk_wipe (p, n);
		free (h);
	}
}

int gk_inflate_begin (gk_inflate_job_t *job, int format, const uint8_t *data, size_t len, size_t max)
{
	memset (job, 0, sizeof *job);
	z_stream *z = calloc (1, sizeof *z);
	job->in = malloc (len ? len : 1);
	size_t nblocks = (max + 1 + BLOCK - 1) / BLOCK;
	job->blocks = calloc (nblocks, sizeof *job->blocks);
	if (z == 0 || job->in == 0 || job->blocks == 0)
	{
		free (z);
		free (job->in);
		free (job->blocks);
		memset (job, 0, sizeof *job);
		return GK_INFLATE_NO_MEMORY;
	}
	memcpy (job->in, data, len);
	job->inlen = len;
	job->max = max;
	job->maxblocks = nblocks;
	z->zalloc = zalloc;
	z->zfree = zfree;
	z->next_in = job->in;
	z->avail_in = (uInt) len;
	if (inflateInit2 (z, format == GK_INFLATE_RAW ? -15 : 15) != Z_OK)
	{
		free (z);
		free (job->in);
		free (job->blocks);
		memset (job, 0, sizeof *job);
		return GK_INFLATE_NO_MEMORY;
	}
	job->z = z;
	return 0;
}

/* the end of inflating: assemble the output, or wipe it */
static void finish (gk_inflate_job_t *job, int result)
{
	job->result = result;
	job->phase = WIPING;
	if (result == 0)
	{
		uint8_t *h = malloc (HEAD + job->outlen);
		if (h == 0)
		{
			job->result = GK_INFLATE_NO_MEMORY;
		}
		else
		{
			memcpy (h, &job->outlen, sizeof job->outlen);
			job->out = h + HEAD;
			job->phase = ASSEMBLING;
		}
	}
	job->next = 0;
	/* the input and zlib's state are not needed any more */
	inflateEnd ((z_stream *) job->z);
	free (job->z);
	job->z = 0;
	gk_wipe (job->in, job->inlen);
	free (job->in);
	job->in = 0;
}

static void inflating (gk_inflate_job_t *job, size_t budget)
{
	z_stream *z = (z_stream *) job->z;
	while (job->phase == INFLATING && budget > 0)
	{
		size_t at = job->outlen % BLOCK, b = job->outlen / BLOCK;
		if (job->outlen > job->max)
		{
			finish (job, GK_INFLATE_TOO_BIG);	/* one byte past the limit */
			break;
		}
		if (at == 0 && b == job->nblocks)
		{
			job->blocks[b] = malloc (BLOCK);
			if (job->blocks[b] == 0)
			{
				finish (job, GK_INFLATE_NO_MEMORY);
				break;
			}
			job->nblocks++;
		}
		/* room in the block, the budget, and one byte past the limit */
		size_t room = BLOCK - at;
		if (room > budget) room = budget;
		if (room > job->max + 1 - job->outlen) room = job->max + 1 - job->outlen;
		z->next_out = job->blocks[b] + at;
		z->avail_out = (uInt) room;
		int r = inflate (z, Z_NO_FLUSH);
		size_t made = room - z->avail_out;
		job->outlen += made;
		budget = budget > made ? budget - made : 0;
		if (job->outlen > job->max)
		{
			finish (job, GK_INFLATE_TOO_BIG);
		}
		else if (r == Z_STREAM_END)
		{
			finish (job, z->avail_in == 0 ? 0 : GK_INFLATE_BAD);	/* nothing after it */
		}
		else if (r == Z_MEM_ERROR)
		{
			finish (job, GK_INFLATE_NO_MEMORY);
		}
		else if (r != Z_OK && !(r == Z_BUF_ERROR && z->avail_out == 0))
		{
			finish (job, GK_INFLATE_BAD);		/* bad data, or the input ended first */
		}
		else if (made == 0 && z->avail_out != 0)
		{
			finish (job, GK_INFLATE_BAD);		/* no progress: cut short */
		}
	}
}

int gk_inflate_step (gk_inflate_job_t *job, size_t budget)
{
	if (job->phase == INFLATING)
	{
		inflating (job, budget);
		return 1;
	}
	/* a block (copied, if assembling), wiped and freed, per BLOCK of budget */
	do
	{
		if (job->next >= job->nblocks)
		{
			job->phase = DONE;
			return 0;
		}
		size_t b = job->next++;
		size_t n = b * (size_t) BLOCK + BLOCK <= job->outlen ? BLOCK
			   : job->outlen > b * (size_t) BLOCK ? job->outlen - b * (size_t) BLOCK : 0;
		if (job->phase == ASSEMBLING)
		{
			memcpy (job->out + b * (size_t) BLOCK, job->blocks[b], n);
		}
		gk_wipe (job->blocks[b], BLOCK);
		free (job->blocks[b]);
		job->blocks[b] = 0;
		budget = budget > BLOCK ? budget - BLOCK : 0;
	}
	while (budget > 0);
	return 1;
}

double gk_inflate_progress (const gk_inflate_job_t *job)
{
	const z_stream *z = (const z_stream *) job->z;
	if (job->phase != INFLATING)
	{
		return job->nblocks ? 0.9 + 0.1 * (double) job->next / (double) job->nblocks : 1;
	}
	return job->inlen > 0 && z != 0 ? 0.9 * (double) (job->inlen - z->avail_in) / (double) job->inlen : 0;
}

int gk_inflate_result (gk_inflate_job_t *job, uint8_t **out, size_t *outlen)
{
	*out = 0;
	*outlen = 0;
	if (job->phase != DONE)
	{
		return GK_INFLATE_BAD;
	}
	if (job->result == 0)
	{
		*out = job->out;		/* the caller's now: gk_inflate_free_output */
		*outlen = job->outlen;
		job->out = 0;
	}
	return job->result;
}

void gk_inflate_end (gk_inflate_job_t *job)
{
	if (job->z != 0)
	{
		inflateEnd ((z_stream *) job->z);
		free (job->z);
	}
	if (job->in != 0)
	{
		gk_wipe (job->in, job->inlen);
		free (job->in);
	}
	for (size_t b = 0; job->blocks != 0 && b < job->nblocks; b++)
	{
		if (job->blocks[b] != 0)
		{
			gk_wipe (job->blocks[b], BLOCK);
			free (job->blocks[b]);
		}
	}
	free (job->blocks);
	gk_inflate_free_output (job->out);
	memset (job, 0, sizeof *job);
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

/* 0, or the error, and the length out */
static int run (int format, const uint8_t *in, size_t len, size_t max, size_t budget, size_t *outlen, int *ok)
{
	gk_inflate_job_t job;
	if (gk_inflate_begin (&job, format, in, len, max) != 0)
	{
		return GK_INFLATE_NO_MEMORY;
	}
	while (gk_inflate_step (&job, budget))
	{
	}
	uint8_t *out;
	int result = gk_inflate_result (&job, &out, outlen);
	*ok = 1;
	for (size_t i = 0; result == 0 && i < *outlen; i++)
	{
		*ok &= out[i] == (uint8_t) "GapKeep inflate test, "[i % 22];
	}
	gk_inflate_free_output (out);
	gk_inflate_end (&job);
	return result;
}

int gk_inflate_selftest (void)
{
	/* "GapKeep inflate test, " 20 times (440 bytes), made with Python's zlib */
	uint8_t z[64], r[64];
	size_t zlen = unhex ("78da734f2cf04e4d2d50c8cc4bcb492c495528492d2ed151701f151de4a20088fa9bf1", z);
	size_t rlen = unhex ("734f2cf04e4d2d50c8cc4bcb492c495528492d2ed151701f151de4a200", r);
	size_t outlen;
	int ok;

	if (run (GK_INFLATE_ZLIB, z, zlen, 440, 1000, &outlen, &ok) != 0 || outlen != 440 || !ok) return 1;
	if (run (GK_INFLATE_RAW, r, rlen, 1000, 7, &outlen, &ok) != 0 || outlen != 440 || !ok) return 2;
	if (run (GK_INFLATE_ZLIB, z, zlen, 439, 1000, &outlen, &ok) != GK_INFLATE_TOO_BIG) return 3;
	if (run (GK_INFLATE_ZLIB, z, zlen - 1, 1000, 1000, &outlen, &ok) != GK_INFLATE_BAD) return 4;	/* cut */
	if (run (GK_INFLATE_RAW, z, zlen, 1000, 1000, &outlen, &ok) != GK_INFLATE_BAD) return 5;	/* other format */
	z[zlen - 1] ^= 1;
	if (run (GK_INFLATE_ZLIB, z, zlen, 1000, 1000, &outlen, &ok) != GK_INFLATE_BAD) return 6;	/* Adler-32 */
	r[rlen] = 0;
	if (run (GK_INFLATE_RAW, r, rlen + 1, 1000, 1000, &outlen, &ok) != GK_INFLATE_BAD) return 7;	/* data after */
	return 0;
}
