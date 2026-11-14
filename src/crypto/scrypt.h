/*
 * scrypt.h - scrypt (RFC 7914) in steps, for gk:crypto's scrypt.
 *
 * The same computation as RFC 7914's (PBKDF2-HMAC-SHA256 with one
 * iteration, scryptROMix over each of the p blocks one after the other,
 * PBKDF2 again), its loops turned into a state that a step advances by a
 * number of BlockMix calls, so that a big memory can be filled across the
 * main loop. The work area (V, 128 * r * N bytes) is the caller's.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SCRYPT_H
#define GK_SCRYPT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_SCRYPT_MAX_OUT	64
#define GK_SCRYPT_MAX_RP	256		/* r * p: B is at most 32 KiB */

/* Fields are private. */
typedef struct
{
	uint32_t *v;			/* the caller's work area */
	uint8_t *b;			/* B: p * 128 r bytes (heap) */
	uint32_t *xy;			/* X and Y: 2 * 32 r words (heap) */
	uint8_t *password;		/* a copy (heap), for the last PBKDF2 */
	size_t passlen;
	uint32_t n, r, p;
	uint32_t lane, i;		/* the next BlockMix: lane, 0 to 2N-1 */
	int phase;
	size_t vwords, wiped;		/* the work area, in 32-bit words */
	uint32_t outlen;
	uint8_t out[GK_SCRYPT_MAX_OUT];
}
gk_scrypt_job_t;

/* The bytes of work area that N and r need: 128 * r * N (0 if that is
   more than a size_t holds). */
size_t gk_scrypt_memory (uint32_t n, uint32_t r);

/* Starts: the first PBKDF2 is computed and the password copied here, so
   the caller's may change afterwards. N a power of two, at least 2, below
   2^(16 r) (RFC 7914, 6); r, p >= 1, r * p <= GK_SCRYPT_MAX_RP; outlen 1 to
   GK_SCRYPT_MAX_OUT; work: at least gk_scrypt_memory (n, r) bytes,
   4-byte aligned. 0: started; -3: no memory (nothing to end); -4: a
   parameter out of range (nothing to end). */
int gk_scrypt_begin (gk_scrypt_job_t *job, void *work, uint32_t n, uint32_t r, uint32_t p,
		     const void *password, size_t passlen, const void *salt, size_t saltlen, uint32_t outlen);

/* About budget more BlockMix calls (each 2r Salsa20/8 cores), or, at the
   end, wipes a part of the work area. 1: more to do; 0: done, job->out
   holds job->outlen bytes, the work area is wiped. */
int gk_scrypt_step (gk_scrypt_job_t *job, uint32_t budget);

double gk_scrypt_progress (const gk_scrypt_job_t *job);

/* Wipes the job and frees its buffers (not the work area: the caller's). */
void gk_scrypt_end (gk_scrypt_job_t *job);

/* Stops: the steps that follow only wipe the work area (then the job is
   done, its output zeros). */
void gk_scrypt_abort (gk_scrypt_job_t *job);

/* RFC 7914, 12: its first two vectors (N = 16, r = 1, p = 1; N = 1024,
   r = 8, p = 16), run in steps of budget BlockMix calls: the caller gives
   the work area (at least GK_SCRYPT_SELFTEST_BYTES). Call until it returns
   0 (passed) or < 0 (failed); 1: more. state: zeroed before the first
   call; gk_scrypt_end (&st->job) if given up half-way. */
#define GK_SCRYPT_SELFTEST_BYTES	(128 * 8 * 1024)
typedef struct { int stage; gk_scrypt_job_t job; } gk_scrypt_selftest_t;
int gk_scrypt_selftest_step (gk_scrypt_selftest_t *st, void *work, uint32_t budget);

#ifdef __cplusplus
}
#endif

#endif
