/*
 * argon2.c - Argon2id in steps (see argon2.h).
 *
 * From Monocypher 4.0.3's crypto_argon2 (monocypher.c, "Argon2"),
 * Copyright (c) 2017-2023 Loup Vaillant, Copyright (c) 2017-2019 Michael
 * Savage, Copyright (c) 2017-2023 Fabio Scotoni; BSD-2-Clause or CC0-1.0
 * (third_party/monocypher/LICENCE.md). The compression function (G, the
 * rounds), H0, H' and the block indexing are Monocypher's, as it has them;
 * the loops over passes, slices, lanes and blocks are a resumable state
 * here, in the same order. Argon2id only (Monocypher's i and d not kept).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "argon2.h"
#include "wipe.h"
#include "hexcheck.h"
#include <monocypher.h>
#include <string.h>

typedef gk_argon2_block_t blk;
typedef uint8_t u8;
typedef uint32_t u32;
typedef uint64_t u64;

#define ARGON2ID	2		/* RFC 9106's y */

enum { FILLING, WIPING, DONE };

static void store32_le (u8 out[4], u32 in)
{
	out[0] = (u8) in; out[1] = (u8) (in >> 8); out[2] = (u8) (in >> 16); out[3] = (u8) (in >> 24);
}

static u64 load64_le (const u8 s[8])
{
	u64 x = 0;
	for (int i = 7; i >= 0; i--) x = x << 8 | s[i];
	return x;
}

static void store64_le (u8 out[8], u64 in)
{
	for (int i = 0; i < 8; i++) out[i] = (u8) (in >> (8 * i));
}

static u64 rotr64 (u64 x, u64 n) { return (x >> n) ^ (x << (64 - n)); }

/* updates a BLAKE2 hash with a 32 bit word, little endian */
static void blake_update_32 (crypto_blake2b_ctx *ctx, u32 input)
{
	u8 buf[4];
	store32_le (buf, input);
	crypto_blake2b_update (ctx, buf, 4);
	gk_wipe (buf, sizeof buf);
}

static void blake_update_32_buf (crypto_blake2b_ctx *ctx, const u8 *buf, u32 size)
{
	blake_update_32 (ctx, size);
	crypto_blake2b_update (ctx, buf, size);
}

static void copy_block (blk *o, const blk *in) { for (int i = 0; i < 128; i++) o->a[i] = in->a[i]; }
static void xor_block (blk *o, const blk *in) { for (int i = 0; i < 128; i++) o->a[i] ^= in->a[i]; }

/* H': a hash of any length (RFC 9106, 3.3) */
static void extended_hash (u8 *digest, u32 digest_size, const u8 *input, u32 input_size)
{
	crypto_blake2b_ctx ctx;
	crypto_blake2b_init (&ctx, digest_size < 64 ? digest_size : 64);
	blake_update_32 (&ctx, digest_size);
	crypto_blake2b_update (&ctx, input, input_size);
	crypto_blake2b_final (&ctx, digest);

	if (digest_size > 64)
	{
		u32 r = (u32) (((u64) digest_size + 31) >> 5) - 2;
		u32 i = 1, in = 0, out = 32;
		while (i < r)
		{
			/* input and output overlap: intentional */
			crypto_blake2b (digest + out, 64, digest + in, 64);
			i += 1;
			in += 32;
			out += 32;
		}
		crypto_blake2b (digest + out, digest_size - (32 * r), digest + in, 64);
	}
}

#define LSB(x) ((u64) (u32) x)
#define G(a, b, c, d)	\
	a += b + ((LSB (a) * LSB (b)) << 1);  d ^= a;  d = rotr64 (d, 32); \
	c += d + ((LSB (c) * LSB (d)) << 1);  b ^= c;  b = rotr64 (b, 24); \
	a += b + ((LSB (a) * LSB (b)) << 1);  d ^= a;  d = rotr64 (d, 16); \
	c += d + ((LSB (c) * LSB (d)) << 1);  b ^= c;  b = rotr64 (b, 63)
