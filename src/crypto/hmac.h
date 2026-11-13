/*
 * hmac.h - HMAC (RFC 2104, FIPS 198-1) over SHA-1, SHA-224, SHA-256,
 * SHA-384 and SHA-512, and the hashes behind one interface (gk_hash_t),
 * for gk:crypto and for what is built on them (PBKDF2, S2K, BIP-32, ...).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_HMAC_H
#define GK_HMAC_H

#include "sha1.h"
#include "sha256.h"
#include "sha512.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GK_HASH_MAX_DIGEST	64
#define GK_HASH_MAX_BLOCK	128

typedef union
{
	gk_sha1_t sha1;
	gk_sha256_t sha256;
	gk_sha512_t sha512;
}
gk_hash_ctx_t;

typedef struct
{
	const char *name;		/* as WebCrypto's: "SHA-1", "SHA-256", "SHA-384", ... */
	size_t digest_size;
	size_t block_size;
	void (*init) (gk_hash_ctx_t *ctx);
	void (*update) (gk_hash_ctx_t *ctx, const void *data, size_t len);
	void (*final) (gk_hash_ctx_t *ctx, uint8_t *digest);	/* wipes ctx */
}
gk_hash_t;

extern const gk_hash_t gk_hash_sha1, gk_hash_sha224, gk_hash_sha256, gk_hash_sha384, gk_hash_sha512;

/* By name, as WebCrypto's ("SHA-256"); 0 if unknown. */
const gk_hash_t *gk_hash_find (const char *name);

typedef struct
{
	const gk_hash_t *hash;
	gk_hash_ctx_t inner, outer;	/* after the padded key's block */
}
gk_hmac_t;

/* Any key length (longer than a block: hashed first, RFC 2104). */
void gk_hmac_init (gk_hmac_t *ctx, const gk_hash_t *hash, const void *key, size_t keylen);
void gk_hmac_update (gk_hmac_t *ctx, const void *data, size_t len);
/* digest: hash->digest_size bytes. Wipes ctx. */
void gk_hmac_final (gk_hmac_t *ctx, uint8_t *digest);

void gk_hmac (const gk_hash_t *hash, const void *key, size_t keylen,
	      const void *data, size_t len, uint8_t *digest);

/* HKDF (RFC 5869): extract, then expand to len bytes (at most 255
   digests). salt may be 0 (zeros). */
void gk_hkdf (const gk_hash_t *hash, const void *salt, size_t saltlen, const void *ikm, size_t ikmlen,
	      const void *info, size_t infolen, uint8_t *out, size_t len);

/* RFC 2202 (SHA-1) and RFC 4231 (SHA-224, SHA-256, SHA-384, SHA-512) test
   cases: they hash one to three blocks with each hash; RFC 5869's first
   HKDF case. Quick (about 60 compressions); the
   hashes' own self-tests (gk_sha*_selftest) hash a million bytes each.
   0: OK. */
int gk_hmac_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
