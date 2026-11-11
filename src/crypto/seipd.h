/*
 * seipd.h - decrypting OpenPGP's Symmetrically Encrypted Integrity
 * Protected Data, version 1 (RFC 9580, 5.13.1), with AES: CFB with an
 * all-zero IV over a random prefix (16 bytes, the last two repeated),
 * the plaintext, and the Modification Detection Code packet (0xD3 0x14
 * and SHA-1 of everything before it). The plaintext is given only if the
 * MDC matches. The two repeated prefix bytes (the "quick check") play no
 * part in the decision: every failure is the same failure.
 *
 * In steps, for long messages. The old Symmetrically Encrypted Data
 * packet (tag 9, no integrity) has no counterpart here, on purpose.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SEIPD_H
#define GK_SEIPD_H

#include "sha1.h"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_SEIPD1_PREFIX	18	/* 16 random bytes, then their last two again */
#define GK_SEIPD1_MDC		22	/* 0xD3 0x14, SHA-1 */
#define GK_SEIPD1_MIN		(GK_SEIPD1_PREFIX + GK_SEIPD1_MDC)

/* Fields are private. */
typedef struct
{
	void *aes;			/* mbedtls_aes_context (heap) */
	uint8_t feedback[16];
	size_t offset;			/* in the feedback block */
	gk_sha1_t sha;
	uint8_t *buf;			/* the data, decrypted in place (heap) */
	size_t len, pos;		/* decrypted so far */
}
gk_seipd1_job_t;

/* Starts: data (the packet's body after its version octet 1) is copied.
   key: 16, 24 or 32 bytes (AES-128, -192, -256, the session key's
   algorithm). 0: started; -2: bad key length; -3: no memory; -4: shorter
   than GK_SEIPD1_MIN. On error nothing needs ending. */
int gk_seipd1_begin (gk_seipd1_job_t *job, const uint8_t *key, size_t keylen, const uint8_t *data, size_t len);

/* Decrypts and hashes about budget more bytes. 1: more to do; 0: done. */
int gk_seipd1_step (gk_seipd1_job_t *job, size_t budget);

double gk_seipd1_progress (const gk_seipd1_job_t *job);

/* Once done: 0 and *plain, *plainlen (inside the job: copy before end),
   if the MDC matches; -1 if not (*plain 0). */
int gk_seipd1_result (gk_seipd1_job_t *job, const uint8_t **plain, size_t *plainlen);

/* Wipes and frees everything. */
void gk_seipd1_end (gk_seipd1_job_t *job);

/* A message made by GnuPG (AES-128) decrypted, one changed byte in the
   ciphertext, the MDC or the prefix's quick check refused or not as it
   should. 0: OK. */
int gk_seipd1_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
