/*
 * hmac.c - HMAC (RFC 2104), written from the RFC.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "hmac.h"
#include "wipe.h"
#include "hexcheck.h"
#include <string.h>

static void sha1_init (gk_hash_ctx_t *c) { gk_sha1_init (&c->sha1); }
static void sha1_update (gk_hash_ctx_t *c, const void *p, size_t n) { gk_sha1_update (&c->sha1, p, n); }
static void sha1_final (gk_hash_ctx_t *c, uint8_t *d) { gk_sha1_final (&c->sha1, d); }
static void sha256_init (gk_hash_ctx_t *c) { gk_sha256_init (&c->sha256); }
static void sha256_update (gk_hash_ctx_t *c, const void *p, size_t n) { gk_sha256_update (&c->sha256, p, n); }
static void sha256_final (gk_hash_ctx_t *c, uint8_t *d) { gk_sha256_final (&c->sha256, d); }
static void sha512_init (gk_hash_ctx_t *c) { gk_sha512_init (&c->sha512); }
static void sha512_update (gk_hash_ctx_t *c, const void *p, size_t n) { gk_sha512_update (&c->sha512, p, n); }
static void sha512_final (gk_hash_ctx_t *c, uint8_t *d) { gk_sha512_final (&c->sha512, d); }

const gk_hash_t gk_hash_sha1 =
	{ "SHA-1", GK_SHA1_DIGEST_SIZE, GK_SHA1_BLOCK_SIZE, sha1_init, sha1_update, sha1_final };
const gk_hash_t gk_hash_sha256 =
	{ "SHA-256", GK_SHA256_DIGEST_SIZE, 64, sha256_init, sha256_update, sha256_final };
const gk_hash_t gk_hash_sha512 =
	{ "SHA-512", GK_SHA512_DIGEST_SIZE, GK_SHA512_BLOCK_SIZE, sha512_init, sha512_update, sha512_final };

const gk_hash_t *gk_hash_find (const char *name)
{
	static const gk_hash_t *const all[] = { &gk_hash_sha1, &gk_hash_sha256, &gk_hash_sha512 };
	for (unsigned i = 0; i < sizeof all / sizeof all[0]; i++)
	{
		if (strcmp (name, all[i]->name) == 0)
		{
			return all[i];
		}
	}
	return 0;
}

void gk_hmac_init (gk_hmac_t *ctx, const gk_hash_t *hash, const void *key, size_t keylen)
{
	uint8_t k[GK_HASH_MAX_BLOCK];
	gk_wipe (k, sizeof k);
	if (keylen > hash->block_size)
	{
		gk_hash_ctx_t h;
		hash->init (&h);
		hash->update (&h, key, keylen);
		hash->final (&h, k);
	}
	else if (keylen > 0)
	{
		memcpy (k, key, keylen);
	}

	ctx->hash = hash;

	for (size_t i = 0; i < hash->block_size; i++) k[i] ^= 0x36;
	hash->init (&ctx->inner);
	hash->update (&ctx->inner, k, hash->block_size);

	for (size_t i = 0; i < hash->block_size; i++) k[i] ^= 0x36 ^ 0x5c;
	hash->init (&ctx->outer);
	hash->update (&ctx->outer, k, hash->block_size);

	gk_wipe (k, sizeof k);
}

void gk_hmac_update (gk_hmac_t *ctx, const void *data, size_t len)
{
	ctx->hash->update (&ctx->inner, data, len);
}

void gk_hmac_final (gk_hmac_t *ctx, uint8_t *digest)
{
	uint8_t inner[GK_HASH_MAX_DIGEST];
	const gk_hash_t *hash = ctx->hash;

	hash->final (&ctx->inner, inner);
	hash->update (&ctx->outer, inner, hash->digest_size);
	hash->final (&ctx->outer, digest);

	gk_wipe (inner, sizeof inner);
	gk_wipe (ctx, sizeof *ctx);
}

void gk_hmac (const gk_hash_t *hash, const void *key, size_t keylen,
	      const void *data, size_t len, uint8_t *digest)
{
	gk_hmac_t ctx;
	gk_hmac_init (&ctx, hash, key, keylen);
	gk_hmac_update (&ctx, data, len);
	gk_hmac_final (&ctx, digest);
}

static int fill (uint8_t *p, int byte, size_t n)
{
	memset (p, byte, n);
	return (int) n;
}

int gk_hmac_selftest (void)
{
	static const char Text6[] = "Test Using Larger Than Block-Size Key - Hash Key First";
	static const char Text7[] = "This is a test using a larger than block-size key and a larger "
		"than block-size data. The key needs to be hashed before being used by the HMAC algorithm.";
	uint8_t key[131], data[50], d[GK_HASH_MAX_DIGEST];
	int n;

	/* RFC 2202, test cases 1, 2 and 6 */
	n = fill (key, 0x0b, 20);
	gk_hmac (&gk_hash_sha1, key, n, "Hi There", 8, d);
	if (!gk_hex_equal (d, 20, "b617318655057264e28bc0b6fb378c8ef146be00")) return 1;
	gk_hmac (&gk_hash_sha1, "Jefe", 4, "what do ya want for nothing?", 28, d);
	if (!gk_hex_equal (d, 20, "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79")) return 2;
	n = fill (key, 0xaa, 80);
	gk_hmac (&gk_hash_sha1, key, n, Text6, sizeof Text6 - 1, d);
	if (!gk_hex_equal (d, 20, "aa4ae5e15272d00e95705637ce8a3b55ed402112")) return 3;

	/* RFC 4231, test cases 1, 2, 3, 6 and 7 */
	n = fill (key, 0x0b, 20);
	gk_hmac (&gk_hash_sha256, key, n, "Hi There", 8, d);
	if (!gk_hex_equal (d, 32, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")) return 11;
	gk_hmac (&gk_hash_sha512, key, n, "Hi There", 8, d);
	if (!gk_hex_equal (d, 64, "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde"
				  "daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854")) return 12;

	gk_hmac (&gk_hash_sha256, "Jefe", 4, "what do ya want for nothing?", 28, d);
	if (!gk_hex_equal (d, 32, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")) return 13;
	gk_hmac (&gk_hash_sha512, "Jefe", 4, "what do ya want for nothing?", 28, d);
	if (!gk_hex_equal (d, 64, "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554"
				  "9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737")) return 14;

	n = fill (key, 0xaa, 20);
	fill (data, 0xdd, 50);
	gk_hmac (&gk_hash_sha256, key, n, data, 50, d);
	if (!gk_hex_equal (d, 32, "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe")) return 15;
	gk_hmac (&gk_hash_sha512, key, n, data, 50, d);
	if (!gk_hex_equal (d, 64, "fa73b0089d56a284efb0f0756c890be9b1b5dbdd8ee81a3655f83e33b2279d39"
				  "bf3e848279a722c806b485a47e67c807b946a337bee8942674278859e13292fb")) return 16;

	n = fill (key, 0xaa, 131);
	gk_hmac (&gk_hash_sha256, key, n, Text6, sizeof Text6 - 1, d);
	if (!gk_hex_equal (d, 32, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")) return 17;
	gk_hmac (&gk_hash_sha512, key, n, Text6, sizeof Text6 - 1, d);
	if (!gk_hex_equal (d, 64, "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352"
				  "6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598")) return 18;
	gk_hmac (&gk_hash_sha256, key, n, Text7, sizeof Text7 - 1, d);
	if (!gk_hex_equal (d, 32, "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2")) return 19;
	gk_hmac (&gk_hash_sha512, key, n, Text7, sizeof Text7 - 1, d);
	if (!gk_hex_equal (d, 64, "e37b6a775dc87dbaa4dfa9f96e5e3ffddebd71f8867289865df5a32d20cdc944"
				  "b6022cac3c4982b10d5eeb55c3e4de15134676fb6de0446065c97440fa8c6a58")) return 20;

	/* streaming in pieces matches one call */
	gk_hmac_t ctx;
	uint8_t d2[GK_HASH_MAX_DIGEST];
	gk_hmac_init (&ctx, &gk_hash_sha512, "Jefe", 4);
	gk_hmac_update (&ctx, "what do ya want ", 16);
	gk_hmac_update (&ctx, "for nothing?", 12);
	gk_hmac_final (&ctx, d2);
	gk_hmac (&gk_hash_sha512, "Jefe", 4, "what do ya want for nothing?", 28, d);
	if (memcmp (d, d2, 64) != 0) return 30;

	gk_wipe (key, sizeof key);
	gk_wipe (d, sizeof d);
	gk_wipe (d2, sizeof d2);
	return 0;
}
