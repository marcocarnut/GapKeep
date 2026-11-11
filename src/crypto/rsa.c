/*
 * rsa.c - RSASSA-PKCS1-v1_5 on Mbed TLS's RSA (see rsa.h).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "rsa.h"
#include "wipe.h"
#include <mbedtls/rsa.h>
#include <stdlib.h>
#include <string.h>

struct gk_rsa_key
{
	mbedtls_rsa_context rsa;
	uint8_t n[GK_RSA_MAX_BYTES];
	uint8_t e[GK_RSA_MAX_BYTES];
	size_t nlen, elen;
	unsigned bits;
};

/* RFC 8017, 9.2, note 1: DER of DigestInfo up to the digest */
static const struct
{
	const gk_hash_t *hash;
	uint8_t len;
	uint8_t der[19];
}
s_DigestInfo[] =
{
	{ &gk_hash_sha1, 15, { 0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00,
			       0x04, 0x14 } },
	{ &gk_hash_sha224, 19, { 0x30, 0x2d, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
				 0x02, 0x04, 0x05, 0x00, 0x04, 0x1c } },
	{ &gk_hash_sha256, 19, { 0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
				 0x02, 0x01, 0x05, 0x00, 0x04, 0x20 } },
	{ &gk_hash_sha384, 19, { 0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
				 0x02, 0x02, 0x05, 0x00, 0x04, 0x30 } },
	{ &gk_hash_sha512, 19, { 0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
				 0x02, 0x03, 0x05, 0x00, 0x04, 0x40 } },
};

/* EMSA-PKCS1-v1_5 (RFC 8017, 9.2): 00 01 FF...FF 00 DigestInfo, k bytes. */
static int encode (const gk_hash_t *hash, const uint8_t *digest, size_t dlen, uint8_t *em, size_t k)
{
	for (unsigned i = 0; i < sizeof s_DigestInfo / sizeof s_DigestInfo[0]; i++)
	{
		if (s_DigestInfo[i].hash != hash)
		{
			continue;
		}
		size_t tlen = s_DigestInfo[i].len + hash->digest_size;
		if (dlen != hash->digest_size || k < tlen + 11)
		{
			return GK_RSA_BAD_HASH;
		}
		em[0] = 0x00;
		em[1] = 0x01;
		memset (em + 2, 0xff, k - tlen - 3);
		em[k - tlen - 1] = 0x00;
		memcpy (em + k - tlen, s_DigestInfo[i].der, s_DigestInfo[i].len);
		memcpy (em + k - hash->digest_size, digest, dlen);
		return GK_RSA_OK;
	}
	return GK_RSA_BAD_HASH;
}

/* not a shortcut on the first difference */
static int equal (const uint8_t *a, const uint8_t *b, size_t n)
{
	uint8_t diff = 0;
	for (size_t i = 0; i < n; i++)
	{
		diff |= a[i] ^ b[i];
	}
	return diff == 0;
}

static const uint8_t *strip (const uint8_t *p, size_t *len)
{
	while (*len > 0 && *p == 0)
	{
		p++;
		(*len)--;
	}
	return p;
}

int gk_rsa_import (gk_rsa_key_t **pkey, const uint8_t *n, size_t nlen, const uint8_t *e, size_t elen,
		   const uint8_t *d, size_t dlen, const uint8_t *p, size_t plen,
		   const uint8_t *q, size_t qlen, const uint8_t *u, size_t ulen)
{
	*pkey = 0;
	n = strip (n, &nlen);
	e = strip (e, &elen);
	if (nlen > GK_RSA_MAX_BYTES || elen > nlen)
	{
		return nlen > GK_RSA_MAX_BYTES ? GK_RSA_BAD_SIZE : GK_RSA_BAD_KEY;
	}

	gk_rsa_key_t *key = calloc (1, sizeof *key);
	if (key == 0)
	{
		return GK_RSA_NO_MEMORY;
	}
	mbedtls_rsa_init (&key->rsa);	/* PKCS #1 v1.5 */

	int result = GK_RSA_BAD_KEY;
	mbedtls_mpi U, T;
	mbedtls_mpi_init (&U);
	mbedtls_mpi_init (&T);

	if (   mbedtls_rsa_import_raw (&key->rsa, n, nlen, p, plen, q, qlen, d, dlen, e, elen) != 0
	    || mbedtls_rsa_complete (&key->rsa) != 0)		/* derives DP, DQ, QP */
	{
		goto out;
	}
	key->bits = (unsigned) mbedtls_rsa_get_bitlen (&key->rsa);
	if (key->bits < GK_RSA_MIN_BITS || key->bits > GK_RSA_MAX_BITS)
	{
		result = GK_RSA_BAD_SIZE;
		goto out;
	}
	/* n = pq, 1 < d, e < n, de = 1 mod p-1 and q-1, e odd, the CRT values */
	if (mbedtls_rsa_check_privkey (&key->rsa) != 0)
	{
		goto out;
	}
	if (ulen > 0)
	{
		/* OpenPGP's u: u p = 1 mod q, u < q */
		mbedtls_mpi P, Q;
		mbedtls_mpi_init (&P);
		mbedtls_mpi_init (&Q);
		int bad =    mbedtls_rsa_export (&key->rsa, 0, &P, &Q, 0, 0) != 0
			  || mbedtls_mpi_read_binary (&U, u, ulen) != 0
			  || mbedtls_mpi_cmp_mpi (&U, &Q) >= 0
			  || mbedtls_mpi_mul_mpi (&T, &U, &P) != 0
			  || mbedtls_mpi_mod_mpi (&T, &T, &Q) != 0
			  || mbedtls_mpi_cmp_int (&T, 1) != 0;
		mbedtls_mpi_free (&P);		/* wipes */
		mbedtls_mpi_free (&Q);
		if (bad)
		{
			goto out;
		}
	}

	memcpy (key->n, n, nlen);
	memcpy (key->e, e, elen);
	key->nlen = nlen;
	key->elen = elen;
	*pkey = key;
	result = GK_RSA_OK;

out:
	mbedtls_mpi_free (&U);
	mbedtls_mpi_free (&T);
	if (result != GK_RSA_OK)
	{
		gk_rsa_free (key);
	}
	return result;
}

