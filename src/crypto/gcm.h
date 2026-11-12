/*
 * gcm.h - GCM (NIST SP 800-38D) with AES, 96-bit nonces and 128-bit tags,
 * written from SP 800-38D over Mbed TLS's AES block, for OpenPGP's AEAD
 * (RFC 9580, 5.13.5). GHASH multiplies bit by bit, without tables and
 * without branches on the data: constant-time (and about 8 MB/s on a Pi
 * Zero). Streaming, as ocb.h.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_GCM_H
#define GK_GCM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_GCM_NONCE	12
#define GK_GCM_TAG	16

typedef struct
{
	void *enc;			/* mbedtls_aes_context (heap) */
	uint64_t h[2];			/* H = E_K(0), big-endian halves */
}
gk_gcm_key_t;

typedef struct
{
	uint8_t j0[16], ctr[16];
	uint64_t x[2];			/* GHASH so far */
	uint64_t adlen, clen;		/* bytes */
}
gk_gcm_t;

int gk_gcm_key_init (gk_gcm_key_t *key, const uint8_t *k, size_t klen);	/* 0; -2; -3 */
void gk_gcm_key_free (gk_gcm_key_t *key);

void gk_gcm_start (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t nonce[GK_GCM_NONCE],
		   const uint8_t *ad, size_t adlen);
/* whole blocks (a multiple of 16), in place allowed (out before in, too) */
void gk_gcm_encrypt_blocks (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t *in, uint8_t *out, size_t len);
void gk_gcm_decrypt_blocks (const gk_gcm_key_t *key, gk_gcm_t *st, const uint8_t *in, uint8_t *out, size_t len);
/* the last bytes (fewer than 16) and the tag; wipes st */
void gk_gcm_finish (const gk_gcm_key_t *key, gk_gcm_t *st, int decrypt, const uint8_t *in, uint8_t *out,
		    size_t len, uint8_t tag[GK_GCM_TAG]);

/* Five known answers made with Python's cryptography (AES-128, -192,
   -256; empty, partial and whole blocks), both ways. 0: OK. */
int gk_gcm_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