#define ROUND(v0,  v1,  v2,  v3,  v4,  v5,  v6,  v7,	\
	      v8,  v9, v10, v11, v12, v13, v14, v15)	\
	G (v0, v4,  v8, v12);  G (v1, v5,  v9, v13); \
	G (v2, v6, v10, v14);  G (v3, v7, v11, v15); \
	G (v0, v5, v10, v15);  G (v1, v6, v11, v12); \
	G (v2, v7,  v8, v13);  G (v3, v4,  v9, v14)

/* the core of the compression function G: Z from R, in place */
static void g_rounds (blk *b)
{
	for (int i = 0; i < 128; i += 16)
	{
		ROUND (b->a[i   ], b->a[i+ 1], b->a[i+ 2], b->a[i+ 3],
		       b->a[i+ 4], b->a[i+ 5], b->a[i+ 6], b->a[i+ 7],
		       b->a[i+ 8], b->a[i+ 9], b->a[i+10], b->a[i+11],
		       b->a[i+12], b->a[i+13], b->a[i+14], b->a[i+15]);
	}
	for (int i = 0; i < 16; i += 2)
	{
		ROUND (b->a[i   ], b->a[i+ 1], b->a[i+ 16], b->a[i+ 17],
		       b->a[i+32], b->a[i+33], b->a[i+ 48], b->a[i+ 49],
		       b->a[i+64], b->a[i+65], b->a[i+ 80], b->a[i+ 81],
		       b->a[i+96], b->a[i+97], b->a[i+112], b->a[i+113]);
	}
}

uint32_t gk_argon2_blocks (uint32_t memory_kib, uint32_t lanes)
{
	return lanes == 0 ? 0 : memory_kib / (4 * lanes) * 4 * lanes;
}

int gk_argon2_begin (gk_argon2_job_t *job, void *work, uint32_t passes, uint32_t lanes, uint32_t memory_kib,
		     const void *password, size_t passlen, const void *salt, size_t saltlen,
		     const void *key, size_t keylen, const void *ad, size_t adlen, uint32_t outlen)
{
	memset (job, 0, sizeof *job);
	if (   passes < 1 || lanes < 1 || lanes > 0xffffff || memory_kib < 8 * lanes
	    || outlen < 4 || outlen > GK_ARGON2_MAX_OUT
	    || passlen > 0xffffffffu || saltlen > 0xffffffffu || keylen > 0xffffffffu || adlen > 0xffffffffu)
	{
		return -4;
	}
	job->blocks = (blk *) work;
	job->segment_size = memory_kib / lanes / 4;
	job->lane_size = job->segment_size * 4;
	job->nb_blocks = job->lane_size * lanes;
	job->lanes = lanes;
	job->passes = passes;
	job->outlen = outlen;

	/* H0, then the first two blocks of each lane */
	u8 initial_hash[72];
	crypto_blake2b_ctx ctx;
	crypto_blake2b_init (&ctx, 64);
	blake_update_32 (&ctx, lanes);
	blake_update_32 (&ctx, outlen);
	blake_update_32 (&ctx, memory_kib);
	blake_update_32 (&ctx, passes);
	blake_update_32 (&ctx, 0x13);			/* v: version 1.3 */
	blake_update_32 (&ctx, ARGON2ID);
	blake_update_32_buf (&ctx, (const u8 *) password, (u32) passlen);
	blake_update_32_buf (&ctx, (const u8 *) salt, (u32) saltlen);
	blake_update_32_buf (&ctx, (const u8 *) key, (u32) keylen);
	blake_update_32_buf (&ctx, (const u8 *) ad, (u32) adlen);
	crypto_blake2b_final (&ctx, initial_hash);

	u8 hash_area[1024];
	for (u32 l = 0; l < lanes; l++)
	{
		for (u32 i = 0; i < 2; i++)
		{
			store32_le (initial_hash + 64, i);
			store32_le (initial_hash + 68, l);
			extended_hash (hash_area, 1024, initial_hash, 72);
			for (int k = 0; k < 128; k++)
			{
				job->blocks[l * job->lane_size + i].a[k] = load64_le (hash_area + 8 * k);
			}
		}
	}
	gk_wipe (initial_hash, sizeof initial_hash);
	gk_wipe (hash_area, sizeof hash_area);
	gk_wipe (&ctx, sizeof ctx);

	job->constant_time = 1;		/* Argon2id: the first half of the first pass */
	job->block = 2;			/* blocks 0 and 1 are filled */
	job->index_ctr = 1;
	job->phase = FILLING;
	return 0;
}

