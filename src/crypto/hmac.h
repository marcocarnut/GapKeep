/*
 * hmac.h - HMAC (RFC 2104, FIPS 198-1) over SHA-1, SHA-256 and SHA-512,
 * and the hashes behind one interface (zg_hash_t), for zg:crypto and for
 * what will be built on them (PBKDF2, BIP-32, ...).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_HMAC_H
#define ZG_HMAC_H

#include "sha1.h"
#include "sha256.h"
#include "sha512.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ZG_HASH_MAX_DIGEST	64
#define ZG_HASH_MAX_BLOCK	128

typedef union
{
	zg_sha1_t sha1;
	zg_sha256_t sha256;
	zg_sha512_t sha512;
}
zg_hash_ctx_t;

typedef struct
{
	const char *name;		/* as WebCrypto's: "SHA-1", "SHA-256", "SHA-512" */
	size_t digest_size;
	size_t block_size;
	void (*init) (zg_hash_ctx_t *ctx);
	void (*update) (zg_hash_ctx_t *ctx, const void *data, size_t len);
	void (*final) (zg_hash_ctx_t *ctx, uint8_t *digest);	/* wipes ctx */
}
zg_hash_t;

extern const zg_hash_t zg_hash_sha1, zg_hash_sha256, zg_hash_sha512;

/* By name, as WebCrypto's ("SHA-256"); 0 if unknown. */
const zg_hash_t *zg_hash_find (const char *name);

typedef struct
{
	const zg_hash_t *hash;
	zg_hash_ctx_t inner, outer;	/* after the padded key's block */
}
zg_hmac_t;

/* Any key length (longer than a block: hashed first, RFC 2104). */
void zg_hmac_init (zg_hmac_t *ctx, const zg_hash_t *hash, const void *key, size_t keylen);
void zg_hmac_update (zg_hmac_t *ctx, const void *data, size_t len);
/* digest: hash->digest_size bytes. Wipes ctx. */
void zg_hmac_final (zg_hmac_t *ctx, uint8_t *digest);

void zg_hmac (const zg_hash_t *hash, const void *key, size_t keylen,
	      const void *data, size_t len, uint8_t *digest);

/* RFC 2202 (SHA-1) and RFC 4231 (SHA-256, SHA-512) test cases: they hash
   one to three blocks with each hash. Quick (about 60 compressions); the
   hashes' own self-tests (zg_sha*_selftest) hash a million bytes each.
   0: OK. */
int zg_hmac_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
