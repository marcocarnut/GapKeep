/*
 * aead.c - OpenPGP's chunked AEAD packets, decrypted in steps (see aead.h).
 *
 * The data is decrypted in place: each chunk's plaintext is written where
 * the ciphertext began, behind what is still to be read, so the buffer
 * ends up holding the plaintext alone, given only once the final tag
 * matched.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "aead.h"
#include "hmac.h"
#include "wipe.h"
#include "hexcheck.h"
#include <stdlib.h>
#include <string.h>

#define TAG		GK_OCB_TAG_SIZE
#define OCB_NONCE	15

static void be64 (uint8_t *out, uint64_t x)
{
	for (int i = 0; i < 8; i++)
	{
		out[i] = (uint8_t) (x >> (56 - 8 * i));
	}
}

int gk_aead_begin (gk_aead_job_t *job, int packet, const uint8_t *key, size_t keylen,
		   const uint8_t *data, size_t len)
{
	memset (job, 0, sizeof *job);
	/* cipher, mode, chunk size octet, then salt (32) or IV (OCB: 15) */
	if (len < 3)
	{
		return -4;
	}
	uint8_t cipher = data[0], mode = data[1], c = data[2];
	size_t want = cipher == 7 ? 16 : cipher == 8 ? 24 : cipher == 9 ? 32 : 0;
	if (want == 0 || keylen != want)
	{
		return -2;
	}
	if (mode != GK_AEAD_OCB)
	{
		return -5;
	}
	if (c > 16)
	{
		return -4;
	}
	size_t head = packet == GK_AEAD_SEIPD2 ? 3 + 32 : 3 + OCB_NONCE;
	if (len < head + TAG)
	{
		return -4;
	}

	job->packet = packet;
	job->header[0] = packet == GK_AEAD_SEIPD2 ? 0xd2 : 0xd4;	/* new-format packet tag octet */
	job->header[1] = packet == GK_AEAD_SEIPD2 ? 2 : 1;		/* version */
	job->header[2] = cipher;
	job->header[3] = mode;
	job->header[4] = c;
	job->chunk = (size_t) 1 << (c + 6);

	int result;
	if (packet == GK_AEAD_SEIPD2)
	{
		/* message key and IV (OCB: 15 - 8 = 7 bytes) from HKDF-SHA256 */
		uint8_t okm[32 + OCB_NONCE - 8];
		gk_hkdf (&gk_hash_sha256, data + 3, 32, key, keylen, job->header, 5, okm, keylen + OCB_NONCE - 8);
		memcpy (job->iv, okm + keylen, OCB_NONCE - 8);
		result = gk_ocb_key_init (&job->key, okm, keylen);
		gk_wipe (okm, sizeof okm);
	}
	else if (packet == GK_AEAD_OCBED)
	{
		memcpy (job->iv, data + 3, OCB_NONCE);
		result = gk_ocb_key_init (&job->key, key, keylen);
	}
	else
	{
		return -4;
	}
	if (result != 0)
	{
		return result;
	}

	job->len = len - head;
	job->buf = malloc (job->len);
	if (job->buf == 0)
	{
		gk_ocb_key_free (&job->key);
		return -3;
	}
	memcpy (job->buf, data + head, job->len);
	return 0;
}

static void nonce (const gk_aead_job_t *job, uint64_t index, uint8_t n[OCB_NONCE])
{
	uint8_t i[8];
	be64 (i, index);
	if (job->packet == GK_AEAD_SEIPD2)
	{
		memcpy (n, job->iv, OCB_NONCE - 8);		/* IV || index */
		memcpy (n + OCB_NONCE - 8, i, 8);
	}
	else
	{
		memcpy (n, job->iv, OCB_NONCE);			/* IV xor index */
		for (int k = 0; k < 8; k++)
		{
			n[OCB_NONCE - 8 + k] ^= i[k];
		}
	}
}

/* the associated data: the header, the index (OCBED), the total (final) */
static size_t ad (const gk_aead_job_t *job, uint64_t index, int final, uint8_t out[21])
{
	size_t n = 5;
	memcpy (out, job->header, 5);
	if (job->packet == GK_AEAD_OCBED)
	{
		be64 (out + n, index);
		n += 8;
	}
	if (final)
	{
		be64 (out + n, job->out);
		n += 8;
	}
	return n;
}

static int tag_ok (const uint8_t *a, const uint8_t *b)
{
	uint8_t diff = 0;
	for (int i = 0; i < TAG; i++)
	{
		diff |= a[i] ^ b[i];
	}
	return diff == 0;
}

