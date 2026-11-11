/*
 * inflate.h - DEFLATE decompression (RFC 1951; zlib's format, RFC 1950,
 * too) on zlib's inflate (third_party/zlib), in steps, with a limit on
 * the output checked as it grows: for gk:zlib, and OpenPGP's compressed
 * data packets (ZIP: raw DEFLATE; ZLIB). What it decompresses may be a
 * decrypted message: wiped when done.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_INFLATE_H
#define GK_INFLATE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_INFLATE_RAW		0	/* RFC 1951 (OpenPGP's ZIP, 1) */
#define GK_INFLATE_ZLIB		1	/* RFC 1950 (OpenPGP's ZLIB, 2) */

#define GK_INFLATE_BAD		-1	/* not such a stream, cut short, or data after it */
#define GK_INFLATE_NO_MEMORY	-3
#define GK_INFLATE_TOO_BIG	-6	/* more than max bytes out */

/* Fields are private. */
typedef struct
{
	void *z;			/* z_stream (heap) */
	uint8_t *in;			/* a copy of the input (heap) */
	size_t inlen;
	uint8_t **blocks;		/* the output as it grows (heap) */
	size_t nblocks, maxblocks, next;
	uint8_t *out;			/* the output in one piece, at the end */
	size_t outlen, max;
	int phase, result;
}
gk_inflate_job_t;

/* Starts: data copied; at most max bytes out (max >= 1). 0, or
   GK_INFLATE_NO_MEMORY (nothing to end). */
int gk_inflate_begin (gk_inflate_job_t *job, int format, const uint8_t *data, size_t len, size_t max);

/* About budget more bytes out (or, at the end, handled: a block of the
   output copied into one piece, wiped and freed). 1: more to do; 0: done
   (result below). */
int gk_inflate_step (gk_inflate_job_t *job, size_t budget);

double gk_inflate_progress (const gk_inflate_job_t *job);

/* Once done: 0 and the output, which is the caller's from then on, to
   free with gk_inflate_free_output; or one of the errors. */
int gk_inflate_result (gk_inflate_job_t *job, uint8_t **out, size_t *outlen);

/* Wipes and frees an output (0: nothing). */
void gk_inflate_free_output (void *out);

void gk_inflate_end (gk_inflate_job_t *job);	/* wipes and frees */

/* Known answers for both formats, and broken, cut and too big streams.
   0: OK. */
int gk_inflate_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
