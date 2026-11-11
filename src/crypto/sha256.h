/*
 * sha256.h - SHA-256 and SHA-224 (FIPS 180-4).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SHA256_H
#define GK_SHA256_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_SHA256_DIGEST_SIZE	32
#define GK_SHA224_DIGEST_SIZE	28

typedef struct
{
	uint32_t state[8];
	uint64_t length;		/* bytes hashed so far */
	uint8_t block[64];
	size_t fill;			/* bytes in block */
}
gk_sha256_t;

void gk_sha256_init (gk_sha256_t *ctx);
void gk_sha256_update (gk_sha256_t *ctx, const void *data, size_t len);
void gk_sha256_final (gk_sha256_t *ctx, uint8_t digest[GK_SHA256_DIGEST_SIZE]);

void gk_sha256 (const void *data, size_t len, uint8_t digest[GK_SHA256_DIGEST_SIZE]);

/* SHA-224: the same context and gk_sha256_update; its own start and end. */
void gk_sha224_init (gk_sha256_t *ctx);
void gk_sha224_final (gk_sha256_t *ctx, uint8_t digest[GK_SHA224_DIGEST_SIZE]);

/* Checks the implementation against FIPS 180-4 test vectors (SHA-224's
   too). 0: OK. */
int gk_sha256_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
