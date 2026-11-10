/*
 * sha512.c - SHA-512 (FIPS 180-4, 6.4), written from the standard.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sha512.h"
#include "wipe.h"
#include "hexcheck.h"
#include <string.h>

static const uint64_t K[80] =
{
	0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
	0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
	0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
	0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
	0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
	0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
	0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
	0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
	0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
	0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
	0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
	0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
	0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
	0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
	0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
	0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
	0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
	0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
	0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
	0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL,
};

#define ROTR(x, n)	(((x) >> (n)) | ((x) << (64 - (n))))
#define CH(x, y, z)	(((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z)	(((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BSIG0(x)	(ROTR (x, 28) ^ ROTR (x, 34) ^ ROTR (x, 39))
#define BSIG1(x)	(ROTR (x, 14) ^ ROTR (x, 18) ^ ROTR (x, 41))
#define SSIG0(x)	(ROTR (x, 1) ^ ROTR (x, 8) ^ ((x) >> 7))
#define SSIG1(x)	(ROTR (x, 19) ^ ROTR (x, 61) ^ ((x) >> 6))

static void compress (uint64_t state[8], const uint8_t block[128])
{
	uint64_t w[80];
	for (int t = 0; t < 16; t++)
	{
		uint64_t x = 0;
		for (int i = 0; i < 8; i++)
		{
			x = x << 8 | block[8*t + i];
		}
		w[t] = x;
	}
	for (int t = 16; t < 80; t++)
	{
		w[t] = SSIG1 (w[t-2]) + w[t-7] + SSIG0 (w[t-15]) + w[t-16];
	}

	uint64_t a = state[0], b = state[1], c = state[2], d = state[3];
	uint64_t e = state[4], f = state[5], g = state[6], h = state[7];

	for (int t = 0; t < 80; t++)
	{
		uint64_t t1 = h + BSIG1 (e) + CH (e, f, g) + K[t] + w[t];
		uint64_t t2 = BSIG0 (a) + MAJ (a, b, c);
		h = g; g = f; f = e; e = d + t1;
		d = c; c = b; b = a; a = t1 + t2;
	}

	state[0] += a; state[1] += b; state[2] += c; state[3] += d;
	state[4] += e; state[5] += f; state[6] += g; state[7] += h;

	gk_wipe (w, sizeof w);
}

void gk_sha512_init (gk_sha512_t *ctx)
{
	static const uint64_t H0[8] =
	{
		0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
		0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL,
	};
	memcpy (ctx->state, H0, sizeof H0);
	ctx->length = 0;
	ctx->fill = 0;
}

void gk_sha512_update (gk_sha512_t *ctx, const void *data, size_t len)
{
	const uint8_t *p = data;
	ctx->length += len;

	while (len > 0)
	{
		size_t n = 128 - ctx->fill;
		if (n > len)
		{
			n = len;
		}
		memcpy (ctx->block + ctx->fill, p, n);
		ctx->fill += n;
		p += n;
		len -= n;

		if (ctx->fill == 128)
		{
			compress (ctx->state, ctx->block);
			ctx->fill = 0;
		}
	}
}

void gk_sha512_final (gk_sha512_t *ctx, uint8_t digest[GK_SHA512_DIGEST_SIZE])
{
	/* the length is 128 bits; the high 64 are zero here, but for the top
	   three bits of the byte count */
	uint64_t bits_low = ctx->length << 3;
	uint64_t bits_high = ctx->length >> 61;

	ctx->block[ctx->fill++] = 0x80;
	if (ctx->fill > 112)
	{
		memset (ctx->block + ctx->fill, 0, 128 - ctx->fill);
		compress (ctx->state, ctx->block);
		ctx->fill = 0;
	}
	memset (ctx->block + ctx->fill, 0, 112 - ctx->fill);
	for (int i = 0; i < 8; i++)
	{
		ctx->block[112 + i] = (uint8_t) (bits_high >> (56 - 8 * i));
		ctx->block[120 + i] = (uint8_t) (bits_low >> (56 - 8 * i));
	}
	compress (ctx->state, ctx->block);

	for (int i = 0; i < 8; i++)
	{
		for (int j = 0; j < 8; j++)
		{
			digest[8*i + j] = (uint8_t) (ctx->state[i] >> (56 - 8 * j));
		}
	}

	gk_wipe (ctx, sizeof *ctx);	/* don't leave hashed secrets behind */
}

void gk_sha512 (const void *data, size_t len, uint8_t digest[GK_SHA512_DIGEST_SIZE])
{
	gk_sha512_t ctx;
	gk_sha512_init (&ctx);
	gk_sha512_update (&ctx, data, len);
	gk_sha512_final (&ctx, digest);
}

int gk_sha512_selftest (void)
{
	/* FIPS 180-4 examples (NIST CSRC "SHA512.pdf"), and "" */
	static const struct { const char *msg; const char *hex; } v[] =
	{
		{"", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce"
		     "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"},
		{"abc", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
			"2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"},
		{"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
		 "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018"
		 "501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909"},
	};
	uint8_t d[GK_SHA512_DIGEST_SIZE];

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		gk_sha512 (v[i].msg, strlen (v[i].msg), d);
		if (!gk_hex_equal (d, sizeof d, v[i].hex))
		{
			return (int) i + 1;
		}
	}

	/* one million 'a', fed in uneven pieces to exercise buffering */
	gk_sha512_t ctx;
	char a[997];
	memset (a, 'a', sizeof a);
	gk_sha512_init (&ctx);
	size_t left = 1000000;
	while (left > 0)
	{
		size_t n = left < sizeof a ? left : sizeof a;
		gk_sha512_update (&ctx, a, n);
		left -= n;
	}
	gk_sha512_final (&ctx, d);
	if (!gk_hex_equal (d, sizeof d,
			   "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973eb"
			   "de0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b"))
	{
		return 100;
	}

	return 0;
}
