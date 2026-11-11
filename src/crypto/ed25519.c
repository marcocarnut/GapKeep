/*
 * ed25519.c - Ed25519 on Monocypher's optional RFC 8032 code (see
 * ed25519.h). Monocypher's own crypto_eddsa_* use BLAKE2b: not Ed25519.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "ed25519.h"
#include "wipe.h"
#include "hexcheck.h"
#include <monocypher-ed25519.h>
#include <string.h>

void gk_ed25519_keypair (const uint8_t seed[GK_ED25519_SEED_SIZE],
			 uint8_t secret[GK_ED25519_SECRET_SIZE], uint8_t pub[GK_ED25519_PUBLIC_SIZE])
{
	uint8_t copy[GK_ED25519_SEED_SIZE];	/* Monocypher wipes the seed it is given */
	memcpy (copy, seed, sizeof copy);
	crypto_ed25519_key_pair (secret, pub, copy);
	gk_wipe (copy, sizeof copy);
}

int gk_ed25519_sign (const uint8_t secret[GK_ED25519_SECRET_SIZE], const void *msg, size_t len,
		     uint8_t sig[GK_ED25519_SIGNATURE_SIZE])
{
	crypto_ed25519_sign (sig, secret, (const uint8_t *) msg, len);
	if (crypto_ed25519_check (sig, secret + GK_ED25519_SEED_SIZE, (const uint8_t *) msg, len) != 0)
	{
		gk_wipe (sig, GK_ED25519_SIGNATURE_SIZE);
		return -1;
	}
	return 0;
}

/* RFC 8032, 5.1.3, step 4: "if x = 0 and x_0 = 1, decoding fails". The
   points with x = 0 have y = 1 or y = p - 1; Monocypher accepts them with
   the sign bit set (Wycheproof's Ed25519 test 151: a second encoding of
   the same signature). Other non-canonical encodings (y >= p) it refuses. */
static int x0_with_sign (const uint8_t point[32])
{
	static const uint8_t one[32] = { 1, 0 };
	static const uint8_t minus_one[32] =
	{
		0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
	};
	if ((point[31] & 0x80) == 0)
	{
		return 0;
	}
	uint8_t y[32];
	memcpy (y, point, 32);
	y[31] &= 0x7f;
	return memcmp (y, one, 32) == 0 || memcmp (y, minus_one, 32) == 0;
}

int gk_ed25519_verify (const uint8_t sig[GK_ED25519_SIGNATURE_SIZE], const uint8_t pub[GK_ED25519_PUBLIC_SIZE],
		       const void *msg, size_t len)
{
	if (x0_with_sign (sig) || x0_with_sign (pub))
	{
		return 0;
	}
	return crypto_ed25519_check (sig, pub, (const uint8_t *) msg, len) == 0;
}

static void unhex (const char *hex, uint8_t *out)
{
	for (; hex[0] && hex[1]; hex += 2)
	{
		int hi = hex[0] <= '9' ? hex[0] - '0' : hex[0] - 'a' + 10;
		int lo = hex[1] <= '9' ? hex[1] - '0' : hex[1] - 'a' + 10;
		*out++ = (uint8_t) (hi << 4 | lo);
	}
}

int gk_ed25519_selftest (void)
{
	static const struct { const char *seed, *pub, *msg, *sig; } v[] =
	{
		/* RFC 8032, 7.1, TEST 1 to 3 */
		{ "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
		  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
		  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
		  "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
		{ "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
		  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
		  "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
		  "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
		{ "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
		  "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
		  "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac"
		  "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a" },
		/* RFC 9580, A.1 and A.2: the SHA2-256 digest of an OpenPGP
		   signature's data, signed as the message */
		{ "1a8b1ff05ded48e18bf50166c664ab023ea70003d78d9e41f5758a91d850f8d2",
		  "3f098994bdd916ed4053197934e4a87c80733a1280d62f8010992e43ee3b2406",
		  "f6220a3f757814f4c2176ffbb68b00249cd4ccdc059c4b34ad871f30b1740280",
		  "56f90cca98e2102637bd983fdb16c131dfd27ed82bf4dde5606e0d756aed3366"
		  "d09c4fa11527f038e0f57f2201d82f2ea2c9033265fa6ceb489e854bae61b404" },
	};
	uint8_t seed[32], secret[64], pub[32], msg[32], sig[64];

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		size_t len = strlen (v[i].msg) / 2;
		unhex (v[i].seed, seed);
		unhex (v[i].msg, msg);
		gk_ed25519_keypair (seed, secret, pub);
		if (!gk_hex_equal (pub, 32, v[i].pub))
		{
			return 1 + 10 * (int) i;
		}
		if (gk_ed25519_sign (secret, msg, len, sig) != 0 || !gk_hex_equal (sig, 64, v[i].sig))
		{
			return 2 + 10 * (int) i;
		}
		if (!gk_ed25519_verify (sig, pub, msg, len))
		{
			return 3 + 10 * (int) i;
		}
		/* one bit off in the message, the signature's R or its S */
		msg[0] ^= 1;
		int bad = len > 0 && gk_ed25519_verify (sig, pub, msg, len);
		msg[0] ^= 1;
		sig[0] ^= 1;
		bad |= gk_ed25519_verify (sig, pub, msg, len);
		sig[0] ^= 1;
		sig[40] ^= 1;
		bad |= gk_ed25519_verify (sig, pub, msg, len);
		if (bad)
		{
			return 4 + 10 * (int) i;
		}
	}

	gk_wipe (seed, sizeof seed);
	gk_wipe (secret, sizeof secret);
	return 0;
}
