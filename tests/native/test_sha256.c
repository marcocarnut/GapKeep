/* Host build: cc -O2 -I src/crypto tests/native/test_sha256.c src/crypto/sha256.c && ./a.out */
#include <stdio.h>
#include "sha256.h"

int main (void)
{
	int r = zg_sha256_selftest ();
	printf ("sha256 selftest: %s (%d)\n", r == 0 ? "PASS" : "FAIL", r);
	return r != 0;
}
