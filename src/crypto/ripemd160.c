/*
 * ripemd160.c - RIPEMD-160, written from the authors' description
 * ("RIPEMD-160: A Strengthened Version of RIPEMD", Dobbertin, Bosselaers,
 * Preneel, 1996, Appendix A: the pseudo-code and its tables).
 *
 * Like MD4, it reads words and the length little-endian.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "ripemd160.h"
#include "wipe.h"
#include "sha256.h"
#include "hexcheck.h"
#include <string.h>

#define ROTL(x, n)	(((x) << (n)) | ((x) >> (32 - (n))))

/* f(j, x, y, z) for rounds of 16 steps: j / 16 */
static uint32_t f (int round, uint32_t x, uint32_t y, uint32_t z)
{
	switch (round)
	{
	case 0:	 return x ^ y ^ z;
	case 1:	 return (x & y) | (~x & z);
	case 2:	 return (x | ~y) ^ z;
	case 3:	 return (x & z) | (y & ~z);
	default: return x ^ (y | ~z);
	}
}

static const uint32_t KL[5] = { 0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e };
static const uint32_t KR[5] = { 0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000 };

/* which word each step reads: r (left line), r' (right line) */
static const uint8_t RL[80] =
{
	 0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15,
	 7,  4, 13,  1, 10,  6, 15,  3, 12,  0,  9,  5,  2, 14, 11,  8,
	 3, 10, 14,  4,  9, 15,  8,  1,  2,  7,  0,  6, 13, 11,  5, 12,
	 1,  9, 11, 10,  0,  8, 12,  4, 13,  3,  7, 15, 14,  5,  6,  2,
	 4,  0,  5,  9,  7, 12,  2, 10, 14,  1,  3,  8, 11,  6, 15, 13,
};
static const uint8_t RR[80] =
{
	 5, 14,  7,  0,  9,  2, 11,  4, 13,  6, 15,  8,  1, 10,  3, 12,
	 6, 11,  3,  7,  0, 13,  5, 10, 14, 15,  8, 12,  4,  9,  1,  2,
	15,  5,  1,  3,  7, 14,  6,  9, 11,  8, 12,  2, 10,  0,  4, 13,
	 8,  6,  4,  1,  3, 11, 15,  0,  5, 12,  2, 13,  9,  7, 10, 14,
	12, 15, 10,  4,  1,  5,  8,  7,  6,  2, 13, 14,  0,  3,  9, 11,
};

/* rotation amounts: s (left), s' (right) */
static const uint8_t SL[80] =
{
	11, 14, 15, 12,  5,  8,  7,  9, 11, 13, 14, 15,  6,  7,  9,  8,
	 7,  6,  8, 13, 11,  9,  7, 15,  7, 12, 15,  9, 11,  7, 13, 12,
	11, 13,  6,  7, 14,  9, 13, 15, 14,  8, 13,  6,  5, 12,  7,  5,
	11, 12, 14, 15, 14, 15,  9,  8,  9, 14,  5,  6,  8,  6,  5, 12,
	 9, 15,  5, 11,  6,  8, 13, 12,  5, 12, 13, 14, 11,  8,  5,  6,
};
static const uint8_t SR[80] =
{
	 8,  9,  9, 11, 13, 15, 15,  5,  7,  7,  8, 11, 14, 14, 12,  6,
	 9, 13, 15,  7, 12,  8,  9, 11,  7,  7, 12,  7,  6, 15, 13, 11,
	 9,  7, 15, 11,  8,  6,  6, 14, 12, 13,  5, 14, 13, 13,  7,  5,
	15,  5,  8, 11, 14, 14,  6, 14,  6,  9, 12,  9, 12,  5, 15,  8,
	 8,  5, 12,  9, 12,  5, 14,  6,  8, 13,  6,  5, 15, 13, 11, 11,
};

