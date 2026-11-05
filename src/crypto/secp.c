/*
 * secp.c - zerogap's interface to libsecp256k1 (see secp.h).
 *
 * The library does the curve arithmetic, constant-time for secrets; this
 * file only converts between its opaque structures and bytes, and wipes
 * them afterwards.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "secp.h"
#include "hexcheck.h"
#include <secp256k1.h>
#include <secp256k1_extrakeys.h>
#include <secp256k1_schnorrsig.h>
#include <secp256k1_preallocated.h>
#include <string.h>

/* src/runtime/zg_bridge.h (C++ header): halts with a message */
void zg_fatal (const char *message) __attribute__ ((noreturn));

/* libsecp256k1's default callbacks (USE_EXTERNAL_DEFAULT_CALLBACKS): an
   illegal argument is a bug here (every input is checked first), an
   internal error a broken library. Neither may go on. */
void secp256k1_default_illegal_callback_fn (const char *str, void *data)
{
	(void) data;
	(void) str;
	zg_fatal ("secp256k1: illegal argument");
}

void secp256k1_default_error_callback_fn (const char *str, void *data)
{
	(void) data;
	(void) str;
	zg_fatal ("secp256k1: internal error");
}

static secp256k1_context *s_ctx;
static uint64_t s_ctxmem[64];		/* the context, preallocated: no malloc */

/* volatile: a memset of a dead variable may be optimised away */
static void wipe (void *p, size_t n)
{
	volatile uint8_t *v = p;
	while (n-- > 0)
	{
		*v++ = 0;
	}
}

int zg_secp_init (const uint8_t seed[32])
{
	if (s_ctx != 0)
	{
		return -1;
	}
	if (secp256k1_context_preallocated_size (SECP256K1_CONTEXT_NONE) > sizeof s_ctxmem)
	{
		return -2;
	}
	secp256k1_context *ctx = secp256k1_context_preallocated_create (s_ctxmem, SECP256K1_CONTEXT_NONE);
	if (ctx == 0 || !secp256k1_context_randomize (ctx, seed))
	{
		return -3;
	}

	s_ctx = ctx;
	int r = zg_secp_selftest ();
	if (r != 0)
	{
		s_ctx = 0;
	}
	return r;
}

int zg_secp_seckey_verify (const uint8_t seckey[32])
{
	return s_ctx != 0 && secp256k1_ec_seckey_verify (s_ctx, seckey);
}

static int serialize (const secp256k1_pubkey *pk, int compressed, uint8_t *out)
{
	size_t len = compressed ? 33 : 65;
	return secp256k1_ec_pubkey_serialize (s_ctx, out, &len, pk,
					      compressed ? SECP256K1_EC_COMPRESSED : SECP256K1_EC_UNCOMPRESSED);
}

int zg_secp_pubkey_create (const uint8_t seckey[32], int compressed, uint8_t *out)
{
	secp256k1_pubkey pk;
	int ok = s_ctx != 0 && secp256k1_ec_pubkey_create (s_ctx, &pk, seckey)
		 && serialize (&pk, compressed, out);
	wipe (&pk, sizeof pk);
	return ok;
}

int zg_secp_pubkey_convert (const uint8_t *pubkey, size_t len, int compressed, uint8_t *out)
{
	secp256k1_pubkey pk;
	return s_ctx != 0 && secp256k1_ec_pubkey_parse (s_ctx, &pk, pubkey, len)
	       && serialize (&pk, compressed, out);
}

int zg_secp_seckey_tweak_add (const uint8_t seckey[32], const uint8_t tweak[32], uint8_t out[32])
{
	uint8_t k[32];
	memcpy (k, seckey, 32);
	int ok = s_ctx != 0 && secp256k1_ec_seckey_tweak_add (s_ctx, k, tweak);
	if (ok)
	{
		memcpy (out, k, 32);
	}
	wipe (k, sizeof k);
	return ok;
}

int zg_secp_pubkey_tweak_add (const uint8_t *pubkey, size_t len, const uint8_t tweak[32],
			      int compressed, uint8_t *out)
{
	secp256k1_pubkey pk;
	return s_ctx != 0 && secp256k1_ec_pubkey_parse (s_ctx, &pk, pubkey, len)
	       && secp256k1_ec_pubkey_tweak_add (s_ctx, &pk, tweak)
	       && serialize (&pk, compressed, out);
}

