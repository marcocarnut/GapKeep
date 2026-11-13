/*
 * ocb.h - OCB (RFC 7253, OCB3) with AES and 128-bit tags, written from the
 * RFC over Mbed TLS's AES block (third_party/mbedtls), for OpenPGP's AEAD
 * (RFC 9580, 5.13.4; GnuPG's OCB packet). Streaming: blocks in, blocks out,
 * so that a long message can be done in steps.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_OCB_H
#define GK_OCB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_OCB_TAG_SIZE		16
#define GK_OCB_MAX_NONCE	15

/* The key's tables (L_*, L_$, L_i). Fields are private. */
typedef struct
{
	void *enc, *dec;		/* mbedtls_aes_context (heap) */
	uint8_t lstar[16], ldollar[16], l[32][16];
}
gk_ocb_key_t;

/* One message under way. Fields are private. */
typedef struct
{
	uint8_t offset[16], checksum[16];
	uint64_t blocks;		/* full blocks done */
}
gk_ocb_t;

/* 0; -2: bad key length; -3: no memory (nothing to free). */
int gk_ocb_key_init (gk_ocb_key_t *key, const uint8_t *k, size_t klen);
void gk_ocb_key_free (gk_ocb_key_t *key);		/* wipes */

/* A message with this nonce (1 to 15 bytes). */
void gk_ocb_start (const gk_ocb_key_t *key, gk_ocb_t *st, const uint8_t *nonce, size_t nlen);

/* Whole blocks (len a multiple of 16); in and out may be the same, or out
   before in (in place, moving down). */
void gk_ocb_encrypt_blocks (const gk_ocb_key_t *key, gk_ocb_t *st, const uint8_t *in, uint8_t *out, size_t len);
void gk_ocb_decrypt_blocks (const gk_ocb_key_t *key, gk_ocb_t *st, const uint8_t *in, uint8_t *out, size_t len);

/* The last bytes (fewer than 16, may be 0), and the tag over them and the
   associated data. Wipes st. */
void gk_ocb_finish (const gk_ocb_key_t *key, gk_ocb_t *st, int decrypt, const uint8_t *in, uint8_t *out,
		    size_t len, const uint8_t *ad, size_t adlen, uint8_t tag[GK_OCB_TAG_SIZE]);

/* All at once. decrypt: 0, or -1 if the tag is wrong (out zeroed); the
   tag compared without a shortcut. */
void gk_ocb_encrypt (const gk_ocb_key_t *key, const uint8_t *nonce, size_t nlen, const uint8_t *ad, size_t adlen,
		     const uint8_t *in, uint8_t *out, size_t len, uint8_t tag[GK_OCB_TAG_SIZE]);
int gk_ocb_decrypt (const gk_ocb_key_t *key, const uint8_t *nonce, size_t nlen, const uint8_t *ad, size_t adlen,
		    const uint8_t *in, uint8_t *out, size_t len, const uint8_t tag[GK_OCB_TAG_SIZE]);

/* RFC 7253, Appendix A: the sixteen samples, both ways, and a changed tag
   refused. 0: OK. */
int gk_ocb_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
