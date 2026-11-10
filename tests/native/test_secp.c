/* Host test for src/crypto/secp.c over libsecp256k1, driven by
 * tools/check_secp.py (which builds it, with the library's 32-bit field
 * arithmetic, as on the Pi Zero).
 *
 * Runs gk_secp_selftest, prints "selftest: PASS|FAIL (code)", then answers
 * lines on stdin:
 *   case SECKEY TWEAK HASH AUX  -> pub33 pub65 der tweaked tweakedpub
 *                                  xonly parity schnorr taproot taprootpub
 *                                  taprootparity   ("-" for a failure)
 *   schnorrverify XONLY MSG SIG -> 1 or 0   (MSG may be empty: "-")
 *   ecdsaverify DER HASH PUBKEY -> 1 or 0
 *   convert PUBKEY              -> pub33 pub65, or "- -"
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "secp.h"

void gk_fatal (const char *message)
{
	fprintf (stderr, "gk_fatal: %s\n", message);
	exit (3);
}

static size_t unhex (const char *s, uint8_t *out, size_t max)
{
	size_t n = 0;
	if (strcmp (s, "-") == 0)
	{
		return 0;
	}
	while (s[0] && s[1] && n < max)
	{
		unsigned v;
		sscanf (s, "%2x", &v);
		out[n++] = (uint8_t) v;
		s += 2;
	}
	return n;
}

static void hex (const uint8_t *p, size_t n)
{
	printf (" ");
	for (size_t i = 0; i < n; i++) printf ("%02x", p[i]);
}

static void put (int ok, const uint8_t *p, size_t n)
{
	if (ok) hex (p, n); else printf (" -");
}

int main (void)
{
	uint8_t seed[32] = { 1, 2, 3 };
	int r = gk_secp_init (seed);
	printf ("selftest: %s (%d)\n", r == 0 ? "PASS" : "FAIL", r);
	if (r != 0)
	{
		return 1;
	}

	static char line[4096], cmd[32], a1[1024], a2[1024], a3[1024], a4[1024];
	while (fgets (line, sizeof line, stdin))
	{
		a1[0] = a2[0] = a3[0] = a4[0] = 0;
		if (sscanf (line, "%31s %1023s %1023s %1023s %1023s", cmd, a1, a2, a3, a4) < 2)
		{
			continue;
		}
		uint8_t k[32], t[32], h[32], aux[32], out[72], pub[65], x[32];
		static uint8_t msg[512], sig[512];
		size_t len;
		int parity, ok;

		if (strcmp (cmd, "case") == 0)
		{
			unhex (a1, k, 32); unhex (a2, t, 32); unhex (a3, h, 32); unhex (a4, aux, 32);
			printf ("result");
			ok = gk_secp_pubkey_create (k, 1, out); put (ok, out, 33);
			ok = gk_secp_pubkey_create (k, 0, pub); put (ok, pub, 65);
			ok = gk_secp_ecdsa_sign (h, k, out, &len); put (ok, out, len);
			if (ok && !gk_secp_ecdsa_verify (out, len, h, pub, 65)) printf ("!VERIFY");
			ok = gk_secp_seckey_tweak_add (k, t, out); put (ok, out, 32);
			ok = gk_secp_pubkey_create (k, 0, pub) && gk_secp_pubkey_tweak_add (pub, 65, t, 1, out);
			put (ok, out, 33);
			ok = gk_secp_xonly_pubkey (k, x, &parity); put (ok, x, 32);
			printf (ok ? " %d" : " -", parity);
			ok = gk_secp_schnorr_sign (h, k, aux, out); put (ok, out, 64);
			if (ok && !gk_secp_schnorr_verify (out, h, 32, x)) printf ("!VERIFY");
			ok = gk_secp_seckey_taproot_tweak (k, t, out); put (ok, out, 32);
			ok = gk_secp_xonly_pubkey (k, x, &parity) && gk_secp_xonly_tweak_add (x, t, out, &parity);
			put (ok, out, 32);
			printf (ok ? " %d" : " -", parity);
			printf ("\n");
		}
		else if (strcmp (cmd, "schnorrverify") == 0)
		{
			unhex (a1, x, 32);
			size_t ml = unhex (a2, msg, sizeof msg);
			size_t sl = unhex (a3, sig, sizeof sig);
			printf ("%d\n", sl == 64 && gk_secp_schnorr_verify (sig, msg, ml, x));
		}
		else if (strcmp (cmd, "ecdsaverify") == 0)
		{
			size_t dl = unhex (a1, sig, sizeof sig);
			unhex (a2, h, 32);
			size_t pl = unhex (a3, pub, sizeof pub);
			printf ("%d\n", gk_secp_ecdsa_verify (sig, dl, h, pub, pl));
		}
		else if (strcmp (cmd, "convert") == 0)
		{
			size_t pl = unhex (a1, msg, sizeof msg);
			ok = gk_secp_pubkey_convert (msg, pl, 1, out); put (ok, out, 33);
			ok = gk_secp_pubkey_convert (msg, pl, 0, pub); put (ok, pub, 65);
			printf ("\n");
		}
		fflush (stdout);
	}
	return 0;
}
