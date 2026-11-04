/* Host build: cc -O2 -I src/crypto tests/native/test_hmac.c src/crypto/{sha1,sha256,sha512,hmac}.c && ./a.out
 *
 * The C self-tests (FIPS 180-4, RFC 2202, RFC 4231), then random inputs
 * printed for tools/check_hashes.py to compare with Python's hashlib. */
#include <stdio.h>
#include <stdlib.h>
#include "hmac.h"

int main (int argc, char **argv)
{
	int r = zg_sha1_selftest ();
	if (r == 0) r = zg_sha256_selftest () ? 2000 : 0;
	if (r == 0) r = zg_sha512_selftest () ? 3000 : 0;
	if (r == 0) r = zg_hmac_selftest ();
	printf ("hash and hmac selftests: %s (%d)\n", r == 0 ? "PASS" : "FAIL", r);
	if (r != 0 || argc < 2)
	{
		return r != 0;
	}

	/* "random N": N cases as lines "hash keyhex msghex digest hmac" */
	int cases = atoi (argv[1]);
	static const zg_hash_t *const hashes[] = { &zg_hash_sha1, &zg_hash_sha256, &zg_hash_sha512 };
	srand (1);
	for (int c = 0; c < cases; c++)
	{
		const zg_hash_t *h = hashes[c % 3];
		size_t kl = (size_t) rand () % 300, ml = (size_t) rand () % 600;
		static uint8_t k[300], m[600];
		for (size_t i = 0; i < kl; i++) k[i] = (uint8_t) rand ();
		for (size_t i = 0; i < ml; i++) m[i] = (uint8_t) rand ();

		uint8_t d[64], mac[64];
		zg_hash_ctx_t ctx;
		h->init (&ctx);
		h->update (&ctx, m, ml);
		h->final (&ctx, d);
		zg_hmac (h, k, kl, m, ml, mac);

		printf ("%s ", h->name);
		for (size_t i = 0; i < kl; i++) printf ("%02x", k[i]);
		printf (" ");
		for (size_t i = 0; i < ml; i++) printf ("%02x", m[i]);
		printf (" ");
		for (size_t i = 0; i < h->digest_size; i++) printf ("%02x", d[i]);
		printf (" ");
		for (size_t i = 0; i < h->digest_size; i++) printf ("%02x", mac[i]);
		printf ("\n");
	}
	return 0;
}