void gk_rsa_free (gk_rsa_key_t *key)
{
	if (key != 0)
	{
		mbedtls_rsa_free (&key->rsa);	/* wipes and frees its numbers */
		gk_wipe (key, sizeof *key);
		free (key);
	}
}

unsigned gk_rsa_bits (const gk_rsa_key_t *key)
{
	return key->bits;
}

const uint8_t *gk_rsa_n (const gk_rsa_key_t *key, size_t *len)
{
	*len = key->nlen;
	return key->n;
}

const uint8_t *gk_rsa_e (const gk_rsa_key_t *key, size_t *len)
{
	*len = key->elen;
	return key->e;
}

int gk_rsa_sign (gk_rsa_key_t *key, const gk_hash_t *hash, const uint8_t *digest, size_t dlen,
		 uint8_t *sig, gk_rsa_rng_t rng, void *rng_arg)
{
	size_t k = mbedtls_rsa_get_len (&key->rsa);
	uint8_t em[GK_RSA_MAX_BYTES], check[GK_RSA_MAX_BYTES];

	if (hash == &gk_hash_sha1)
	{
		return GK_RSA_BAD_HASH;		/* verification only */
	}
	int result = encode (hash, digest, dlen, em, k);
	if (result != GK_RSA_OK)
	{
		return result;
	}

	/* blinded, and checked by Mbed TLS (MBEDTLS_ERR_RSA_VERIFY_FAILED) */
	int ret = mbedtls_rsa_private (&key->rsa, rng, rng_arg, em, sig);
	if (ret == MBEDTLS_ERR_RSA_RNG_FAILED)
	{
		result = GK_RSA_RNG;
	}
	else if (ret != 0)
	{
		result = GK_RSA_FAULT;
	}
	/* and here: the signature, raised to e, must be what was signed */
	else if (mbedtls_rsa_public (&key->rsa, sig, check) != 0 || !equal (check, em, k))
	{
		result = GK_RSA_FAULT;
	}

	if (result != GK_RSA_OK)
	{
		gk_wipe (sig, k);
	}
	gk_wipe (em, sizeof em);
	gk_wipe (check, sizeof check);
	return result;
}

int gk_rsa_verify (const uint8_t *n, size_t nlen, const uint8_t *e, size_t elen,
		   const gk_hash_t *hash, const uint8_t *digest, size_t dlen,
		   const uint8_t *sig, size_t siglen)
{
	n = strip (n, &nlen);
	e = strip (e, &elen);
	if (nlen > GK_RSA_MAX_BYTES || elen > nlen || siglen != nlen)
	{
		return 0;
	}

	mbedtls_rsa_context rsa;
	mbedtls_rsa_init (&rsa);
	uint8_t em[GK_RSA_MAX_BYTES], m[GK_RSA_MAX_BYTES];
	int valid = 0;

	if (   mbedtls_rsa_import_raw (&rsa, n, nlen, 0, 0, 0, 0, 0, 0, e, elen) == 0
	    && mbedtls_rsa_complete (&rsa) == 0
	    && mbedtls_rsa_check_pubkey (&rsa) == 0		/* n odd, e odd, 3 <= e < n */
	    && mbedtls_rsa_get_bitlen (&rsa) >= GK_RSA_MIN_BITS
	    && mbedtls_rsa_get_bitlen (&rsa) <= GK_RSA_MAX_BITS
	    && encode (hash, digest, dlen, em, nlen) == GK_RSA_OK
	    && mbedtls_rsa_public (&rsa, sig, m) == 0)		/* fails if sig >= n */
	{
		valid = equal (m, em, nlen);
	}

	mbedtls_rsa_free (&rsa);
	return valid;
}

