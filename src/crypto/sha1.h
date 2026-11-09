/*
 * sha1.h - SHA-1 (FIPS 180-4).
 *
 * Broken for collisions: here for HMAC-SHA1 (TOTP, RFC 6238) and other
 * protocols that still require it, which HMAC's use doesn't weaken. Don't
 * use it to identify data.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SHA1_H
#define GK_SHA1_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_SHA1_DIGEST_SIZE	20
#define GK_SHA1_BLOCK_SIZE	64

typedef struct
{
	uint32_t state[5];
	uint64_t length;		/* bytes hashed so far */
	uint8_t block[64];
	size_t fill;			/* bytes in block */
}
gk_sha1_t;

void gk_sha1_init (gk_sha1_t *ctx);
void gk_sha1_update (gk_sha1_t *ctx, const void *data, size_t len);
void gk_sha1_final (gk_sha1_t *ctx, uint8_t digest[GK_SHA1_DIGEST_SIZE]);

void gk_sha1 (const void *data, size_t len, uint8_t digest[GK_SHA1_DIGEST_SIZE]);

/* Checks the implementation against FIPS 180-4 test vectors. 0: OK. */
int gk_sha1_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
