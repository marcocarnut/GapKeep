/*
 * x25519.c - X25519 on Monocypher (see x25519.h).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "x25519.h"
#include "wipe.h"
#include "hexcheck.h"
#include <monocypher.h>
#include <string.h>

void gk_x25519_public (const uint8_t secret[GK_X25519_SIZE], uint8_t pub[GK_X25519_SIZE])
{
	crypto_x25519_public_key (pub, secret);
}

int gk_x25519_shared (const uint8_t secret[GK_X25519_SIZE], const uint8_t pub[GK_X25519_SIZE],
		      uint8_t shared[GK_X25519_SIZE])
{
	crypto_x25519 (shared, secret, pub);
	uint8_t any = 0;
	for (int i = 0; i < GK_X25519_SIZE; i++)
	{
		any |= shared[i];		/* not a shortcut */
	}
	if (any == 0)
	{
		gk_wipe (shared, GK_X25519_SIZE);
		return -1;
	}
	return 0;
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

int gk_x25519_selftest (void)
{
	uint8_t a[32], b[32], pub[32], shared[32];
	unhex ("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", a);
	unhex ("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", b);

	/* RFC 7748, 6.1 */
	gk_x25519_public (a, pub);
	if (!gk_hex_equal (pub, 32, "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")) return 1;
	if (gk_x25519_shared (b, pub, shared) != 0
	    || !gk_hex_equal (shared, 32, "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")) return 2;
	gk_x25519_public (b, pub);
	if (!gk_hex_equal (pub, 32, "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")) return 3;
	if (gk_x25519_shared (a, pub, shared) != 0
	    || !gk_hex_equal (shared, 32, "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")) return 4;

	/* RFC 7748, 5.2: one iteration from k = u = 9 */
	memset (a, 0, 32);
	a[0] = 9;
	if (gk_x25519_shared (a, a, shared) != 0
	    || !gk_hex_equal (shared, 32, "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079")) return 5;

	/* u = 0 (small order): the result is all zeros, refused */
	memset (pub, 0, 32);
	if (gk_x25519_shared (b, pub, shared) != -1) return 6;

	gk_wipe (a, sizeof a);
	gk_wipe (b, sizeof b);
	gk_wipe (shared, sizeof shared);
	return 0;
}