int gk_aead_step (gk_aead_job_t *job, size_t budget)
{
	uint8_t n[OCB_NONCE], a[21], tag[TAG];
	size_t enclen = job->len - TAG;		/* the chunks, without the final tag */

	if (budget < 16) budget = 16;
	while (!job->done && budget > 0)
	{
		if (!job->active)
		{
			if (job->in == enclen)
			{
				/* the final tag: over the empty string, the total length */
				gk_ocb_t st;
				nonce (job, job->index, n);
				gk_ocb_start (&job->key, &st, n, OCB_NONCE);
				gk_ocb_finish (&job->key, &st, 1, 0, 0, 0, a, ad (job, job->index, 1, a), tag);
				if (!tag_ok (tag, job->buf + enclen))
				{
					job->failed = 1;
				}
				job->done = 1;
				break;
			}
			size_t left = enclen - job->in;
			if (left < TAG)
			{
				job->failed = 1;		/* a chunk without its tag */
				job->done = 1;
				break;
			}
			job->chunk_left = left - TAG < job->chunk ? left - TAG : job->chunk;
			nonce (job, job->index, n);
			gk_ocb_start (&job->key, &job->st, n, OCB_NONCE);
			job->active = 1;
		}

		/* whole blocks, as many as the budget allows */
		size_t blocks = job->chunk_left / 16 * 16;
		if (blocks > budget) blocks = budget / 16 * 16;
		gk_ocb_decrypt_blocks (&job->key, &job->st, job->buf + job->in, job->buf + job->out, blocks);
		job->in += blocks;
		job->out += blocks;
		job->chunk_left -= blocks;
		budget = budget > blocks ? budget - blocks : 0;
		if (job->chunk_left >= 16)
		{
			if (budget < 16)
			{
				break;			/* the budget is spent */
			}
			continue;
		}

		/* the chunk's last bytes and its tag */
		size_t last = job->chunk_left;
		gk_ocb_finish (&job->key, &job->st, 1, job->buf + job->in, job->buf + job->out, last,
			       a, ad (job, job->index, 0, a), tag);
		job->in += last;
		job->out += last;
		if (!tag_ok (tag, job->buf + job->in))
		{
			job->failed = 1;
			job->done = 1;
			break;
		}
		job->in += TAG;
		job->index++;
		job->active = 0;
		budget = budget > 16 ? budget - 16 : 0;
	}
	gk_wipe (tag, sizeof tag);
	return !job->done;
}

double gk_aead_progress (const gk_aead_job_t *job)
{
	return job->len > 0 ? (double) job->in / (double) job->len : 0;
}

int gk_aead_result (gk_aead_job_t *job, const uint8_t **plain, size_t *plainlen)
{
	*plain = 0;
	*plainlen = 0;
	if (job->buf == 0 || !job->done || job->failed)
	{
		return -1;
	}
	*plain = job->buf;
	*plainlen = job->out;
	return 0;
}

void gk_aead_end (gk_aead_job_t *job)
{
	if (job->buf != 0)
	{
		gk_ocb_key_free (&job->key);
		gk_wipe (job->buf, job->len);
		free (job->buf);
	}
	gk_wipe (job, sizeof *job);
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

/* 0: decrypted to want; 1: refused; -1: something else */
static int decrypt (const uint8_t *key, const uint8_t *data, size_t len, const char *want, size_t budget)
{
	gk_aead_job_t job;
	if (gk_aead_begin (&job, GK_AEAD_SEIPD2, key, 16, data, len) != 0)
	{
		return -1;
	}
	while (gk_aead_step (&job, budget))
	{
	}
	const uint8_t *plain;
	size_t plainlen;
	int result = gk_aead_result (&job, &plain, &plainlen) == 0 ? (gk_hex_equal (plain, plainlen, want) ? 0 : -1) : 1;
	gk_aead_end (&job);
	return result;
}

int gk_aead_selftest (void)
{
	/* RFC 9580, A.10.3 and A.10.4: the packet's body after its version
	   octet; the session key; the plaintext (a literal data packet,
	   "Hello, world!", and a padding packet) */
	static const char Data[] =
		"07020620a661f731fc9a3032b5623326027e3a5d8db5748ebeff0b0c5910d09e"
		"cdd641ff9fd38562758035bc49754ce1bf3fffa7dad0a3b8104f5133cf42a4100a"
		"83eef4ca1b4801a8846bf42bcda7c8ce9d65e212f301cbcd98fdcade694a877ad4"
		"247323f6e857";
	static const char Plain[] =
		"cb1362000000000048656c6c6f2c20776f726c6421d50eae6aa1649b56aa835b2613902bd2";
	uint8_t key[16], data[128];
	unhex ("28e79ab82397d3c63de24ac217d7b791", key);
	size_t len = unhex (Data, data);

	if (decrypt (key, data, len, Plain, 4096) != 0) return 1;
	if (decrypt (key, data, len, Plain, 16) != 0) return 2;		/* block by block */
	data[40] ^= 1;
	if (decrypt (key, data, len, Plain, 4096) != 1) return 3;	/* the ciphertext */
	data[40] ^= 1;
	data[len - 1] ^= 1;
	if (decrypt (key, data, len, Plain, 4096) != 1) return 4;	/* the final tag */
	data[len - 1] ^= 1;
	if (decrypt (key, data, len - 16, Plain, 4096) != 1) return 5;	/* no final tag */
	/* no chunk: only the final tag, after the salt */
	memmove (data + 35, data + len - 16, 16);
	if (decrypt (key, data, 35 + 16, "", 4096) != 1) return 6;
	return 0;
}
