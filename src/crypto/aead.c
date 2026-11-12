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

#define TAG		16
#define MAX_NONCE	16

/* --- the modes, behind one interface ------------------------------------ */

static int ocb_key (gk_aead_job_t *job, const uint8_t *k, size_t klen) { return gk_ocb_key_init (&job->key.ocb, k, klen); }
static void ocb_free (gk_aead_job_t *job) { gk_ocb_key_free (&job->key.ocb); }
static void ocb_start (gk_aead_job_t *job, const uint8_t *n, const uint8_t *ad, size_t adlen)
{
	/* OCB takes the associated data at the end: kept until then */
	memcpy (job->ad, ad, adlen);
	job->adlen = adlen;
	gk_ocb_start (&job->key.ocb, &job->st.ocb, n, GK_OCB_MAX_NONCE);
}
static void ocb_blocks (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len)
{
	gk_ocb_decrypt_blocks (&job->key.ocb, &job->st.ocb, in, out, len);
}
static void ocb_finish (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len, uint8_t tag[TAG])
{
	gk_ocb_finish (&job->key.ocb, &job->st.ocb, 1, in, out, len, job->ad, job->adlen, tag);
}

static int eax_key (gk_aead_job_t *job, const uint8_t *k, size_t klen) { return gk_eax_key_init (&job->key.eax, k, klen); }
static void eax_free (gk_aead_job_t *job) { gk_eax_key_free (&job->key.eax); }
static void eax_start (gk_aead_job_t *job, const uint8_t *n, const uint8_t *ad, size_t adlen)
{
	gk_eax_start (&job->key.eax, &job->st.eax, n, 16, ad, adlen);
}
static void eax_blocks (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len)
{
	gk_eax_decrypt_blocks (&job->key.eax, &job->st.eax, in, out, len);
}
static void eax_finish (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len, uint8_t tag[TAG])
{
	gk_eax_finish (&job->key.eax, &job->st.eax, 1, in, out, len, tag);
}

static int gcm_key (gk_aead_job_t *job, const uint8_t *k, size_t klen) { return gk_gcm_key_init (&job->key.gcm, k, klen); }
static void gcm_free (gk_aead_job_t *job) { gk_gcm_key_free (&job->key.gcm); }
static void gcm_start (gk_aead_job_t *job, const uint8_t *n, const uint8_t *ad, size_t adlen)
{
	gk_gcm_start (&job->key.gcm, &job->st.gcm, n, ad, adlen);
}
static void gcm_blocks (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len)
{
	gk_gcm_decrypt_blocks (&job->key.gcm, &job->st.gcm, in, out, len);
}
static void gcm_finish (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len, uint8_t tag[TAG])
{
	gk_gcm_finish (&job->key.gcm, &job->st.gcm, 1, in, out, len, tag);
}

struct gk_aead_mode
{
	uint8_t id;			/* RFC 9580's AEAD algorithm octet */
	uint8_t nonce;			/* bytes; SEIPD v2's IV is 8 fewer */
	uint8_t ocbed;			/* allowed in GnuPG's packet */
	int (*key) (gk_aead_job_t *job, const uint8_t *k, size_t klen);
	void (*free) (gk_aead_job_t *job);
	void (*start) (gk_aead_job_t *job, const uint8_t *nonce, const uint8_t *ad, size_t adlen);
	void (*blocks) (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len);
	void (*finish) (gk_aead_job_t *job, const uint8_t *in, uint8_t *out, size_t len, uint8_t tag[TAG]);
};

/* LibrePGP (draft-koch-librepgp-06, 5.16) allows OCB and, for decryption,
   EAX in its packet; GCM only in SEIPD v2 */
