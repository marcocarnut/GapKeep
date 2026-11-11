/*
 * s2k.h - OpenPGP's string-to-key specifiers (RFC 9580, 3.7.1): simple
 * (type 0), salted (1) and iterated and salted (3), over the hashes of
 * hmac.h. What turns a passphrase into the key that protects an OpenPGP
 * secret key (or a symmetrically encrypted message).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_S2K_H
#define GK_S2K_H

#include "hmac.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GK_S2K_SIMPLE		0
#define GK_S2K_SALTED		1
#define GK_S2K_ITERATED		3

#define GK_S2K_SALT_SIZE	8

/* The number of bytes type 3 hashes for a coded count octet c:
   (16 + (c & 15)) << ((c >> 4) + 6), 1024 to 65011712. */
uint32_t gk_s2k_count (uint8_t coded);

/* Derives outlen bytes (outlen > 0). salt: 8 bytes for types 1 and 3,
   ignored (may be 0) for type 0; coded_count only for type 3. When outlen
   is more than one digest, more hashes run, the i-th (from 0) preloaded
   with i zero bytes, and their outputs are concatenated (RFC 9580,
   3.7.1). Type 3 hashes the salt and passphrase repeated until the count
   is reached (all of them once if they are longer), without ever holding
   more than a 1 KiB buffer of them. stop(arg) is asked after every MiB
   hashed whether to give up (may be 0). 0: done; -1: stopped, out is
   zeroed; -2: no such type. */
int gk_s2k (const gk_hash_t *hash, int type, const void *passphrase, size_t passlen,
	    const uint8_t *salt, uint8_t coded_count, uint8_t *out, size_t outlen,
	    int (*stop) (void *), void *arg);

/* Known answers (made with an independent implementation: tools/check_pgp.py
   compares many more), small counts only: the RFC 9580 examples hash 62 MiB
   each, which takes seconds on a Pi Zero (tests/apps/pgpcrypto checks
   them). 0: OK. */
int gk_s2k_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