static void compress (uint32_t h[5], const uint8_t block[64])
{
	uint32_t x[16];
	for (int i = 0; i < 16; i++)
	{
		x[i] =   (uint32_t) block[4*i] | (uint32_t) block[4*i+1] << 8
		       | (uint32_t) block[4*i+2] << 16 | (uint32_t) block[4*i+3] << 24;
	}

	uint32_t al = h[0], bl = h[1], cl = h[2], dl = h[3], el = h[4];
	uint32_t ar = h[0], br = h[1], cr = h[2], dr = h[3], er = h[4];

	for (int j = 0; j < 80; j++)
	{
		int round = j / 16;

		uint32_t t = ROTL (al + f (round, bl, cl, dl) + x[RL[j]] + KL[round], SL[j]) + el;
		al = el; el = dl; dl = ROTL (cl, 10); cl = bl; bl = t;

		t = ROTL (ar + f (4 - round, br, cr, dr) + x[RR[j]] + KR[round], SR[j]) + er;
		ar = er; er = dr; dr = ROTL (cr, 10); cr = br; br = t;
	}

	uint32_t t = h[1] + cl + dr;
	h[1] = h[2] + dl + er;
	h[2] = h[3] + el + ar;
	h[3] = h[4] + al + br;
	h[4] = h[0] + bl + cr;
	h[0] = t;

	gk_wipe (x, sizeof x);
}

void gk_ripemd160_init (gk_ripemd160_t *ctx)
{
	static const uint32_t H0[5] =
	{
		0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
	};
	memcpy (ctx->state, H0, sizeof H0);
	ctx->length = 0;
	ctx->fill = 0;
}

void gk_ripemd160_update (gk_ripemd160_t *ctx, const void *data, size_t len)
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

void gk_ripemd160_final (gk_ripemd160_t *ctx, uint8_t digest[GK_RIPEMD160_DIGEST_SIZE])
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
		ctx->block[56 + i] = (uint8_t) (bits >> (8 * i));
	}
	compress (ctx->state, ctx->block);

	for (int i = 0; i < 5; i++)
	{
		digest[4*i]   = (uint8_t) (ctx->state[i]);
		digest[4*i+1] = (uint8_t) (ctx->state[i] >> 8);
		digest[4*i+2] = (uint8_t) (ctx->state[i] >> 16);
		digest[4*i+3] = (uint8_t) (ctx->state[i] >> 24);
	}

	gk_wipe (ctx, sizeof *ctx);
}

void gk_ripemd160 (const void *data, size_t len, uint8_t digest[GK_RIPEMD160_DIGEST_SIZE])
{
	gk_ripemd160_t ctx;
	gk_ripemd160_init (&ctx);
	gk_ripemd160_update (&ctx, data, len);
	gk_ripemd160_final (&ctx, digest);
}

void gk_hash160 (const void *data, size_t len, uint8_t digest[GK_RIPEMD160_DIGEST_SIZE])
{
	uint8_t h[GK_SHA256_DIGEST_SIZE];
	gk_sha256 (data, len, h);
	gk_ripemd160 (h, sizeof h, digest);
	gk_wipe (h, sizeof h);
}

int gk_ripemd160_selftest (int full)
{
	/* the authors' test vectors (the RIPEMD-160 page, homes.esat.kuleuven.be/~bosselae) */
	static const struct { const char *msg; const char *hex; } v[] =
	{
		{"", "9c1185a5c5e9fc54612808977ee8f548b2258d31"},
		{"a", "0bdc9d2d256b3ee9daae347be6f4dc835a467ffe"},
		{"abc", "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"},
		{"message digest", "5d0689ef49d2fae572b881b123a85ffa21595f36"},
		{"abcdefghijklmnopqrstuvwxyz", "f71c27109c692c1b56bbdceb5b9d2865b3708dbc"},
		{"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		 "12a053384a9c0c88e405a06c27dcf49ada62eb2b"},
		{"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
		 "b0e20b6e3116640286ed3a87a5713079b21f5189"},
		{"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
		 "9b752e45573d4b39f4dbd3323cab82bf63326bfb"},
	};
	uint8_t d[GK_RIPEMD160_DIGEST_SIZE];

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		gk_ripemd160 (v[i].msg, strlen (v[i].msg), d);
		if (!gk_hex_equal (d, sizeof d, v[i].hex))
		{
			return (int) i + 1;
		}
	}

	if (!full)
	{
		return 0;
	}

	gk_ripemd160_t ctx;
	char a[997];
	memset (a, 'a', sizeof a);
	gk_ripemd160_init (&ctx);
	size_t left = 1000000;
	while (left > 0)
	{
		size_t n = left < sizeof a ? left : sizeof a;
		gk_ripemd160_update (&ctx, a, n);
		left -= n;
	}
	gk_ripemd160_final (&ctx, d);
	if (!gk_hex_equal (d, sizeof d, "52783243c1697bdbe16d37f97f68f08325dc1528"))
	{
		return 100;
	}

	return 0;
}
