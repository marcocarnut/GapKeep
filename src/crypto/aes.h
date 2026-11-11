/*
 * aes.h - AES-128/192/256 in CFB mode with a full-block (128-bit) feedback
 * (NIST SP 800-38A, 6.3), as OpenPGP uses it for protected secret keys
 * and integrity-protected data. Mbed TLS's AES underneath (third_party/
 * mbedtls).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_AES_H
#define GK_AES_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_AES_BLOCK_SIZE	16

/* Encrypts (decrypt 0) or decrypts len bytes, any length, no padding; in
   and out may be the same buffer. keylen: 16, 24 or 32. stop(arg) is asked
   after every 64 KiB whether to give up (may be 0). 0: done; -1: stopped,
   out is zeroed; -2: bad key length. */
int gk_aes_cfb (const uint8_t *key, size_t keylen, const uint8_t iv[GK_AES_BLOCK_SIZE], int decrypt,
		const uint8_t *in, uint8_t *out, size_t len, int (*stop) (void *), void *arg);

/* AES key wrap (RFC 3394, 2.2.1, with its default IV A6A6A6A6A6A6A6A6),
   as OpenPGP's ECDH wraps session keys (RFC 9580, 11.5). wrap: len a
   multiple of 8, at least 16, out len + 8 bytes. unwrap: len a multiple
   of 8, at least 24, out len - 8 bytes; the integrity value is checked
   without a shortcut. 0: done; -1: unwrap's integrity check failed, out
   zeroed; -2: bad key length; -4: bad data length. */
#define GK_AES_WRAP_OVERHEAD	8
int gk_aes_wrap (const uint8_t *kek, size_t keklen, const uint8_t *in, size_t len, uint8_t *out);
int gk_aes_unwrap (const uint8_t *kek, size_t keklen, const uint8_t *in, size_t len, uint8_t *out);

/* NIST SP 800-38A, F.3.13 to F.3.18 (CFB128 with each key size, both
   ways), and a message that is not whole blocks; RFC 3394, 4.1, 4.4 and
   4.6, wrapped and unwrapped, and a changed byte refused. 0: OK. */
int gk_aes_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
