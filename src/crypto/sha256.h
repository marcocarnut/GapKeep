/*
 * sha256.h - SHA-256 (FIPS 180-4).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_SHA256_H
#define ZG_SHA256_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ZG_SHA256_DIGEST_SIZE	32

typedef struct
{
	uint32_t state[8];
	uint64_t length;		/* bytes hashed so far */
	uint8_t block[64];
	size_t fill;			/* bytes in block */
}
zg_sha256_t;

void zg_sha256_init (zg_sha256_t *ctx);
void zg_sha256_update (zg_sha256_t *ctx, const void *data, size_t len);
void zg_sha256_final (zg_sha256_t *ctx, uint8_t digest[ZG_SHA256_DIGEST_SIZE]);

void zg_sha256 (const void *data, size_t len, uint8_t digest[ZG_SHA256_DIGEST_SIZE]);

/* Checks the implementation against FIPS 180-4 test vectors. 0: OK. */
int zg_sha256_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
