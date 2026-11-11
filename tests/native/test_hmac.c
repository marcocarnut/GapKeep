/* Host build: cc -O2 -I src/crypto tests/native/test_hmac.c \
 *     src/crypto/{sha1,sha256,sha512,hmac,ripemd160,pbkdf2}.c && ./a.out
 *
 * The C self-tests (FIPS 180-4, RFC 2202, RFC 4231, RIPEMD-160's, PBKDF2's),
 * then random inputs printed for tools/check_hashes.py to compare with
 * Python's hashlib.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include <stdio.h>
#include <stdlib.h>
#include "hmac.h"
#include "ripemd160.h"
#include "pbkdf2.h"

static void hex (const uint8_t *p, size_t n)
{
	for (size_t i = 0; i < n; i++) printf ("%02x", p[i]);
}

int main (int argc, char **argv)
{
	int r = gk_sha1_selftest ();
	if (r == 0) r = gk_sha256_selftest () ? 2000 : 0;
	if (r == 0) r = gk_sha512_selftest () ? 3000 : 0;
	if (r == 0) r = gk_hmac_selftest ();
	if (r == 0) r = gk_ripemd160_selftest (1) ? 4000 + gk_ripemd160_selftest (1) : 0;
	if (r == 0) r = gk_pbkdf2_selftest (1) ? 5000 + gk_pbkdf2_selftest (1) : 0;
	printf ("hash and hmac selftests: %s (%d)\n", r == 0 ? "PASS" : "FAIL", r);
	if (r != 0 || argc < 2)
	{
		return r != 0;
	}

	/* "random N": N cases as lines "hash keyhex msghex digest hmac" */
	int cases = atoi (argv[1]);
	static const gk_hash_t *const hashes[] =
		{ &gk_hash_sha1, &gk_hash_sha256, &gk_hash_sha512, &gk_hash_sha224, &gk_hash_sha384 };
	srand (1);
	for (int c = 0; c < cases; c++)
	{
		const gk_hash_t *h = hashes[c % 5];
		size_t kl = (size_t) rand () % 300, ml = (size_t) rand () % 600;
		static uint8_t k[300], m[600];
		for (size_t i = 0; i < kl; i++) k[i] = (uint8_t) rand ();
		for (size_t i = 0; i < ml; i++) m[i] = (uint8_t) rand ();

		uint8_t d[64], mac[64];
		gk_hash_ctx_t ctx;
		h->init (&ctx);
		h->update (&ctx, m, ml);
		h->final (&ctx, d);
		gk_hmac (h, k, kl, m, ml, mac);

		printf ("%s ", h->name);
		for (size_t i = 0; i < kl; i++) printf ("%02x", k[i]);
		printf (" ");
		for (size_t i = 0; i < ml; i++) printf ("%02x", m[i]);
		printf (" ");
		for (size_t i = 0; i < h->digest_size; i++) printf ("%02x", d[i]);
		printf (" ");
		for (size_t i = 0; i < h->digest_size; i++) printf ("%02x", mac[i]);
		printf ("\n");

		/* "RIPEMD-160 - msghex digest hash160" */
		uint8_t r160[20], h160[20];
		gk_ripemd160 (m, ml, r160);
		gk_hash160 (m, ml, h160);
		printf ("RIPEMD-160 - ");
		hex (m, ml); printf (" "); hex (r160, 20); printf (" "); hex (h160, 20);
		printf ("\n");

		/* every 10th: "PBKDF2 hash pwhex salthex iterations dkhex" */
		if (c % 10 == 0)
		{
			uint32_t it = 1 + (uint32_t) rand () % 50;
			size_t dl = 1 + (size_t) rand () % 150, pl = kl % 150, sl = ml % 80;
			uint8_t dk[150];
			gk_pbkdf2 (h, k, pl, m, sl, it, dk, dl);
			printf ("PBKDF2 %s ", h->name);
			hex (k, pl); printf (" "); hex (m, sl); printf (" %u ", (unsigned) it); hex (dk, dl);
			printf ("\n");
		}
	}
	return 0;
}
