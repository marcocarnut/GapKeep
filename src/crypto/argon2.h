/*
 * argon2.h - Argon2id (RFC 9106, version 1.3) in steps, for OpenPGP's S2K
 * type 4 (RFC 9580, 3.7.1.4) and gk:crypto's argon2id.
 *
 * Restructured from Monocypher 4.0.3's crypto_argon2 (third_party/
 * monocypher, CC0 or BSD-2-Clause; its BLAKE2b): the same computation,
 * its loops (passes, slices, lanes, blocks: RFC 9106's order, the lanes of
 * a slice one after the other) turned into a state that a step advances
 * by a number of blocks, so that a big memory can be filled across the
 * main loop. The work area is the caller's (1 KiB per block).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_ARGON2_H
#define GK_ARGON2_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_ARGON2_BLOCK		1024
#define GK_ARGON2_MAX_OUT	1024

typedef struct { uint64_t a[128]; } gk_argon2_block_t;

/* Fields are private. */
typedef struct
{
	gk_argon2_block_t *blocks;
	uint32_t nb_blocks, lane_size, segment_size, lanes, passes;
	uint32_t pass, slice, lane, block;	/* the next block to fill */
	gk_argon2_block_t index_block;
	uint32_t index_ctr;
	int constant_time;
	int phase;
	size_t wiped;				/* blocks wiped at the end */
	uint32_t outlen;
	uint8_t out[GK_ARGON2_MAX_OUT];
}
gk_argon2_job_t;

/* The blocks a memory size m (KiB) needs: m rounded down to a multiple of
   4 * lanes (RFC 9106, 3.2). */
uint32_t gk_argon2_blocks (uint32_t memory_kib, uint32_t lanes);

/* Starts: the inputs are hashed here (H0, RFC 9106, 3.2), so the caller's
   may change afterwards. passes >= 1, lanes 1 to 2^24-1, memory_kib >=
   8 * lanes, outlen 4 to GK_ARGON2_MAX_OUT; work: at least
   gk_argon2_blocks (memory_kib, lanes) blocks. key and ad may be 0 (no
   secret, no associated data). 0: started; -4: a parameter out of range. */
int gk_argon2_begin (gk_argon2_job_t *job, void *work, uint32_t passes, uint32_t lanes, uint32_t memory_kib,
		     const void *password, size_t passlen, const void *salt, size_t saltlen,
		     const void *key, size_t keylen, const void *ad, size_t adlen, uint32_t outlen);

/* Fills about budget more blocks (or, at the end, wipes about budget
   blocks of the work area). 1: more to do; 0: done, job->out holds
   job->outlen bytes, the work area is wiped. */
int gk_argon2_step (gk_argon2_job_t *job, uint32_t budget);

double gk_argon2_progress (const gk_argon2_job_t *job);

/* Wipes the job (not the work area: the caller's). */
void gk_argon2_end (gk_argon2_job_t *job);

/* RFC 9106, 5.3 (Argon2id: 32 KiB, 3 passes, 4 lanes, a secret and
   associated data) and an S2K type 4 known answer (RFC 9580, 3.7.1.4),
   both in small steps, run in steps of budget blocks: the caller gives
   the work area (at least GK_ARGON2_SELFTEST_BLOCKS blocks). Call until
   it returns 0 (passed) or < 0 (failed); 1: more. state: zeroed before
   the first call. */
#define GK_ARGON2_SELFTEST_BLOCKS	64
typedef struct { int stage; gk_argon2_job_t job; } gk_argon2_selftest_t;
int gk_argon2_selftest_step (gk_argon2_selftest_t *st, void *work, uint32_t budget);

#ifdef __cplusplus
}
#endif

#endif