/* Mbed TLS's wipes are GapKeep's (gk_mbedtls_config.h) */
void mbedtls_platform_zeroize (void *buf, size_t len)
{
	gk_wipe (buf, len);
}

static size_t unhex (const char *hex, uint8_t *out)
{
	size_t n = 0;
	for (; hex[0] && hex[1]; hex += 2)
	{
		int hi = hex[0] <= '9' ? hex[0] - '0' : hex[0] - 'a' + 10;
		int lo = hex[1] <= '9' ? hex[1] - '0' : hex[1] - 'a' + 10;
		out[n++] = (uint8_t) (hi << 4 | lo);
	}
	return n;
}

/* RSA-2048, made for this test with Python's cryptography (p < q, u = p^-1
   mod q, as OpenPGP), which also made the signatures. */
static const char TestN[] =
	"aed6cde9ccf7ae2d71234fb19de818fd17efef66176d31d89f89ef73db7f353b"
	"1aaad5a08e33087c9f7cd78904e8885b5f75961a3d8bb1b5ab5bb8de6b72fa1b"
	"a3f5b999898fabe568b5a712a84da0793baf8c71388b7133afb04eb9d0931be7"
	"e19dbe631bf81eaf379ff5d97c5eae92af8cd359cb76a1177f1eb2b4e2cf1c34"
	"a62834e5a5dcb699165e951c85bfa132f1cf53efa1ef69a11498c915680f6f69"
	"e37ebecc4cef857199b4e4bfe39ed894f2360263e226166a92a034ba8efdaf01"
	"5a426957ced27b0d55b95a9b2e755bc7a7493ccad7c37976a8ea520328558a1e"
	"a57b5fa8fd5d614824e3bc191f0dc35400f095afa4f2faf2173bf82576f881c3";
static const char TestD[] =
	"1c200cdecbec99f5d069e44387c9d2df3fef067d4f4e6f02d06341844b2e72f3"
	"2f8e84afffc000e0ff4cf76520c7814be596c64f31505c0583ebccd8e6c307ad"
	"d399cf41fe2980f6f5f9a6c72f10d1bc3ed83608ee962bdf2b277afa942d5e03"
	"56bd67e78c93c4e7ddd45b19a1d29f55946cdc80e8e48bf47a2c078666a7f77a"
	"d1d7784e323f04d9cb5779dc431df3006ce1ba87fbf8d16a6333c4ca708a940d"
	"979e203dc5ae41f906ae71343437779ef4117d1f53861f230f21675ee6951f9e"
	"8ee329318b809bfb680749e17497a2ba2ba3a7c21db975f2d5d5d4870b6b22c5"
	"ade3808d2e8d9a89380c50b464e7bcefe4b362b0813bca17e83798fa3dc57379";
static const char TestP[] =
	"b5c1125bc9d3eb8d5bff6531a997818834a34040169408693d617cb49ddde83b"
	"4d120741ec2e72993b0a599c3cd16fb116e281c7efcab574eaffe702f9cb7ad7"
	"2421aa16fbc440a6bc3b52785980e447316cc195f77c0fbc819b0f4ca3d06f5b"
	"89455d132ae6b3e3027d69ed30fb43d34570209c57e761876940afa0bd9177db";
static const char TestQ[] =
	"f64295ffa11220a2753ea1a09aa947c2bba9b493d677d14713404879c4c40f3b"
	"ce2c20e4b2ffb4ff7928cab849a66118e5cb1d398687f217baa0d6783e1b11d3"
	"2551a99cc417fd79a629c2d0b562a126ba1fc2467b3fc27f5583f82e2bfb2034"
	"b99204c10af0294d39de38ff5e5d3e7247e8d6ca9ff38a13d33b27730a581639";
static const char TestU[] =
	"2144cb7734882d588bfec08e257d27592082c68e5a46ee42aea1f0cc46e5f082"
	"2cfded7763e3b29331ab18ce9e8afb5ec192c32c2a8e074d4115b932d8a735bf"
	"40b4f09540495d4be16350421486943bbc67896b443cb1ae1c591e15f57204b3"
	"5b79787e569dfeecc501933eaa1782fcd30ba540068aa944293ca2d468633d17";
