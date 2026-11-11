/*
 * s2k.h - OpenPGP's string-to-key specifiers (RFC 9580, 3.7.1): simple
 * (type 0), salted (1) and iterated and salted (3), over the hashes of
 * hmac.h. What turns a passphrase into the key that protects an OpenPGP
 * secret key (or a symmetrically encrypted message).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_S2K_H
#define GK_S2K_H

#include "hmac.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GK_S2K_SIMPLE		0
#define GK_S2K_SALTED		1
#define GK_S2K_ITERATED		3

#define GK_S2K_SALT_SIZE	8

/* The number of bytes type 3 hashes for a coded count octet c:
   (16 + (c & 15)) << ((c >> 4) + 6), 1024 to 65011712. */
uint32_t gk_s2k_count (uint8_t coded);

#define GK_S2K_MAX_OUTPUT	64

/* A derivation in steps, so that a long one (type 3 hashes up to 62 MiB
   per output hash: seconds on a Pi Zero) can be spread over the main loop.
   Fields are private. */
typedef struct
{
	const gk_hash_t *hash;
	gk_hash_ctx_t ctx;
	int active;			/* ctx is a hash under way */
	uint8_t *buf;			/* whole copies of the pattern (heap) */
	size_t bufsize;
	size_t period;			/* bytes in one copy of the pattern */
	size_t pos;			/* where in a copy the next byte is */
	uint64_t total;			/* bytes each hash takes after its preload */
	uint64_t left;			/* of the hash under way */
	size_t index;			/* the hash under way: preloaded with index zeros */
	uint8_t out[GK_S2K_MAX_OUTPUT];
	size_t outlen, done;
}
gk_s2k_job_t;

/* Starts deriving outlen bytes (1 to GK_S2K_MAX_OUTPUT). salt: 8 bytes for
   types 1 and 3, ignored (may be 0) for type 0; coded_count only for type
   3. When outlen is more than one digest, more hashes run, the i-th (from
   0) preloaded with i zero bytes, and their outputs are concatenated (RFC
   9580, 3.7.1). Type 3 hashes the salt and passphrase repeated until the
   count is reached (all of them once if they are longer), from a buffer of
   whole copies of them (about 1 KiB; one copy if they are longer): never
   the whole input. The passphrase is copied: the caller's may change
   afterwards. 0: started; -2: no such type; -3: no memory; -4: outlen out
   of range. On error nothing needs ending. */
int gk_s2k_begin (gk_s2k_job_t *job, const gk_hash_t *hash, int type, const void *passphrase,
		  size_t passlen, const uint8_t *salt, uint8_t coded_count, size_t outlen);

/* Hashes about budget more bytes (whole hashes' ends included). 1: more to
   do; 0: done, job->out holds the job->outlen bytes. */
int gk_s2k_step (gk_s2k_job_t *job, size_t budget);

/* How far it is, from 0 to 1. */
double gk_s2k_progress (const gk_s2k_job_t *job);

/* Wipes the job (the result too) and frees its buffer. */
void gk_s2k_end (gk_s2k_job_t *job);

/* All at once: begin, steps, end, asking stop(arg) after every MiB
   hashed whether to give up (may be 0). 0: done; -1: stopped, out is
   zeroed; other values as gk_s2k_begin. */
int gk_s2k (const gk_hash_t *hash, int type, const void *passphrase, size_t passlen,
	    const uint8_t *salt, uint8_t coded_count, uint8_t *out, size_t outlen,
	    int (*stop) (void *), void *arg);

/* Known answers (made with an independent implementation: tools/check_pgp.py
   compares many more), small counts only: the RFC 9580 examples hash 62 MiB
   each, which takes seconds on a Pi Zero (tests/apps/pgpcrypto checks
   them). 0: OK. */
int gk_s2k_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
