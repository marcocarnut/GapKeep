/*
 * ed25519.h - Ed25519 (RFC 8032, 5.1: "pure" EdDSA on edwards25519 with
 * SHA-512), Monocypher's (third_party/monocypher).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_ED25519_H
#define GK_ED25519_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_ED25519_SEED_SIZE		32	/* RFC 8032's private key */
#define GK_ED25519_SECRET_SIZE		64	/* the seed, then the public key */
#define GK_ED25519_PUBLIC_SIZE		32
#define GK_ED25519_SIGNATURE_SIZE	64

/* The signing key (seed and public key) and the public key of a seed. */
void gk_ed25519_keypair (const uint8_t seed[GK_ED25519_SEED_SIZE],
			 uint8_t secret[GK_ED25519_SECRET_SIZE], uint8_t pub[GK_ED25519_PUBLIC_SIZE]);

/* Signs msg (any length, may be 0), then checks the signature against the
   public key: a fault during signing that gave a wrong signature (which
   with a deterministic nonce could reveal the key) is caught here.
   0: signed; -1: the check failed, sig is zeroed. */
int gk_ed25519_sign (const uint8_t secret[GK_ED25519_SECRET_SIZE], const void *msg, size_t len,
		     uint8_t sig[GK_ED25519_SIGNATURE_SIZE]);

/* 1: valid (RFC 8032, 5.1.7; S must be below the group order); 0: not. */
int gk_ed25519_verify (const uint8_t sig[GK_ED25519_SIGNATURE_SIZE], const uint8_t pub[GK_ED25519_PUBLIC_SIZE],
		       const void *msg, size_t len);

/* RFC 8032, 7.1, tests 1 to 3; RFC 9580's sample signature (A.2: a
   digest signed as the message); and a signature that must fail. 0: OK. */
int gk_ed25519_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
