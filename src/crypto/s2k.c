/*
 * s2k.c - OpenPGP string-to-key (RFC 9580, 3.7.1.1 to 3.7.1.3), written
 * from the RFC.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "s2k.h"
#include "wipe.h"
#include "hexcheck.h"
#include <string.h>

#define CHUNK		1024		/* salt and passphrase, repeated */
#define STOP_EVERY	(1024 * 1024)	/* bytes hashed between stop() questions */

uint32_t gk_s2k_count (uint8_t c)
{
	return (uint32_t) (16 + (c & 15)) << ((c >> 4) + 6);
}

/* Feeds the first count bytes of salt||passphrase||salt||passphrase...
   (count >= len, the length of one salt||passphrase). */
static int feed_repeated (const gk_hash_t *hash, gk_hash_ctx_t *ctx, const uint8_t *salt,
			  const uint8_t *pass, size_t passlen, uint32_t count,
			  int (*stop) (void *), void *arg)
{
	size_t len = GK_S2K_SALT_SIZE + passlen;
	uint32_t since_stop = 0;

	if (len <= CHUNK)
	{
		/* as many whole copies as fit: each chunk ends where a copy
		   ends, so the next one starts the pattern again */
		uint8_t buf[CHUNK];
		size_t copies = CHUNK / len, chunk = copies * len;
		for (size_t i = 0; i < copies; i++)
		{
			memcpy (buf + i * len, salt, GK_S2K_SALT_SIZE);
			memcpy (buf + i * len + GK_S2K_SALT_SIZE, pass, passlen);
		}
		while (count > 0)
		{
			size_t n = count < chunk ? count : chunk;
			hash->update (ctx, buf, n);
			count -= (uint32_t) n;
			since_stop += (uint32_t) n;
			if (stop != 0 && since_stop >= STOP_EVERY)
			{
				since_stop = 0;
				if (stop (arg))
				{
					gk_wipe (buf, sizeof buf);
					return -1;
				}
			}
		}
		gk_wipe (buf, sizeof buf);
		return 0;
	}

	/* a passphrase longer than the buffer: salt, then the passphrase,
	   as long as the count lasts */
	while (count > 0)
	{
		size_t n = count < GK_S2K_SALT_SIZE ? count : GK_S2K_SALT_SIZE;
		hash->update (ctx, salt, n);
		count -= (uint32_t) n;
		n = count < passlen ? count : passlen;
		hash->update (ctx, pass, n);
		count -= (uint32_t) n;
		since_stop += (uint32_t) len;
		if (stop != 0 && since_stop >= STOP_EVERY)
		{
			since_stop = 0;
			if (stop (arg))
			{
				return -1;
			}
		}
	}
	return 0;
}

int gk_s2k (const gk_hash_t *hash, int type, const void *passphrase, size_t passlen,
	    const uint8_t *salt, uint8_t coded_count, uint8_t *out, size_t outlen,
	    int (*stop) (void *), void *arg)
{
	if (type != GK_S2K_SIMPLE && type != GK_S2K_SALTED && type != GK_S2K_ITERATED)
	{
		return -2;
	}

	static const uint8_t zeros[GK_HASH_MAX_DIGEST] = { 0 };
	uint8_t *start = out;
	size_t total = outlen;
	uint8_t digest[GK_HASH_MAX_DIGEST];
	gk_hash_ctx_t ctx;
	int stopped = 0;

	for (size_t preload = 0; outlen > 0 && !stopped; preload++)
	{
		hash->init (&ctx);
		/* the i-th hash starts with i zero bytes */
		for (size_t z = preload; z > 0; )
		{
			size_t n = z < sizeof zeros ? z : sizeof zeros;
			hash->update (&ctx, zeros, n);
			z -= n;
		}

		if (type == GK_S2K_SIMPLE)
		{
			hash->update (&ctx, passphrase, passlen);
		}
		else
		{
			uint32_t count = type == GK_S2K_ITERATED ? gk_s2k_count (coded_count) : 0;
			size_t len = GK_S2K_SALT_SIZE + passlen;
			if (count < len)
			{
				/* RFC 9580, 3.7.1.3: less than one salt and
				   passphrase: all of them, once (and type 1) */
				hash->update (&ctx, salt, GK_S2K_SALT_SIZE);
				hash->update (&ctx, passphrase, passlen);
			}
			else if (feed_repeated (hash, &ctx, salt, passphrase, passlen, count, stop, arg) != 0)
			{
				stopped = 1;
			}
		}

		hash->final (&ctx, digest);	/* wipes ctx */
		size_t n = outlen < hash->digest_size ? outlen : hash->digest_size;
		memcpy (out, digest, n);
		out += n;
		outlen -= n;
	}

	gk_wipe (digest, sizeof digest);
	if (stopped)
	{
		gk_wipe (start, total);
		return -1;
	}
	return 0;
}

int gk_s2k_selftest (void)
{
	static const uint8_t salt[GK_S2K_SALT_SIZE] = { 1, 2, 3, 4, 5, 6, 7, 8 };
	uint8_t pass[1100], d[48];

	/* type 3, SHA-1, 65536 bytes, two hashes (the second preloaded) */
	gk_s2k (&gk_hash_sha1, GK_S2K_ITERATED, "hello world", 11, salt, 0x60, d, 32, 0, 0);
	if (!gk_hex_equal (d, 32, "3251cc71bbba6d556b738cd47f5070e3634833e818a6d2bafab4a582d1deba88")) return 1;
	/* type 1, SHA-256 */
	gk_s2k (&gk_hash_sha256, GK_S2K_SALTED, "password", 8, salt, 0, d, 32, 0, 0);
	if (!gk_hex_equal (d, 32, "401cee42f1e78e4ce02e01102870bd121c252c9f617db439352f749ceecaadfc")) return 2;
	/* type 0, SHA-512, an empty passphrase: SHA-512 ("") */
	gk_s2k (&gk_hash_sha512, GK_S2K_SIMPLE, "", 0, 0, 0, d, 16, 0, 0);
	if (!gk_hex_equal (d, 16, "cf83e1357eefb8bdf1542850d66d8007")) return 3;
	/* type 3, the count (1024) below salt and passphrase (1108): once */
	memset (pass, 'x', 1100);
	gk_s2k (&gk_hash_sha256, GK_S2K_ITERATED, pass, 1100, salt, 0, d, 24, 0, 0);
	if (!gk_hex_equal (d, 24, "5700f356ee4b5ed8ee30f871f124824ce3c670ab149d5dde")) return 4;
	/* type 3, SHA-384, 2048 bytes of 1008-byte copies */
	memset (pass, 'y', 1000);
	gk_s2k (&gk_hash_sha384, GK_S2K_ITERATED, pass, 1000, salt, 0x10, d, 48, 0, 0);
	if (!gk_hex_equal (d, 48, "15df07f7f9714360a825341a3adaf218250961891f21a4c5"
				  "c0ad76783bfdeae5f34e501f1fb30b766c76cd3aa802cee0")) return 5;
	/* type 0, SHA-224, 40 bytes: two hashes */
	gk_s2k (&gk_hash_sha224, GK_S2K_SIMPLE, "abc", 3, 0, 0, d, 40, 0, 0);
	if (!gk_hex_equal (d, 40, "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"
				  "a5b29b7d277ee5f8472f0c9f")) return 6;
	if (gk_s2k_count (0) != 1024 || gk_s2k_count (0x60) != 65536 || gk_s2k_count (255) != 65011712)
	{
		return 7;
	}

	gk_wipe (d, sizeof d);
	return 0;
}