/* of SHA-256 ("abc") and SHA-1 ("abc") */
static const char TestSig256[] =
	"1c4edacec2123d904fa2763c72cc0a1ab366e51be724e291a3bf0e4e5602de94"
	"6d7e24e05d747ae1ac14b1e763d56d92241cf2d128e053e7a72c6dd1e1ed7f71"
	"6558af19e8d20b51232dde064195ba5081c7a2d37e4f4c99e9bd06a9953396c1"
	"27f3da7cf49749964a4c025181843903dd36b54193b3717634bebd5f53a13630"
	"457ed63b1f175cdbe77f01809f8ab2c1764e91180ad0003e5bf5796975923610"
	"b538cc2cbb1caab2bff1cdf1a9124504ceff355712349eea786cf94cd7423359"
	"6ea7ce8b7cc29008d8609031b32cd9ae096d4170512ae0f2009ef4e70ce4558a"
	"b943ff245e5f69b2fdadff052a9f0b42a9507ead77373f69c87e97e05846ba14";
static const char TestSig1[] =
	"99880ac4db77e770e75a555d2f1df58d5ec41d0cfe9f7af7ec705e9f5aad3623"
	"6082e96abaaac54a37e431030c838623f3a7ff67c4af0071c5dfebbbfd9babd4"
	"e3fdb1f555ac4d73f4e97ff762d3f716d4228e58163e5ecffa9b9cd99feb290a"
	"031c8106f39fbbed265da80230c4c4822aa4e644c58a6e3eb64c7f862af60a56"
	"3f75242ca60d3141026d23467ae0242bfb8e65fac63c7f0ef21f452e65a16748"
	"8722915e1d69abd8168b6f880daa8fd1442a5a79e485ba4e1d4bd6513f54ee5c"
	"06448305997083546a09ab38eaf798108f85362cdff2ad1fbcc25676236dc6fe"
	"02a0d9914cd60336ab7f1db986e8ac03177b3d22d107acee00c26cb778aac2b5";

int gk_rsa_selftest (gk_rsa_rng_t rng, void *rng_arg)
{
	static const uint8_t e[3] = { 0x01, 0x00, 0x01 };
	static const uint8_t sha256_abc[32] =
	{
		0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
		0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
	};
	static const uint8_t sha1_abc[20] =
	{
		0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e, 0x25, 0x71, 0x78, 0x50, 0xc2, 0x6c,
		0x9c, 0xd0, 0xd8, 0x9d,
	};
	static uint8_t n[256], d[256], p[128], q[128], u[128], sig[256], want[256];
	size_t nlen = unhex (TestN, n), dlen = unhex (TestD, d), plen = unhex (TestP, p);
	size_t qlen = unhex (TestQ, q), ulen = unhex (TestU, u);
	gk_rsa_key_t *key;
	int result = 0;

	if (gk_rsa_import (&key, n, nlen, e, 3, d, dlen, p, plen, q, qlen, u, ulen) != GK_RSA_OK)
	{
		return 1;
	}
	if (gk_rsa_bits (key) != 2048)
	{
		result = 2;
	}
	else if (gk_rsa_sign (key, &gk_hash_sha256, sha256_abc, 32, sig, rng, rng_arg) != GK_RSA_OK
		 || unhex (TestSig256, want) != 256 || memcmp (sig, want, 256) != 0)
	{
		result = 3;
	}
	else if (!gk_rsa_verify (n, nlen, e, 3, &gk_hash_sha256, sha256_abc, 32, sig, 256))
	{
		result = 4;
	}
	else if (gk_rsa_sign (key, &gk_hash_sha1, sha1_abc, 20, sig, rng, rng_arg) != GK_RSA_BAD_HASH)
	{
		result = 5;
	}
	gk_rsa_free (key);
	if (result != 0)
	{
		return result;
	}

	unhex (TestSig256, sig);
	sig[255] ^= 1;
	if (gk_rsa_verify (n, nlen, e, 3, &gk_hash_sha256, sha256_abc, 32, sig, 256))
	{
		return 6;
	}
	unhex (TestSig1, sig);
	if (   !gk_rsa_verify (n, nlen, e, 3, &gk_hash_sha1, sha1_abc, 20, sig, 256)
	    || gk_rsa_verify (n, nlen, e, 3, &gk_hash_sha256, sha256_abc, 32, sig, 256))
	{
		return 7;
	}

	/* d one off; u for the other prime (PKCS #1's q^-1 mod p) */
	d[dlen - 1] ^= 2;
	if (gk_rsa_import (&key, n, nlen, e, 3, d, dlen, p, plen, q, qlen, 0, 0) != GK_RSA_BAD_KEY)
	{
		return 8;
	}
	d[dlen - 1] ^= 2;
	if (gk_rsa_import (&key, n, nlen, e, 3, d, dlen, q, qlen, p, plen, u, ulen) != GK_RSA_BAD_KEY)
	{
		return 9;
	}

	gk_wipe (d, sizeof d);
	gk_wipe (p, sizeof p);
	gk_wipe (q, sizeof q);
	gk_wipe (u, sizeof u);
	return 0;
}
