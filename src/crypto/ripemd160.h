/*
 * ripemd160.h - RIPEMD-160 (Dobbertin, Bosselaers, Preneel, 1996).
 *
 * For Bitcoin's HASH160 (RIPEMD-160 of SHA-256): addresses, BIP-32 key
 * identifiers and fingerprints.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_RIPEMD160_H
#define GK_RIPEMD160_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_RIPEMD160_DIGEST_SIZE	20
#define GK_RIPEMD160_BLOCK_SIZE		64

typedef struct
{
	uint32_t state[5];
	uint64_t length;		/* bytes hashed so far */
	uint8_t block[64];
	size_t fill;			/* bytes in block */
}
gk_ripemd160_t;

void gk_ripemd160_init (gk_ripemd160_t *ctx);
void gk_ripemd160_update (gk_ripemd160_t *ctx, const void *data, size_t len);
void gk_ripemd160_final (gk_ripemd160_t *ctx, uint8_t digest[GK_RIPEMD160_DIGEST_SIZE]);	/* wipes ctx */

void gk_ripemd160 (const void *data, size_t len, uint8_t digest[GK_RIPEMD160_DIGEST_SIZE]);

/* RIPEMD-160(SHA-256(data)) */
void gk_hash160 (const void *data, size_t len, uint8_t digest[GK_RIPEMD160_DIGEST_SIZE]);

/* The authors' test vectors; full: also a million 'a' (about 15600
   compressions). 0: OK. */
int gk_ripemd160_selftest (int full);

#ifdef __cplusplus
}
#endif

#endif
