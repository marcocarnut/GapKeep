/*
 * aes.c - AES-CFB128 on Mbed TLS's AES (see aes.h).
 *
 * Mbed TLS's AES uses lookup tables (MBEDTLS_AES_ROM_TABLES): not
 * constant-time against an attacker who shares the processor's cache.
 * GapKeep runs one app at a time and nothing else, and the key comes
 * from the app that asks; docs/API.md says so.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "aes.h"
#include "wipe.h"
#include "hexcheck.h"
#include <mbedtls/aes.h>
#include <string.h>

#define STOP_EVERY	(64 * 1024)

int gk_aes_cfb (const uint8_t *key, size_t keylen, const uint8_t iv[GK_AES_BLOCK_SIZE], int decrypt,
		const uint8_t *in, uint8_t *out, size_t len, int (*stop) (void *), void *arg)
{
	if (keylen != 16 && keylen != 24 && keylen != 32)
	{
		return -2;
	}

	/* CFB uses the cipher forwards both ways: always the encryption key */
	mbedtls_aes_context aes;
	mbedtls_aes_init (&aes);
	if (mbedtls_aes_setkey_enc (&aes, key, (unsigned) keylen * 8) != 0)
	{
		mbedtls_aes_free (&aes);
		return -2;
	}

	uint8_t feedback[GK_AES_BLOCK_SIZE];
	memcpy (feedback, iv, sizeof feedback);
	size_t offset = 0;		/* where in the block the next byte is */
	uint8_t *start = out;
	size_t total = len;
	int result = 0;

	while (len > 0)
	{
		size_t n = len < STOP_EVERY ? len : STOP_EVERY;
		mbedtls_aes_crypt_cfb128 (&aes, decrypt ? MBEDTLS_AES_DECRYPT : MBEDTLS_AES_ENCRYPT,
					  n, &offset, feedback, in, out);
		in += n;
		out += n;
		len -= n;
		if (len > 0 && stop != 0 && stop (arg))
		{
			gk_wipe (start, total);
			result = -1;
			break;
		}
	}

	mbedtls_aes_free (&aes);	/* wipes the key schedule */
	gk_wipe (feedback, sizeof feedback);
	return result;
}

static int unhex (const char *hex, uint8_t *out)
{
	int n = 0;
	for (; hex[0] && hex[1]; hex += 2)
	{
		int hi = hex[0] <= '9' ? hex[0] - '0' : hex[0] - 'a' + 10;
		int lo = hex[1] <= '9' ? hex[1] - '0' : hex[1] - 'a' + 10;
		out[n++] = (uint8_t) (hi << 4 | lo);
	}
	return n;
}

int gk_aes_selftest (void)
{
	static const char Plain[] =
		"6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51"
		"30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710";
	static const struct { const char *key, *cipher; } v[] =
	{
		{ "2b7e151628aed2a6abf7158809cf4f3c",
		  "3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b"
		  "26751f67a3cbb140b1808cf187a4f4dfc04b05357c5d1c0eeac4c66f9ff7f2e6" },
		{ "8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b",
		  "cdc80d6fddf18cab34c25909c99a417467ce7f7f81173621961a2b70171d3d7a"
		  "2e1e8a1dd59b88b1c8e60fed1efac4c9c05f9f9ca9834fa042ae8fba584b09ff" },
		{ "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4",
		  "dc7e84bfda79164b7ecd8486985d386039ffed143b28b1c832113c6331e5407b"
		  "df10132415e54b92a13ed0a8267ae2f975a385741ab9cef82031623d55b1e471" },
	};
	uint8_t iv[16], key[32], plain[64], buf[64];
	unhex ("000102030405060708090a0b0c0d0e0f", iv);
	unhex (Plain, plain);

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		int keylen = unhex (v[i].key, key);
		if (gk_aes_cfb (key, keylen, iv, 0, plain, buf, 64, 0, 0) != 0
		    || !gk_hex_equal (buf, 64, v[i].cipher))
		{
			return 1 + 10 * (int) i;
		}
		/* in place, back */
		if (gk_aes_cfb (key, keylen, iv, 1, buf, buf, 64, 0, 0) != 0
		    || memcmp (buf, plain, 64) != 0)
		{
			return 2 + 10 * (int) i;
		}
		/* not whole blocks: a prefix of the same */
		uint8_t whole[64];
		unhex (v[i].cipher, whole);
		if (gk_aes_cfb (key, keylen, iv, 0, plain, buf, 37, 0, 0) != 0
		    || memcmp (buf, whole, 37) != 0)
		{
			return 3 + 10 * (int) i;
		}
	}
	if (gk_aes_cfb (key, 20, iv, 0, plain, buf, 16, 0, 0) != -2)
	{
		return 100;
	}

	gk_wipe (key, sizeof key);
	return 0;
}
