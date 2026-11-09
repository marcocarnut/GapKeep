/*
 * secp.h - secp256k1 for gk:crypto: ECDSA, BIP-340 Schnorr signatures and
 * the key arithmetic of BIP-32 and Taproot (BIP-341), on byte arrays, over
 * libsecp256k1 (third_party/secp256k1, lib/secp256k1/secp256k1.mk).
 *
 * Keys: private keys are 32 bytes, big-endian, 1 to n-1; public keys are
 * SEC 1 encoded, 33 bytes (compressed) or 65; x-only keys (BIP-340) are 32.
 * Every function returns 1 on success and 0 on bad input (a private key
 * out of range, a point not on the curve, a tweak that gives the point at
 * infinity), and leaves no secret in its stack variables.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SECP_H
#define GK_SECP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_SECP_DER_MAX		72	/* a DER-encoded ECDSA signature */

/* Creates the context and blinds it with 32 random bytes (side-channel
   protection; any bytes are correct, random ones are safer), then runs
   gk_secp_selftest. 0: OK; else the self-test's code, and every function
   below fails. Call once. */
int gk_secp_init (const uint8_t seed[32]);

int gk_secp_seckey_verify (const uint8_t seckey[32]);

/* out: 33 bytes if compressed, else 65. */
int gk_secp_pubkey_create (const uint8_t seckey[32], int compressed, uint8_t *out);

/* Parses any SEC 1 encoding, writes it compressed (33) or not (65). */
int gk_secp_pubkey_convert (const uint8_t *pubkey, size_t len, int compressed, uint8_t *out);

/* (seckey + tweak) mod n: BIP-32's private child keys. */
int gk_secp_seckey_tweak_add (const uint8_t seckey[32], const uint8_t tweak[32], uint8_t out[32]);

/* pubkey + tweak*G: BIP-32's public child keys. */
int gk_secp_pubkey_tweak_add (const uint8_t *pubkey, size_t len, const uint8_t tweak[32],
			      int compressed, uint8_t *out);

/* ECDSA of a 32-byte message hash, with RFC 6979 nonces, low S, and (as
   Bitcoin Core) low R: retried with extra nonce data until R fits in 32
   bytes, so the signature is at most 71 bytes. DER into der (up to
   GK_SECP_DER_MAX), its length in *derlen. Deterministic. */
int gk_secp_ecdsa_sign (const uint8_t hash[32], const uint8_t seckey[32],
			uint8_t der[GK_SECP_DER_MAX], size_t *derlen);

/* Strict DER; a high-S signature fails, as in Bitcoin's standard rules. */
int gk_secp_ecdsa_verify (const uint8_t *der, size_t derlen, const uint8_t hash[32],
			  const uint8_t *pubkey, size_t publen);

/* BIP-340: the x-only public key, and whether the full key's Y is odd. */
int gk_secp_xonly_pubkey (const uint8_t seckey[32], uint8_t out[32], int *parity);

/* BIP-340 signature of a 32-byte message; aux: 32 bytes of auxiliary
   randomness (BIP-340 recommends fresh random bytes; zeros are allowed). */
int gk_secp_schnorr_sign (const uint8_t msg[32], const uint8_t seckey[32], const uint8_t aux[32],
			  uint8_t sig[64]);

int gk_secp_schnorr_verify (const uint8_t sig[64], const uint8_t *msg, size_t msglen,
			    const uint8_t xonly[32]);

/* Taproot (BIP-341): the output key Q = P + tweak*G for the x-only P, as
   x-only, with Q's Y parity (the control block needs it). */
int gk_secp_xonly_tweak_add (const uint8_t xonly[32], const uint8_t tweak[32],
			     uint8_t out[32], int *parity);

/* The private key for Q: seckey negated if its point has an odd Y, plus
   tweak (BIP-341's taproot_tweak_seckey). */
int gk_secp_seckey_taproot_tweak (const uint8_t seckey[32], const uint8_t tweak[32], uint8_t out[32]);

/* Known answers (the generator, BIP-340 test vectors, a fixed ECDSA
   signature, tweaks against independent results), checked against
   results computed elsewhere: catches a miscompiled library. 0: OK. */
int gk_secp_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
