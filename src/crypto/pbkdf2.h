/*
 * pbkdf2.h - PBKDF2 (RFC 8018, 5.2) with HMAC over the hashes of hmac.h.
 *
 * BIP-39 turns a mnemonic into a seed with PBKDF2-HMAC-SHA512, 2048
 * iterations.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_PBKDF2_H
#define GK_PBKDF2_H

#include "hmac.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Writes outlen bytes to out (outlen > 0; at most (2^32-1) blocks, far
   beyond any use here). iterations >= 1. */
void gk_pbkdf2 (const gk_hash_t *hash, const void *password, size_t passlen,
		const void *salt, size_t saltlen, uint32_t iterations,
		uint8_t *out, size_t outlen);

/* The same, asking stop(arg) every 256 iterations whether to give up (the
   app host's watchdog and Home key: a large iteration count takes minutes
   on a Pi Zero). 0: done; -1: stopped, out is zeroed. stop may be 0. */
int gk_pbkdf2_stoppable (const gk_hash_t *hash, const void *password, size_t passlen,
			 const void *salt, size_t saltlen, uint32_t iterations,
			 uint8_t *out, size_t outlen, int (*stop) (void *), void *arg);

/* The same in steps, for long derivations spread over the main loop.
   Fields are private. */
typedef struct
{
	const gk_hash_t *hash;
	gk_hmac_t keyed, mac;
	uint8_t u[GK_HASH_MAX_DIGEST], t[GK_HASH_MAX_DIGEST];
	uint8_t *salt;			/* a copy (heap) */
	size_t saltlen;
	uint32_t iterations;
	uint32_t block;			/* the block under way, from 1 */
	uint32_t j;			/* its iterations done; 0: not started */
	uint8_t *out;			/* outlen bytes (heap) */
	size_t outlen, done;
}
gk_pbkdf2_job_t;

/* Starts; the password and salt are used (salt copied) here. outlen > 0,
   iterations >= 1. 0: started; -3: no memory (nothing to end). */
int gk_pbkdf2_begin (gk_pbkdf2_job_t *job, const gk_hash_t *hash, const void *password, size_t passlen,
		     const void *salt, size_t saltlen, uint32_t iterations, size_t outlen);

/* About budget more iterations. 1: more to do; 0: done, job->out holds
   job->outlen bytes. */
int gk_pbkdf2_step (gk_pbkdf2_job_t *job, uint32_t budget);

double gk_pbkdf2_progress (const gk_pbkdf2_job_t *job);

/* Wipes the job, the result too, and frees its buffers. */
void gk_pbkdf2_end (gk_pbkdf2_job_t *job);

/* RFC 6070 (SHA-1) and other vectors, and BIP-39's first test vector
   (2048 iterations of SHA-512); full: also those with 4096 iterations of
   SHA-1. 0: OK. */
int gk_pbkdf2_selftest (int full);

#ifdef __cplusplus
}
#endif

#endif
