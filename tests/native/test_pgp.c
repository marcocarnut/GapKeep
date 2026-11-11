/* The native half of tools/check_pgp.py: src/crypto's S2K, AES-CFB,
 * Ed25519 and RSA (with Monocypher and Mbed TLS as the kernel builds
 * them), built for the host. Runs the self-tests, then answers one line of
 * hex arguments per line of input:
 *
 *   s2k TYPE HASH PASS SALT COUNT LEN [BUDGET] -> key (in steps)
 *   aes enc|dec KEY IV DATA                  -> data
 *   ed25519 SEED MSG                         -> public signature
 *   ed25519v SIG PUB MSG                     -> 1 | 0
 *   rsasign HASH DIGEST N E D P Q [U]        -> signature | error code
 *   rsaverify HASH DIGEST SIG N E            -> 1 | 0
 *   rsadecrypt C N E D P Q                   -> message | error code
 *   x25519 SECRET PUBLIC                     -> own public, shared | error -1
 *   wrap KEK KEY, unwrap KEK WRAPPED         -> result | error code
 *   seipd KEY DATA BUDGET                    -> plaintext | error code
 *
 * ("-" is an empty hex string; HASH as gk_hash_find names it.)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "s2k.h"
#include "aes.h"
#include "ed25519.h"
#include "rsa.h"
#include "x25519.h"
#include "seipd.h"
#include "ocb.h"
#include "aead.h"

static size_t unhex (const char *s, uint8_t *out)
{
	size_t n = 0;
	if (strcmp (s, "-") == 0)
	{
		return 0;
	}
	for (; s[0] && s[1]; s += 2)
	{
		unsigned b;
		sscanf (s, "%2x", &b);
		out[n++] = (uint8_t) b;
	}
	return n;
}

static void hex (const uint8_t *p, size_t n)
{
	for (size_t i = 0; i < n; i++) printf ("%02x", p[i]);
}

static int rng (void *arg, unsigned char *out, size_t len)
{
	(void) arg;
	for (size_t i = 0; i < len; i++) out[i] = (unsigned char) rand ();
	return 0;
}

#define BIG (1 << 20)

int main (void)
{
	int r = gk_sha256_selftest () ? 1000 : 0;
	if (r == 0) r = gk_sha512_selftest () ? 2000 : 0;
	if (r == 0) r = gk_hmac_selftest () ? 3000 + gk_hmac_selftest () : 0;
	if (r == 0) r = gk_s2k_selftest () ? 4000 + gk_s2k_selftest () : 0;
	if (r == 0) r = gk_aes_selftest () ? 5000 + gk_aes_selftest () : 0;
	if (r == 0) r = gk_ed25519_selftest () ? 6000 + gk_ed25519_selftest () : 0;
	if (r == 0) r = gk_rsa_selftest (rng, 0) ? 7000 + gk_rsa_selftest (rng, 0) : 0;
	if (r == 0) r = gk_x25519_selftest () ? 8000 + gk_x25519_selftest () : 0;
	if (r == 0) r = gk_seipd1_selftest () ? 9000 + gk_seipd1_selftest () : 0;
	if (r == 0) r = gk_ocb_selftest () ? 10000 + gk_ocb_selftest () : 0;
	if (r == 0) r = gk_aead_selftest () ? 11000 + gk_aead_selftest () : 0;
	printf ("pgp selftests: %s (%d)\n", r == 0 ? "PASS" : "FAIL", r);
	fflush (stdout);
	if (r != 0)
	{
		return 1;
	}

	static char line[8 * BIG];
	static uint8_t a[BIG], b[BIG], c[BIG], d[BIG], e[BIG], f[BIG], g[BIG], out[BIG];
	char *w[10];
	while (fgets (line, sizeof line, stdin))
	{
		int n = 0;
		for (char *t = strtok (line, " \n"); t && n < 10; t = strtok (0, " \n")) w[n++] = t;
		if (n == 0) continue;

		if (strcmp (w[0], "s2k") == 0 && (n == 7 || n == 8))
		{
			size_t pl = unhex (w[3], a), len = (size_t) atoi (w[6]);
			unhex (w[4], b);
			int rc;
			if (n == 7)
			{
				rc = gk_s2k (gk_hash_find (w[2]), atoi (w[1]), a, pl, b, (uint8_t) atoi (w[5]), out, len, 0, 0);
			}
			else
			{
				/* in steps of BUDGET bytes, the passphrase changed after begin */
				gk_s2k_job_t job;
				rc = gk_s2k_begin (&job, gk_hash_find (w[2]), atoi (w[1]), a, pl, b, (uint8_t) atoi (w[5]), len);
				if (rc == 0)
				{
					memset (a, 0x55, pl);
					size_t budget = (size_t) atoi (w[7]);
					double last = -1;
					while (gk_s2k_step (&job, budget))
					{
						double p = gk_s2k_progress (&job);
						if (p < last || p > 1) rc = -10;
						last = p;
					}
					memcpy (out, job.out, len);
					gk_s2k_end (&job);
				}
			}
			if (rc != 0) printf ("error %d", rc); else hex (out, len);
		}
		else if (strcmp (w[0], "aes") == 0 && n == 5)
		{
			size_t kl = unhex (w[2], a), dl = unhex (w[4], c);
			unhex (w[3], b);
			int rc = gk_aes_cfb (a, kl, b, strcmp (w[1], "dec") == 0, c, out, dl, 0, 0);
			if (rc != 0) printf ("error %d", rc); else if (dl == 0) printf ("-"); else hex (out, dl);
		}
		else if (strcmp (w[0], "ed25519") == 0 && n == 3)
		{
			uint8_t secret[64], pub[32], sig[64];
			unhex (w[1], a);
			size_t ml = unhex (w[2], b);
			gk_ed25519_keypair (a, secret, pub);
			int rc = gk_ed25519_sign (secret, b, ml, sig);
			if (rc != 0) printf ("error %d", rc); else { hex (pub, 32); printf (" "); hex (sig, 64); }
		}
		else if (strcmp (w[0], "ed25519v") == 0 && n == 4)
		{
			size_t sl = unhex (w[1], a), kl = unhex (w[2], b), ml = unhex (w[3], c);
			printf ("%d", sl == 64 && kl == 32 && gk_ed25519_verify (a, b, c, ml));
		}
		else if (strcmp (w[0], "rsasign") == 0 && (n == 8 || n == 9))
		{
			size_t dl = unhex (w[2], a), nl = unhex (w[3], b), el = unhex (w[4], c), xl = unhex (w[5], d);
			size_t pl = unhex (w[6], e), ql = unhex (w[7], f), ul = n == 9 ? unhex (w[8], g) : 0;
			gk_rsa_key_t *key;
			int rc = gk_rsa_import (&key, b, nl, c, el, d, xl, e, pl, f, ql, g, ul);
			if (rc != GK_RSA_OK)
			{
				printf ("error %d", rc);
			}
			else
			{
				rc = gk_rsa_sign (key, gk_hash_find (w[1]), a, dl, out, rng, 0);
				if (rc != GK_RSA_OK) printf ("error %d", rc); else hex (out, (gk_rsa_bits (key) + 7) / 8);
				gk_rsa_free (key);
			}
		}
		else if (strcmp (w[0], "rsaverify") == 0 && n == 6)
		{
			size_t dl = unhex (w[2], a), sl = unhex (w[3], b), nl = unhex (w[4], c), el = unhex (w[5], d);
			const gk_hash_t *h = gk_hash_find (w[1]);
			printf ("%d", h != 0 && gk_rsa_verify (c, nl, d, el, h, a, dl, b, sl));
		}
		else if (strcmp (w[0], "rsadecrypt") == 0 && n == 7)
		{
			size_t cl = unhex (w[1], a), nl = unhex (w[2], b), el = unhex (w[3], c), xl = unhex (w[4], d);
			size_t pl = unhex (w[5], e), ql = unhex (w[6], f), ml;
			gk_rsa_key_t *key;
			int rc = gk_rsa_import (&key, b, nl, c, el, d, xl, e, pl, f, ql, 0, 0);
			if (rc != GK_RSA_OK)
			{
				printf ("error %d", rc);
			}
			else
			{
				rc = gk_rsa_decrypt (key, a, cl, out, &ml, rng, 0);
				if (rc != GK_RSA_OK) printf ("error %d", rc); else if (ml == 0) printf ("-"); else hex (out, ml);
				gk_rsa_free (key);
			}
		}
		else if (strcmp (w[0], "x25519") == 0 && n == 3)
		{
			uint8_t pub[32], shared[32];
			size_t sl = unhex (w[1], a), pl = unhex (w[2], b);
			if (sl != 32 || pl != 32) { printf ("bad size"); }
			else
			{
				gk_x25519_public (a, pub);
				hex (pub, 32);
				if (gk_x25519_shared (a, b, shared) != 0) printf (" error -1"); else { printf (" "); hex (shared, 32); }
			}
		}
		else if ((strcmp (w[0], "wrap") == 0 || strcmp (w[0], "unwrap") == 0) && n == 3)
		{
			size_t kl = unhex (w[1], a), dl = unhex (w[2], b);
			int wrap = strcmp (w[0], "wrap") == 0;
			int rc = wrap ? gk_aes_wrap (a, kl, b, dl, out) : gk_aes_unwrap (a, kl, b, dl, out);
			if (rc != 0) printf ("error %d", rc); else hex (out, wrap ? dl + 8 : dl - 8);
		}
		else if (strcmp (w[0], "seipd") == 0 && n == 4)
		{
			size_t kl = unhex (w[1], a), dl = unhex (w[2], b);
			gk_seipd1_job_t job;
			int rc = gk_seipd1_begin (&job, a, kl, b, dl);
			if (rc != 0) { printf ("error %d", rc); }
			else
			{
				size_t budget = (size_t) atoi (w[3]);
				while (gk_seipd1_step (&job, budget)) ;
				const uint8_t *plain;
				size_t plainlen;
				rc = gk_seipd1_result (&job, &plain, &plainlen);
				if (rc != 0) printf ("error %d", rc); else if (plainlen == 0) printf ("-"); else hex (plain, plainlen);
				gk_seipd1_end (&job);
			}
		}
		else if (strcmp (w[0], "ocb") == 0 && n == 6)
		{
			/* ocb enc|dec KEY NONCE AD DATA (dec: DATA is C || tag) */
			size_t kl = unhex (w[2], a), nl = unhex (w[3], b), al = unhex (w[4], c), dl = unhex (w[5], d);
			gk_ocb_key_t key;
			if (gk_ocb_key_init (&key, a, kl) != 0) { printf ("error key"); }
			else if (strcmp (w[1], "enc") == 0)
			{
				gk_ocb_encrypt (&key, b, nl, c, al, d, out, dl, out + dl);
				hex (out, dl + 16);
			}
			else if (dl < 16 || gk_ocb_decrypt (&key, b, nl, c, al, d, out, dl - 16, d + dl - 16) != 0)
			{
				printf ("error -1");
			}
			else if (dl == 16) printf ("-"); else hex (out, dl - 16);
			if (kl == 16 || kl == 24 || kl == 32) gk_ocb_key_free (&key);
		}
		else if (strcmp (w[0], "aead") == 0 && n == 5)
		{
			/* aead 18|20 KEY DATA BUDGET */
			size_t kl = unhex (w[2], a), dl = unhex (w[3], b);
			gk_aead_job_t job;
			int rc = gk_aead_begin (&job, atoi (w[1]), a, kl, b, dl);
			if (rc != 0) { printf ("error %d", rc); }
			else
			{
				size_t budget = (size_t) atoi (w[4]);
				double last = -1;
				while (gk_aead_step (&job, budget))
				{
					double p = gk_aead_progress (&job);
					if (p < last || p > 1) rc = -10;
					last = p;
				}
				const uint8_t *plain;
				size_t plainlen;
				if (rc == 0) rc = gk_aead_result (&job, &plain, &plainlen);
				if (rc != 0) printf ("error %d", rc); else if (plainlen == 0) printf ("-"); else hex (plain, plainlen);
				gk_aead_end (&job);
			}
		}
		else
		{
			printf ("bad command");
		}
		printf ("\n");
		fflush (stdout);
	}
	return 0;
}
