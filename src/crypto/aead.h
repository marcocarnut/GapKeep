/*
 * aead.h - decrypting OpenPGP's chunked AEAD packets, in steps:
 *
 * - version 2 Symmetrically Encrypted and Integrity Protected Data
 *   (RFC 9580, 5.13.2; tag 18): the message key and IV from HKDF-SHA256
 *   (the session key, the 32-byte salt, the header as info); a chunk's
 *   nonce is the IV and its 8-byte index; its associated data the 5-byte
 *   header (0xD2, 2, cipher, AEAD mode, chunk size);
 * - GnuPG 2.4's OCB Encrypted Data packet (LibrePGP, draft-koch-librepgp,
 *   5.16; tag 20, version 1): the session key is the key; a chunk's nonce
 *   is the IV (as long as the nonce) xor its index; its associated data
 *   the 5-byte header (0xD4, 1, cipher, mode, chunk size) and the 8-byte
 *   index. LibrePGP allows OCB there and, to decrypt, EAX; not GCM.
 *
 * Both end with a final tag over the empty string whose associated data
 * also has the total plaintext length (8 bytes): a message cut after a
 * chunk is refused. Every chunk's tag and the final tag are checked
 * before any plaintext is given; every failure is the same failure.
 * AES only; AEAD modes: EAX (eax.h, 16-byte nonces), OCB (ocb.h, 15),
 * GCM (gcm.h, 12), behind one interface (aead.c).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_AEAD_H
#define GK_AEAD_H

#include "ocb.h"
#include "eax.h"
#include "gcm.h"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_AEAD_SEIPD2		18	/* RFC 9580 */
#define GK_AEAD_OCBED		20	/* GnuPG's (LibrePGP) */

#define GK_AEAD_EAX		1
#define GK_AEAD_OCB		2
#define GK_AEAD_GCM		3

struct gk_aead_mode;

/* Fields are private. */
typedef struct
{
	int packet;
	const struct gk_aead_mode *mode;
	union { gk_ocb_key_t ocb; gk_eax_key_t eax; gk_gcm_key_t gcm; } key;
	union { gk_ocb_t ocb; gk_eax_t eax; gk_gcm_t gcm; } st;
	uint8_t ad[21];			/* the chunk's associated data (OCB takes it last) */
	size_t adlen;
	uint8_t header[5];		/* the associated data's start */
	uint8_t iv[16];
	uint8_t *buf;			/* the encrypted data, then the plaintext (heap) */
	size_t len;			/* of the encrypted data, the final tag included */
	size_t chunk;			/* chunk size */
	size_t in, out;			/* read and written so far */
	size_t chunk_left;		/* ciphertext left in the chunk under way; 0: none */
	uint64_t index;			/* the chunk under way's */
	int active, done, failed;
}
gk_aead_job_t;

/* Starts: data is the packet's body after its version octet (2 for
   GK_AEAD_SEIPD2, 1 for GK_AEAD_OCBED), copied. key: the session key, as
   long as the cipher's (AES-128, -192, -256: 7, 8, 9). 0: started; -2: the
   key doesn't fit the cipher, or not AES; -3: no memory; -4: not such a
   packet (too short, chunk size octet above 16); -5: not an AEAD mode
   (EAX, OCB, GCM; in GK_AEAD_OCBED: OCB, EAX). On error nothing needs ending. */
int gk_aead_begin (gk_aead_job_t *job, int packet, const uint8_t *key, size_t keylen,
		   const uint8_t *data, size_t len);

/* Decrypts and checks about budget more bytes. 1: more to do; 0: done. */
int gk_aead_step (gk_aead_job_t *job, size_t budget);

double gk_aead_progress (const gk_aead_job_t *job);

/* Once done: 0 and the plaintext (inside the job), if every tag matched;
   -1 if not. */
int gk_aead_result (gk_aead_job_t *job, const uint8_t **plain, size_t *plainlen);

void gk_aead_end (gk_aead_job_t *job);		/* wipes and frees */

/* RFC 9580's sample v2 SEIPD packets with OCB (A.10.3), EAX (A.9.3) and
   GCM (A.11.3), decrypted, in steps too; a changed byte, a cut final tag,
   a missing last chunk refused. 0: OK. */
int gk_aead_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
