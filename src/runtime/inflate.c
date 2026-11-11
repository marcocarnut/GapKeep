/*
 * inflate.c - DEFLATE decompression in steps, on zlib (see inflate.h).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "inflate.h"
#include "../crypto/wipe.h"
#include <zlib.h>
#include <stdlib.h>
#include <string.h>

#define FIRST_CAP	(64 * 1024)

/* zlib's memory from the heap, zeroed when freed (Circle's heap zeroes
   freed blocks too; the simulator's doesn't): the window holds output */
struct alloc_head { size_t size; size_t pad; };

static voidpf zalloc (voidpf opaque, uInt items, uInt size)
{
	(void) opaque;
	size_t n = (size_t) items * size;
	struct alloc_head *h = calloc (1, sizeof *h + n);
	if (h == 0)
	{
		return Z_NULL;
	}
	h->size = n;
	return h + 1;
}

static void zfree (voidpf opaque, voidpf p)
{
	(void) opaque;
	if (p != Z_NULL)
	{
		struct alloc_head *h = (struct alloc_head *) p - 1;
		gk_wipe (p, h->size);
		free (h);
	}
}

int gk_inflate_begin (gk_inflate_job_t *job, int format, const uint8_t *data, size_t len, size_t max)
{
	memset (job, 0, sizeof *job);
	z_stream *z = calloc (1, sizeof *z);
	job->in = malloc (len ? len : 1);
	job->cap = max < FIRST_CAP ? max : FIRST_CAP;
	job->out = malloc (job->cap ? job->cap : 1);
	if (z == 0 || job->in == 0 || job->out == 0)
	{
		free (z);
		free (job->in);
		free (job->out);
		memset (job, 0, sizeof *job);
		return GK_INFLATE_NO_MEMORY;
	}
	memcpy (job->in, data, len);
	job->inlen = len;
	job->max = max;
	z->zalloc = zalloc;
	z->zfree = zfree;
	z->next_in = job->in;
	z->avail_in = (uInt) len;
	if (inflateInit2 (z, format == GK_INFLATE_RAW ? -15 : 15) != Z_OK)
	{
		free (z);
		free (job->in);
		free (job->out);
		memset (job, 0, sizeof *job);
		return GK_INFLATE_NO_MEMORY;
	}
	job->z = z;
	return 0;
}

static void finish (gk_inflate_job_t *job, int result)
{
	job->done = 1;
	job->result = result;
}

int gk_inflate_step (gk_inflate_job_t *job, size_t budget)
{
	z_stream *z = (z_stream *) job->z;
	while (!job->done && budget > 0)
	{
		if (job->outlen == job->cap)
		{
			/* more room, up to the limit (one byte past it, to tell
			   a stream that ends exactly at it from a longer one) */
			if (job->cap >= job->max + 1)
			{
				finish (job, GK_INFLATE_TOO_BIG);
				break;
			}
			size_t cap = job->cap * 2 < job->max + 1 ? job->cap * 2 : job->max + 1;
			uint8_t *out = malloc (cap);
			if (out == 0)
			{
				finish (job, GK_INFLATE_NO_MEMORY);
				break;
			}
			memcpy (out, job->out, job->outlen);
			gk_wipe (job->out, job->cap);
			free (job->out);
			job->out = out;
			job->cap = cap;
		}
		size_t room = job->cap - job->outlen;
		if (room > budget) room = budget;
		z->next_out = job->out + job->outlen;
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
			/* the stream must be all there is */
			finish (job, z->avail_in == 0 ? 0 : GK_INFLATE_BAD);
		}
		else if (r == Z_MEM_ERROR)
		{
			finish (job, GK_INFLATE_NO_MEMORY);
		}
		else if (r != Z_OK && !(r == Z_BUF_ERROR && z->avail_out == 0))
		{
			finish (job, GK_INFLATE_BAD);	/* bad data, or the input ended first */
		}
		else if (made == 0 && z->avail_out != 0)
		{
			finish (job, GK_INFLATE_BAD);	/* no progress: cut short */
		}
	}
	return !job->done;
}

double gk_inflate_progress (const gk_inflate_job_t *job)
{
	const z_stream *z = (const z_stream *) job->z;
	return job->inlen > 0 && z != 0 ? (double) (job->inlen - z->avail_in) / (double) job->inlen : 0;
}

int gk_inflate_result (gk_inflate_job_t *job, const uint8_t **out, size_t *outlen)
{
	*out = 0;
	*outlen = 0;
	if (!job->done)
	{
		return GK_INFLATE_BAD;
	}
	if (job->result == 0)
	{
		*out = job->out;
		*outlen = job->outlen;
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
	if (job->out != 0)
	{
		gk_wipe (job->out, job->cap);
		free (job->out);
	}
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
	const uint8_t *out;
	int result = gk_inflate_result (&job, &out, outlen);
	*ok = 1;
	for (size_t i = 0; result == 0 && i < *outlen; i++)
	{
		*ok &= out[i] == (uint8_t) "GapKeep inflate test, "[i % 22];
	}
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