int zg_secp_ecdsa_sign (const uint8_t hash[32], const uint8_t seckey[32],
			uint8_t der[ZG_SECP_DER_MAX], size_t *derlen)
{
	if (s_ctx == 0)
	{
		return 0;
	}

	/* Bitcoin Core's low-R grinding (CKey::Sign): the first try has no
	   extra data, then a 32-byte little-endian counter 1, 2, ... */
	secp256k1_ecdsa_signature sig;
	uint8_t extra[32], compact[64];
	memset (extra, 0, sizeof extra);
	int ok = secp256k1_ecdsa_sign (s_ctx, &sig, hash, seckey, secp256k1_nonce_function_rfc6979, 0);
	for (uint32_t counter = 1; ok; counter++)
	{
		secp256k1_ecdsa_signature_serialize_compact (s_ctx, compact, &sig);
		if (compact[0] < 0x80)
		{
			break;
		}
		extra[0] = (uint8_t) counter; extra[1] = (uint8_t) (counter >> 8);
		extra[2] = (uint8_t) (counter >> 16); extra[3] = (uint8_t) (counter >> 24);
		ok = secp256k1_ecdsa_sign (s_ctx, &sig, hash, seckey, secp256k1_nonce_function_rfc6979, extra);
	}

	if (ok)
	{
		*derlen = ZG_SECP_DER_MAX;
		ok = secp256k1_ecdsa_signature_serialize_der (s_ctx, der, derlen, &sig);
	}
	wipe (extra, sizeof extra);
	wipe (compact, sizeof compact);
	wipe (&sig, sizeof sig);
	return ok;
}

int zg_secp_ecdsa_verify (const uint8_t *der, size_t derlen, const uint8_t hash[32],
			  const uint8_t *pubkey, size_t publen)
{
	secp256k1_ecdsa_signature sig;
	secp256k1_pubkey pk;
	return s_ctx != 0 && secp256k1_ecdsa_signature_parse_der (s_ctx, &sig, der, derlen)
	       && secp256k1_ec_pubkey_parse (s_ctx, &pk, pubkey, publen)
	       && secp256k1_ecdsa_verify (s_ctx, &sig, hash, &pk);
}

int zg_secp_xonly_pubkey (const uint8_t seckey[32], uint8_t out[32], int *parity)
{
	secp256k1_keypair kp;
	secp256k1_xonly_pubkey xpk;
	int ok = s_ctx != 0 && secp256k1_keypair_create (s_ctx, &kp, seckey)
		 && secp256k1_keypair_xonly_pub (s_ctx, &xpk, parity, &kp)
		 && secp256k1_xonly_pubkey_serialize (s_ctx, out, &xpk);
	wipe (&kp, sizeof kp);
	return ok;
}

int zg_secp_schnorr_sign (const uint8_t msg[32], const uint8_t seckey[32], const uint8_t aux[32],
			  uint8_t sig[64])
{
	secp256k1_keypair kp;
	int ok = s_ctx != 0 && secp256k1_keypair_create (s_ctx, &kp, seckey)
		 && secp256k1_schnorrsig_sign32 (s_ctx, sig, msg, &kp, aux);
	wipe (&kp, sizeof kp);
	return ok;
}

int zg_secp_schnorr_verify (const uint8_t sig[64], const uint8_t *msg, size_t msglen,
			    const uint8_t xonly[32])
{
	secp256k1_xonly_pubkey xpk;
	return s_ctx != 0 && secp256k1_xonly_pubkey_parse (s_ctx, &xpk, xonly)
	       && secp256k1_schnorrsig_verify (s_ctx, sig, msg, msglen, &xpk);
}

int zg_secp_xonly_tweak_add (const uint8_t xonly[32], const uint8_t tweak[32],
			     uint8_t out[32], int *parity)
{
	secp256k1_xonly_pubkey xpk;
	secp256k1_pubkey q;
	return s_ctx != 0 && secp256k1_xonly_pubkey_parse (s_ctx, &xpk, xonly)
	       && secp256k1_xonly_pubkey_tweak_add (s_ctx, &q, &xpk, tweak)
	       && secp256k1_xonly_pubkey_from_pubkey (s_ctx, &xpk, parity, &q)
	       && secp256k1_xonly_pubkey_serialize (s_ctx, out, &xpk);
}