static const struct gk_aead_mode Modes[] =
{
	{ GK_AEAD_EAX, 16, 1, eax_key, eax_free, eax_start, eax_blocks, eax_finish },
	{ GK_AEAD_OCB, 15, 1, ocb_key, ocb_free, ocb_start, ocb_blocks, ocb_finish },
	{ GK_AEAD_GCM, 12, 0, gcm_key, gcm_free, gcm_start, gcm_blocks, gcm_finish },
};

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
	const struct gk_aead_mode *m = 0;
	for (unsigned i = 0; i < sizeof Modes / sizeof Modes[0]; i++)
	{
		if (Modes[i].id == mode && (packet != GK_AEAD_OCBED || Modes[i].ocbed))
		{
			m = &Modes[i];
		}
	}
	if (m == 0)
	{
		return -5;
	}
	if (c > 16)
	{
		return -4;
	}
	size_t head = packet == GK_AEAD_SEIPD2 ? 3 + 32 : 3 + (size_t) m->nonce;
	if (len < head + TAG)
	{
		return -4;
	}

	job->packet = packet;
	job->mode = m;
	job->header[0] = packet == GK_AEAD_SEIPD2 ? 0xd2 : 0xd4;	/* new-format packet tag octet */
	job->header[1] = packet == GK_AEAD_SEIPD2 ? 2 : 1;		/* version */
	job->header[2] = cipher;
	job->header[3] = mode;
	job->header[4] = c;
	job->chunk = (size_t) 1 << (c + 6);

	int result;
	if (packet == GK_AEAD_SEIPD2)
	{
		/* message key and IV (the nonce less 8 bytes) from HKDF-SHA256 */
		uint8_t okm[32 + MAX_NONCE - 8];
		gk_hkdf (&gk_hash_sha256, data + 3, 32, key, keylen, job->header, 5, okm, keylen + m->nonce - 8);
		memcpy (job->iv, okm + keylen, m->nonce - 8u);
		result = m->key (job, okm, keylen);
		gk_wipe (okm, sizeof okm);
	}
	else if (packet == GK_AEAD_OCBED)
	{
		memcpy (job->iv, data + 3, m->nonce);
		result = m->key (job, key, keylen);
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
		m->free (job);
		return -3;
	}
	memcpy (job->buf, data + head, job->len);
	return 0;
}

static void nonce (const gk_aead_job_t *job, uint64_t index, uint8_t n[MAX_NONCE])
{
	uint8_t i[8];
	size_t len = job->mode->nonce;
	be64 (i, index);
	if (job->packet == GK_AEAD_SEIPD2)
	{
		memcpy (n, job->iv, len - 8);		/* IV || index */
		memcpy (n + len - 8, i, 8);
	}
	else
	{
		memcpy (n, job->iv, len);		/* IV xor index */
		for (int k = 0; k < 8; k++)
		{
			n[len - 8 + k] ^= i[k];
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
	uint8_t n[MAX_NONCE], a[21], tag[TAG];
	const struct gk_aead_mode *m = job->mode;
	size_t enclen = job->len - TAG;		/* the chunks, without the final tag */

	if (budget < 16) budget = 16;
	while (!job->done && budget > 0)
	{
		if (!job->active)
		{
			if (job->in == enclen)
			{
				/* the final tag: over the empty string, the total length */
				nonce (job, job->index, n);
				m->start (job, n, a, ad (job, job->index, 1, a));
				m->finish (job, 0, 0, 0, tag);
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
			m->start (job, n, a, ad (job, job->index, 0, a));
			job->active = 1;
		}

		/* whole blocks, as many as the budget allows */
		size_t blocks = job->chunk_left / 16 * 16;
		if (blocks > budget) blocks = budget / 16 * 16;
		m->blocks (job, job->buf + job->in, job->buf + job->out, blocks);
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
		m->finish (job, job->buf + job->in, job->buf + job->out, last, tag);
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
		job->mode->free (job);
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
	/* RFC 9580, A.9.3 and A.9.4 (EAX), A.11.3 and A.11.4 (GCM): the
	   session key, the packet's body after its version octet, the
	   plaintext */
	static const char *const Other[][3] =
	{
		{ "3881bafe985412459b86c36f98cb9a5e",
		  "0701069ff90e3b321964f3a42913c8dcc6619325015227efb7eaeaa49f04c2e674175d4a3d226ed6afcb9ca9ac122c1470e11c"
		  "63d4c0ab241c6a938ad48bf99a5a99b90bba8325de61047540258ab7959a95ad051dda96eb15431dfef5f5e2255ca78261546e339a",
		  "cb1362000000000048656c6c6f2c20776f726c6421d50eae5bf0cd6705500355816cb0c8ff" },
		{ "1936fc8568980274bb900d8319360c77",
		  "070306fcb94490bcb98bbdc9d106c6090266940f72e89edc21b5596b1576b101ed0f9ffc6fc6d65bbfd24dcd0790966e6d1e85"
		  "a30053784cb1d8b6a0699ef12155a7b2ad6258531b57651fd7777912fa95e35d9b40216f69a4c248db28ff4331f1632907399e6ff9",
		  "cb1362000000000048656c6c6f2c20776f726c6421d50e1ce2269a9eddef81032172b7ed7c" },
	};
	/* RFC 9580, A.10.3 and A.10.4 (OCB): the packet's body after its
	   version octet; the session key; the plaintext (a literal data
	   packet, "Hello, world!", and a padding packet) */
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

	for (unsigned i = 0; i < 2; i++)
	{
		uint8_t k[16], d[128];
		unhex (Other[i][0], k);
		size_t l = unhex (Other[i][1], d);
		if (decrypt (k, d, l, Other[i][2], 16) != 0) return 7 + 2 * (int) i;
		d[50] ^= 1;
		if (decrypt (k, d, l, Other[i][2], 4096) != 1) return 8 + 2 * (int) i;
	}
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
