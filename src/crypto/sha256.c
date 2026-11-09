/*
 * sha256.c - SHA-256 (FIPS 180-4), written from the standard.
 *
 * Plain portable C with no dependencies, so it can be built and tested on
 * the development machine as well (tests/native/test_sha256.c).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sha256.h"
#include <string.h>

static const uint32_t K[64] =
{
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROTR(x, n)	(((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z)	(((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z)	(((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BSIG0(x)	(ROTR (x, 2) ^ ROTR (x, 13) ^ ROTR (x, 22))
#define BSIG1(x)	(ROTR (x, 6) ^ ROTR (x, 11) ^ ROTR (x, 25))
#define SSIG0(x)	(ROTR (x, 7) ^ ROTR (x, 18) ^ ((x) >> 3))
#define SSIG1(x)	(ROTR (x, 17) ^ ROTR (x, 19) ^ ((x) >> 10))

static void compress (uint32_t state[8], const uint8_t block[64])
{
	uint32_t w[64];
	for (int t = 0; t < 16; t++)
	{
		w[t] =   (uint32_t) block[4*t] << 24 | (uint32_t) block[4*t+1] << 16
		       | (uint32_t) block[4*t+2] << 8 | (uint32_t) block[4*t+3];
	}
	for (int t = 16; t < 64; t++)
	{
		w[t] = SSIG1 (w[t-2]) + w[t-7] + SSIG0 (w[t-15]) + w[t-16];
	}

	uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
	uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

	for (int t = 0; t < 64; t++)
	{
		uint32_t t1 = h + BSIG1 (e) + CH (e, f, g) + K[t] + w[t];
		uint32_t t2 = BSIG0 (a) + MAJ (a, b, c);
		h = g; g = f; f = e; e = d + t1;
		d = c; c = b; b = a; a = t1 + t2;
	}

	state[0] += a; state[1] += b; state[2] += c; state[3] += d;
	state[4] += e; state[5] += f; state[6] += g; state[7] += h;

	memset (w, 0, sizeof w);
}

void gk_sha256_init (gk_sha256_t *ctx)
{
	static const uint32_t H0[8] =
	{
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	};
	memcpy (ctx->state, H0, sizeof H0);
	ctx->length = 0;
	ctx->fill = 0;
}

void gk_sha256_update (gk_sha256_t *ctx, const void *data, size_t len)
{
	const uint8_t *p = data;
	ctx->length += len;

	while (len > 0)
	{
		size_t n = 64 - ctx->fill;
		if (n > len)
		{
			n = len;
		}
		memcpy (ctx->block + ctx->fill, p, n);
		ctx->fill += n;
		p += n;
		len -= n;

		if (ctx->fill == 64)
		{
			compress (ctx->state, ctx->block);
			ctx->fill = 0;
		}
	}
}

void gk_sha256_final (gk_sha256_t *ctx, uint8_t digest[GK_SHA256_DIGEST_SIZE])
{
	uint64_t bits = ctx->length * 8;

	ctx->block[ctx->fill++] = 0x80;
	if (ctx->fill > 56)
	{
		memset (ctx->block + ctx->fill, 0, 64 - ctx->fill);
		compress (ctx->state, ctx->block);
		ctx->fill = 0;
	}
	memset (ctx->block + ctx->fill, 0, 56 - ctx->fill);
	for (int i = 0; i < 8; i++)
	{
		ctx->block[56 + i] = (uint8_t) (bits >> (56 - 8 * i));
	}
	compress (ctx->state, ctx->block);

	for (int i = 0; i < 8; i++)
	{
		digest[4*i]   = (uint8_t) (ctx->state[i] >> 24);
		digest[4*i+1] = (uint8_t) (ctx->state[i] >> 16);
		digest[4*i+2] = (uint8_t) (ctx->state[i] >> 8);
		digest[4*i+3] = (uint8_t) (ctx->state[i]);
	}

	memset (ctx, 0, sizeof *ctx);	/* don't leave hashed secrets behind */
}

void gk_sha256 (const void *data, size_t len, uint8_t digest[GK_SHA256_DIGEST_SIZE])
{
	gk_sha256_t ctx;
	gk_sha256_init (&ctx);
	gk_sha256_update (&ctx, data, len);
	gk_sha256_final (&ctx, digest);
}

static int hex_equal (const uint8_t *digest, const char *hex)
{
	static const char digits[] = "0123456789abcdef";
	for (int i = 0; i < 32; i++)
	{
		if (hex[2*i] != digits[digest[i] >> 4] || hex[2*i+1] != digits[digest[i] & 15])
		{
			return 0;
		}
	}
	return 1;
}

int gk_sha256_selftest (void)
{
	/* FIPS 180-4 examples (NIST CSRC "SHA256.pdf", "SHA2_Additional.pdf") */
	static const struct { const char *msg; const char *hex; } v[] =
	{
		{"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
		{"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		 "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"},
		{"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
		 "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"},
	};
	uint8_t d[32];

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		gk_sha256 (v[i].msg, strlen (v[i].msg), d);
		if (!hex_equal (d, v[i].hex))
		{
			return (int) i + 1;
		}
	}

	/* one million 'a', fed in uneven pieces to exercise buffering */
	gk_sha256_t ctx;
	char a[997];
	memset (a, 'a', sizeof a);
	gk_sha256_init (&ctx);
	size_t left = 1000000;
	while (left > 0)
	{
		size_t n = left < sizeof a ? left : sizeof a;
		gk_sha256_update (&ctx, a, n);
		left -= n;
	}
	gk_sha256_final (&ctx, d);
	if (!hex_equal (d, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"))
	{
		return 100;
	}

	return 0;
}
