/*
 * x25519.h - X25519 (RFC 7748), Monocypher's (third_party/monocypher).
 *
 * Byte order and clamping are RFC 7748's: the secret and the points' u
 * coordinates are 32 bytes little-endian; the secret is clamped as it is
 * used (bits 0-2 and 255 cleared, 254 set), so any 32 bytes are a secret;
 * a point's top bit is ignored. OpenPGP's legacy Curve25519 keys store the
 * secret as a big-endian MPI and the point with a 0x40 prefix: the caller
 * reverses and strips those (RFC 9580, 5.5.5.6 and 11.5).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_X25519_H
#define GK_X25519_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GK_X25519_SIZE	32

void gk_x25519_public (const uint8_t secret[GK_X25519_SIZE], uint8_t pub[GK_X25519_SIZE]);

/* The shared secret with a peer's public key. 0: done; -1: it is all
   zeros (the peer's key is of small order: refused, RFC 7748, 6.1), shared
   wiped. */
int gk_x25519_shared (const uint8_t secret[GK_X25519_SIZE], const uint8_t pub[GK_X25519_SIZE],
		      uint8_t shared[GK_X25519_SIZE]);

/* RFC 7748, 6.1 (both sides), 5.2's iterated case once, and a small-order
   point refused. 0: OK. */
int gk_x25519_selftest (void);

#ifdef __cplusplus
}
#endif

#endif
