/*
 * sha1.c - SHA-1 (FIPS 180-4, 6.1), written from the standard.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sha1.h"
#include "hexcheck.h"
#include <string.h>

#define ROTL(x, n)	(((x) << (n)) | ((x) >> (32 - (n))))

static void compress (uint32_t state[5], const uint8_t block[64])
{
	uint32_t w[80];
	for (int t = 0; t < 16; t++)
	{
		w[t] =   (uint32_t) block[4*t] << 24 | (uint32_t) block[4*t+1] << 16
		       | (uint32_t) block[4*t+2] << 8 | (uint32_t) block[4*t+3];
	}
	for (int t = 16; t < 80; t++)
	{
		w[t] = ROTL (w[t-3] ^ w[t-8] ^ w[t-14] ^ w[t-16], 1);
	}

	uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];

	for (int t = 0; t < 80; t++)
	{
		uint32_t f, k;
		if (t < 20)
		{
			f = (b & c) ^ (~b & d);			/* Ch */
			k = 0x5a827999;
		}
		else if (t < 40)
		{
			f = b ^ c ^ d;				/* Parity */
			k = 0x6ed9eba1;
		}
		else if (t < 60)
		{
			f = (b & c) ^ (b & d) ^ (c & d);	/* Maj */
			k = 0x8f1bbcdc;
		}
		else
		{
			f = b ^ c ^ d;
			k = 0xca62c1d6;
		}
		uint32_t temp = ROTL (a, 5) + f + e + k + w[t];
		e = d; d = c; c = ROTL (b, 30); b = a; a = temp;
	}

	state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;

	memset (w, 0, sizeof w);
}

void gk_sha1_init (gk_sha1_t *ctx)
{
	static const uint32_t H0[5] =
	{
		0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
	};
	memcpy (ctx->state, H0, sizeof H0);
	ctx->length = 0;
	ctx->fill = 0;
}

void gk_sha1_update (gk_sha1_t *ctx, const void *data, size_t len)
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

void gk_sha1_final (gk_sha1_t *ctx, uint8_t digest[GK_SHA1_DIGEST_SIZE])
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

	for (int i = 0; i < 5; i++)
	{
		digest[4*i]   = (uint8_t) (ctx->state[i] >> 24);
		digest[4*i+1] = (uint8_t) (ctx->state[i] >> 16);
		digest[4*i+2] = (uint8_t) (ctx->state[i] >> 8);
		digest[4*i+3] = (uint8_t) (ctx->state[i]);
	}

	memset (ctx, 0, sizeof *ctx);	/* don't leave hashed secrets behind */
}

void gk_sha1 (const void *data, size_t len, uint8_t digest[GK_SHA1_DIGEST_SIZE])
{
	gk_sha1_t ctx;
	gk_sha1_init (&ctx);
	gk_sha1_update (&ctx, data, len);
	gk_sha1_final (&ctx, digest);
}

int gk_sha1_selftest (void)
{
	/* FIPS 180-4 examples (NIST CSRC "SHA1.pdf"), and "" */
	static const struct { const char *msg; const char *hex; } v[] =
	{
		{"", "da39a3ee5e6b4b0d3255bfef95601890afd80709"},
		{"abc", "a9993e364706816aba3e25717850c26c9cd0d89d"},
		{"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		 "84983e441c3bd26ebaae4aa1f95129e5e54670f1"},
		{"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
		 "a49b2446a02c645bf419f995b67091253a04a259"},
	};
	uint8_t d[GK_SHA1_DIGEST_SIZE];

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		gk_sha1 (v[i].msg, strlen (v[i].msg), d);
		if (!gk_hex_equal (d, sizeof d, v[i].hex))
		{
			return (int) i + 1;
		}
	}

	/* one million 'a', fed in uneven pieces to exercise buffering */
	gk_sha1_t ctx;
	char a[997];
	memset (a, 'a', sizeof a);
	gk_sha1_init (&ctx);
	size_t left = 1000000;
	while (left > 0)
	{
		size_t n = left < sizeof a ? left : sizeof a;
		gk_sha1_update (&ctx, a, n);
		left -= n;
	}
	gk_sha1_final (&ctx, d);
	if (!gk_hex_equal (d, sizeof d, "34aa973cd4c4daa4f61eeb2bdbad27316534016f"))
	{
		return 100;
	}

	return 0;
}
