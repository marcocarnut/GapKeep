/*
 * rsa.h - RSASSA-PKCS1-v1_5 signatures (RFC 8017, 8.2) over a digest the
 * caller computed, with 2048- to 4096-bit keys: what OpenPGP calls RSA
 * signatures. Mbed TLS's RSA underneath (third_party/mbedtls); the
 * encoding (EMSA-PKCS1-v1_5, with the DigestInfo of RFC 8017, 9.2, note
 * 1) is done here, and verification encodes and compares rather than
 * parsing what the signature holds.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_RSA_H
#define GK_RSA_H

#include "hmac.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GK_RSA_MIN_BITS		2048	/* keys to sign with */
#define GK_RSA_MIN_VERIFY_BITS	1024	/* old keys' signatures (weak) */
#define GK_RSA_MAX_BITS		4096
#define GK_RSA_MAX_BYTES	(GK_RSA_MAX_BITS / 8)

#define GK_RSA_OK		0
#define GK_RSA_BAD_SIZE		-1	/* the modulus is not 2048 to 4096 bits */
#define GK_RSA_BAD_KEY		-2	/* the numbers are not one RSA key */
#define GK_RSA_NO_MEMORY	-3
#define GK_RSA_BAD_HASH		-4	/* not a hash for this, or the digest's size is wrong */
#define GK_RSA_RNG		-5	/* the random generator failed (blinding) */
#define GK_RSA_FAULT		-6	/* the result failed its check: none given */
#define GK_RSA_BAD_CIPHERTEXT	-7	/* not as long as n, or not below n */

typedef struct gk_rsa_key gk_rsa_key_t;

/* Random bytes for blinding: 0 on success, as Mbed TLS's f_rng. */
typedef int (*gk_rsa_rng_t) (void *arg, unsigned char *out, size_t len);

/* A private key from its numbers, unsigned big-endian (leading zero bytes
   allowed): n, e, d, p, q, and optionally u = p^-1 mod q (OpenPGP's, RFC
   9580, 5.5.5.1: not PKCS #1's q^-1 mod p; ulen 0 if absent). Checks that
   n = pq, 1 < d, e < n, de = 1 mod p-1 and mod q-1, u if given, and that
   the CRT values (derived here) agree; p and q are not tested for being
   prime. *key is 0 unless GK_RSA_OK. */
int gk_rsa_import (gk_rsa_key_t **key, const uint8_t *n, size_t nlen, const uint8_t *e, size_t elen,
		   const uint8_t *d, size_t dlen, const uint8_t *p, size_t plen,
		   const uint8_t *q, size_t qlen, const uint8_t *u, size_t ulen);

/* Wipes and frees the key (0: nothing). */
void gk_rsa_free (gk_rsa_key_t *key);

/* The modulus's size in bits, and the public numbers (minimal big-endian,
   valid as long as the key is). */
unsigned gk_rsa_bits (const gk_rsa_key_t *key);
const uint8_t *gk_rsa_n (const gk_rsa_key_t *key, size_t *len);
const uint8_t *gk_rsa_e (const gk_rsa_key_t *key, size_t *len);

/* Signs digest (hash->digest_size bytes; SHA-224, SHA-256, SHA-384 or
   SHA-512: never SHA-1) into sig, (bits + 7) / 8 bytes. The private
   operation is blinded (random bytes from rng) and its result is checked
   against the public key, twice (Mbed TLS's check, then GapKeep's): a fault
   that gave a wrong signature, which could reveal the key, gives
   GK_RSA_FAULT and no signature. All at once: the steps below. */
int gk_rsa_sign (gk_rsa_key_t *key, const gk_hash_t *hash, const uint8_t *digest, size_t dlen,
		 uint8_t *sig, gk_rsa_rng_t rng, void *rng_arg);

/* The same in four steps, the longest one modular exponentiation of the
   CRT (half the work: about 200 ms for RSA-4096 on a Pi Zero). The key
   must stay alive until the end, and be signed with by one job at a time
   (its blinding values change at each signature). begin: GK_RSA_OK,
   GK_RSA_BAD_HASH or GK_RSA_NO_MEMORY (then *job is 0). step: 1, more to
   do; GK_RSA_OK, done (gk_rsa_job_result); GK_RSA_RNG or GK_RSA_FAULT,
   failed (no signature). end: wipes and frees (0: nothing). */
typedef struct gk_rsa_job gk_rsa_job_t;
/* (gk_rsa_job_step, _progress, _result and _end serve decryption too) */
int gk_rsa_sign_begin (gk_rsa_job_t **job, gk_rsa_key_t *key, const gk_hash_t *hash,
		       const uint8_t *digest, size_t dlen);
int gk_rsa_job_step (gk_rsa_job_t *job, gk_rsa_key_t *key, gk_rsa_rng_t rng, void *rng_arg);
double gk_rsa_job_progress (const gk_rsa_job_t *job);
const uint8_t *gk_rsa_job_result (const gk_rsa_job_t *job, size_t *len);
void gk_rsa_job_end (gk_rsa_job_t *job);

/* RSAES-PKCS1-v1_5 decryption (RFC 8017, 7.2.2) with implicit rejection
   (draft-irtf-cfrg-rsa-guidance-10, 7.2): c exactly as long as n, and
   below n, else GK_RSA_BAD_CIPHERTEXT (public facts, said at once). Bad
   padding is no error: the result is then a message derived from d and c,
   deterministic and unpredictable without the key, of a length from 0 to
   k - 11; the caller can't tell, and must check what it gets (OpenPGP's
   session key checksum, then the message's integrity). The private
   operation is the signature's (steps, blinding, checks). out: up to
   k - 11 bytes. */
int gk_rsa_decrypt (gk_rsa_key_t *key, const uint8_t *c, size_t clen, uint8_t *out, size_t *outlen,
		    gk_rsa_rng_t rng, void *rng_arg);
int gk_rsa_decrypt_begin (gk_rsa_job_t **job, gk_rsa_key_t *key, const uint8_t *c, size_t clen);

/* 1: sig (exactly as long as n) is a valid signature of digest under
   (n, e), with SHA-1 too; 0: not, or the key is not a 1024- to 4096-bit
   RSA public key, or the digest's size is wrong. (Below 2048 bits, keys
   are weak: for old signatures only.) */
int gk_rsa_verify (const uint8_t *n, size_t nlen, const uint8_t *e, size_t elen,
		   const gk_hash_t *hash, const uint8_t *digest, size_t dlen,
		   const uint8_t *sig, size_t siglen);

/* A fixed 2048-bit key: import, a SHA-256 signature compared with a known
   answer (PKCS #1 v1.5 is deterministic), verified, and failing when the
   digest changes; a known SHA-1 signature verified; a known ciphertext
   decrypted, one with bad padding giving its known synthetic message; an
   inconsistent key refused. 0: OK. */
int gk_rsa_selftest (gk_rsa_rng_t rng, void *rng_arg);

#ifdef __cplusplus
}
#endif

#endif