int zg_secp_seckey_taproot_tweak (const uint8_t seckey[32], const uint8_t tweak[32], uint8_t out[32])
{
	secp256k1_keypair kp;
	int ok = s_ctx != 0 && secp256k1_keypair_create (s_ctx, &kp, seckey)
		 && secp256k1_keypair_xonly_tweak_add (s_ctx, &kp, tweak)
		 && secp256k1_keypair_sec (s_ctx, out, &kp);
	wipe (&kp, sizeof kp);
	return ok;
}

static void unhex (const char *hex, uint8_t *out, size_t len)
{
	for (size_t i = 0; i < len; i++)
	{
		unsigned v = 0;
		for (int j = 0; j < 2; j++)
		{
			char c = hex[2*i+j];
			v = v << 4 | (unsigned) (c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10);
		}
		out[i] = (uint8_t) v;
	}
}

#include "secp_kat.h"

int zg_secp_selftest (void)
{
	uint8_t k[32], t[32], m[32], a[32], out[72], sig[64];
	size_t len;
	int parity;

	/* 1*G */
	memset (k, 0, 32);
	k[31] = 1;
	if (!zg_secp_pubkey_create (k, 1, out)
	    || !zg_hex_equal (out, 33, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"))
	{
		return 1;
	}

	/* BIP-340 signing vectors 0 to 3 (bip-0340/test-vectors.csv) */
	for (unsigned i = 0; i < sizeof bip340 / sizeof bip340[0]; i++)
	{
		unhex (bip340[i].seckey, k, 32);
		unhex (bip340[i].aux, a, 32);
		unhex (bip340[i].msg, m, 32);
		if (   !zg_secp_xonly_pubkey (k, out, &parity) || !zg_hex_equal (out, 32, bip340[i].pubkey)
		    || !zg_secp_schnorr_sign (m, k, a, sig) || !zg_hex_equal (sig, 64, bip340[i].sig)
		    || !zg_secp_schnorr_verify (sig, m, 32, out))
		{
			return 10 + (int) i;
		}
		sig[63] ^= 1;
		if (zg_secp_schnorr_verify (sig, m, 32, out))
		{
			return 20 + (int) i;
		}
	}

	/* ECDSA, tweaks and Taproot tweaks against tools/check_secp.py's
	   independent pure-Python implementation */
	for (unsigned i = 0; i < sizeof kat / sizeof kat[0]; i++)
	{
		unhex (kat[i].seckey, k, 32);
		unhex (kat[i].tweak, t, 32);
		unhex (kat[i].hash, m, 32);
		uint8_t pub[65];
		if (   !zg_secp_pubkey_create (k, 0, pub) || !zg_hex_equal (pub, 65, kat[i].pubkey65)
		    || !zg_secp_ecdsa_sign (m, k, out, &len) || !zg_hex_equal (out, len, kat[i].der)
		    || !zg_secp_ecdsa_verify (out, len, m, pub, 65))
		{
			return 30 + (int) i;
		}
		if (   !zg_secp_seckey_tweak_add (k, t, out) || !zg_hex_equal (out, 32, kat[i].tweaked)
		    || !zg_secp_pubkey_tweak_add (pub, 65, t, 1, out) || !zg_hex_equal (out, 33, kat[i].tweakedpub)
		    || !zg_secp_seckey_taproot_tweak (k, t, out) || !zg_hex_equal (out, 32, kat[i].taproot)
		    || !zg_secp_xonly_pubkey (k, a, &parity)
		    || !zg_secp_xonly_tweak_add (a, t, out, &parity) || !zg_hex_equal (out, 32, kat[i].taprootpub)
		    || parity != kat[i].taprootparity)
		{
			return 40 + (int) i;
		}
	}

	wipe (k, sizeof k);
	wipe (m, sizeof m);
	wipe (out, sizeof out);
	return 0;
}