/* one block: the body of Monocypher's innermost loop */
static void fill_block (gk_argon2_job_t *job, blk *tmp)
{
	const u32 pass = job->pass, slice = job->slice, segment = job->lane, block = job->block;
	const u32 segment_size = job->segment_size, lane_size = job->lane_size;
	const u32 pass_offset = pass == 0 && slice == 0 ? 2 : 0;
	const u32 slice_offset = slice * segment_size;

	u32 lane_offset = segment * lane_size;
	blk *segment_start = job->blocks + lane_offset + slice_offset;
	blk *current = segment_start + block;
	blk *previous = block == 0 && slice_offset == 0 ? segment_start + lane_size - 1 : segment_start + block - 1;

	u64 index_seed;
	if (job->constant_time)
	{
		if (block == pass_offset || (block % 128) == 0)
		{
			/* fill or refresh the block of deterministic indices */
			memset (job->index_block.a, 0, sizeof job->index_block.a);
			job->index_block.a[0] = pass;
			job->index_block.a[1] = segment;
			job->index_block.a[2] = slice;
			job->index_block.a[3] = job->nb_blocks;
			job->index_block.a[4] = job->passes;
			job->index_block.a[5] = ARGON2ID;
			job->index_block.a[6] = job->index_ctr;
			job->index_ctr++;

			copy_block (tmp, &job->index_block);
			g_rounds (&job->index_block);
			xor_block (&job->index_block, tmp);
			copy_block (tmp, &job->index_block);
			g_rounds (&job->index_block);
			xor_block (&job->index_block, tmp);
		}
		index_seed = job->index_block.a[block % 128];
	}
	else
	{
		index_seed = previous->a[0];
	}

	/* the reference set: about the last 3 slices, and what is done of
	   this segment */
	u32 next_slice = ((slice + 1) % 4) * segment_size;
	u32 window_start = pass == 0 ? 0 : next_slice;
	u32 nb_segments = pass == 0 ? slice : 3;
	u32 lane = pass == 0 && slice == 0 ? segment : (u32) (index_seed >> 32) % job->lanes;
	u32 window_size = nb_segments * segment_size + (lane == segment ? block - 1 : block == 0 ? (u32) -1 : 0);

	u64 j1 = index_seed & 0xffffffff;
	u64 x = (j1 * j1) >> 32;
	u64 y = (window_size * x) >> 32;
	u64 z = (window_size - 1) - y;
	u32 ref = (u32) ((window_start + z) % lane_size);
	blk *reference = job->blocks + lane * lane_size + ref;

	copy_block (tmp, previous);
	xor_block (tmp, reference);
	if (pass == 0) copy_block (current, tmp);
	else xor_block (current, tmp);
	g_rounds (tmp);
	xor_block (current, tmp);
}

/* the next position: blocks, then lanes, slices, passes */
static int advance (gk_argon2_job_t *job)
{
	if (++job->block < job->segment_size)
	{
		return 1;
	}
	job->block = 0;
	job->index_ctr = 1;
	if (++job->lane < job->lanes)
	{
		if (job->pass == 0 && job->slice == 0)
		{
			job->block = 2;		/* each lane's first two blocks are filled */
		}
		return 1;
	}
	job->lane = 0;
	if (++job->slice < 4)
	{
		/* Argon2id indexes from the data after the first two slices */
		if (job->slice == 2 && job->pass == 0)
		{
			job->constant_time = 0;
		}
		return 1;
	}
	job->slice = 0;
	return ++job->pass < job->passes;
}

