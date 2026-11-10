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

/* RFC 6070 (SHA-1) and other vectors, and BIP-39's first test vector
   (2048 iterations of SHA-512); full: also those with 4096 iterations of
   SHA-1. 0: OK. */
int gk_pbkdf2_selftest (int full);

#ifdef __cplusplus
}
#endif

#endif
