/*
 * eax.h - EAX (Bellare, Rogaway and Wagner, "The EAX Mode of Operation",
 * 2004) with AES and 128-bit tags, written from the paper over Mbed TLS's
 * AES block: CTR and OMAC (CMAC, NIST SP 800-38B), for OpenPGP's AEAD
 * (RFC 9580, 5.13.3). Any nonce length (OpenPGP's: 16). Streaming, as
 * ocb.h.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_EAX_H
#define GK_EAX_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_EAX_TAG	16

typedef struct
{
	void *enc;			/* mbedtls_aes_context (heap) */
	uint8_t k1[16], k2[16];		/* CMAC's subkeys */
}
gk_eax_key_t;

typedef struct
{
	uint8_t n[16], h[16];		/* OMAC^0 (nonce), OMAC^1 (header) */
	uint8_t ctr[16];
	uint8_t x[16];			/* OMAC^2 (ciphertext) so far */
	uint8_t last[16];		/* its last block, held back */
	size_t lastlen;
}
gk_eax_t;

int gk_eax_key_init (gk_eax_key_t *key, const uint8_t *k, size_t klen);	/* 0; -2: bad length; -3: no memory */
void gk_eax_key_free (gk_eax_key_t *key);			/* wipes */

void gk_eax_start (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *nonce, size_t nlen,
		   const uint8_t *ad, size_t adlen);
/* whole blocks (a multiple of 16); in place allowed (out before in, too) */
void gk_eax_encrypt_blocks (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *in, uint8_t *out, size_t len);
void gk_eax_decrypt_blocks (const gk_eax_key_t *key, gk_eax_t *st, const uint8_t *in, uint8_t *out, size_t len);
/* the last bytes (fewer than 16, may be 0) and the tag; wipes st */
void gk_eax_finish (const gk_eax_key_t *key, gk_eax_t *st, int decrypt, const uint8_t *in, uint8_t *out,
		    size_t len, uint8_t tag[GK_EAX_TAG]);

/* The ten test vectors of the EAX paper (AES-128), both ways, in whole
   blocks and the rest. 0: OK. */
int gk_eax_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