static void finish (gk_argon2_job_t *job)
{
	/* the last blocks of the lanes, xored; H' of that */
	blk *last_block = job->blocks + job->lane_size - 1;
	for (u32 lane = 1; lane < job->lanes; lane++)
	{
		blk *next_block = last_block + job->lane_size;
		xor_block (next_block, last_block);
		last_block = next_block;
	}
	u8 final_block[1024];
	for (int k = 0; k < 128; k++)
	{
		store64_le (final_block + 8 * k, last_block->a[k]);
	}
	extended_hash (job->out, job->outlen, final_block, 1024);
	gk_wipe (final_block, sizeof final_block);
	job->phase = WIPING;
}

int gk_argon2_step (gk_argon2_job_t *job, uint32_t budget)
{
	blk tmp;
	while (budget > 0 && job->phase == FILLING)
	{
		if (job->block >= job->segment_size)
		{
			/* a first segment with only its two filled blocks (the
			   smallest memory): nothing to fill in it */
			job->block = job->segment_size - 1;
			if (!advance (job))
			{
				finish (job);
			}
			continue;
		}
		fill_block (job, &tmp);
		budget--;
		if (!advance (job))
		{
			finish (job);
		}
	}
	gk_wipe (&tmp, sizeof tmp);
	if (job->phase == WIPING)
	{
		/* the work area, budget blocks a step (wiped at four times the
		   speed of filling them) */
		size_t n = (size_t) budget * 4 + 64;
		if (n > job->nb_blocks - job->wiped) n = job->nb_blocks - job->wiped;
		gk_wipe (job->blocks + job->wiped, n * sizeof (blk));
		job->wiped += n;
		if (job->wiped == job->nb_blocks)
		{
			job->phase = DONE;
		}
	}
	return job->phase != DONE;
}

double gk_argon2_progress (const gk_argon2_job_t *job)
{
	if (job->phase != FILLING)
	{
		return job->nb_blocks ? 0.97 + 0.03 * (double) job->wiped / (double) job->nb_blocks : 1;
	}
	double per_pass = (double) job->nb_blocks;
	double done = (double) job->pass * per_pass
		      + (double) job->slice * job->segment_size * job->lanes
		      + (double) job->lane * job->segment_size + job->block;
	return 0.97 * done / (per_pass * job->passes);
}

void gk_argon2_end (gk_argon2_job_t *job)
{
	gk_wipe (job, sizeof *job);
}

int gk_argon2_selftest_step (gk_argon2_selftest_t *st, void *work, uint32_t budget)
{
	static const u8 salt[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
	u8 p[32], s[16], k[8], a[12];
	switch (st->stage)
	{
	case 0:
		/* RFC 9106, 5.3 */
		memset (p, 1, 32);
		memset (s, 2, 16);
		memset (k, 3, 8);
		memset (a, 4, 12);
		if (gk_argon2_begin (&st->job, work, 3, 4, 32, p, 32, s, 16, k, 8, a, 12, 32) != 0)
		{
			return -1;
		}
		st->stage = 1;
		return 1;
	case 1:
		if (gk_argon2_step (&st->job, budget))
		{
			return 1;
		}
		if (!gk_hex_equal (st->job.out, 32, "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"))
		{
			gk_argon2_end (&st->job);
			return -2;
		}
		gk_argon2_end (&st->job);
		/* S2K type 4: "password", salt 00..0f, t 1, p 4, 2^6 KiB, 16
		   bytes (the reference implementation's answer) */
		if (gk_argon2_begin (&st->job, work, 1, 4, 1 << 6, "password", 8, salt, 16, 0, 0, 0, 0, 16) != 0)
		{
			return -3;
		}
		st->stage = 2;
		return 1;
	case 2:
		if (gk_argon2_step (&st->job, budget))
		{
			return 1;
		}
		{
			int ok = gk_hex_equal (st->job.out, 16, "637a25b4e2fd12a663f85ebbce4d8cc7");
			gk_argon2_end (&st->job);
			st->stage = 3;
			return ok ? 0 : -4;
		}
	default:
		return 0;
	}
}
