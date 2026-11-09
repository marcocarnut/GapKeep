/*
 * sha512.h - SHA-512 (FIPS 180-4).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SHA512_H
#define GK_SHA512_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_SHA512_DIGEST_SIZE	64
#define GK_SHA512_BLOCK_SIZE	128

typedef struct
{
	uint64_t state[8];
	uint64_t length;		/* bytes hashed so far (FIPS allows 2^128 bits;
					   2^64 bytes is plenty) */
	uint8_t block[128];
	size_t fill;			/* bytes in block */
}
gk_sha512_t;

void gk_sha512_init (gk_sha512_t *ctx);
void gk_sha512_update (gk_sha512_t *ctx, const void *data, size_t len);
void gk_sha512_final (gk_sha512_t *ctx, uint8_t digest[GK_SHA512_DIGEST_SIZE]);

void gk_sha512 (const void *data, size_t len, uint8_t digest[GK_SHA512_DIGEST_SIZE]);

/* Checks the implementation against FIPS 180-4 test vectors. 0: OK. */
int gk_sha512_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
