//
// js_crypto.cpp
//
// The "gk:crypto" module: SHA-1, SHA-224, SHA-256, SHA-384, SHA-512 (one
// shot or incremental), RIPEMD-160, HMAC, PBKDF2, secp256k1 (ECDSA, BIP-340
// Schnorr, BIP-32 and Taproot key tweaks), OpenPGP's primitives (Ed25519,
// RSA PKCS #1 v1.5 signatures, AES-CFB, S2K), and health-checked hardware
// random bytes.
// See docs/API.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "jobs.h"
#include "../crypto/hmac.h"
#include "../crypto/ripemd160.h"
#include "../crypto/pbkdf2.h"
#include "../crypto/secp.h"
#include "../crypto/s2k.h"
#include "../crypto/aes.h"
#include "../crypto/ed25519.h"
#include "../crypto/rsa.h"
#include "../crypto/x25519.h"
#include "../crypto/seipd.h"
#include "../crypto/hwrng.h"
#include "../crypto/wipe.h"
#include <circle/util.h>
#include <circle/logger.h>
#include <circle/timer.h>
#include <stdarg.h>
#include <stdio.h>

static const unsigned MaxRandomBytes = 65536;	// as WebCrypto's getRandomValues

// pData 0: zeros
static JSValue NewUint8Array (JSContext *ctx, const u8 *pData, size_t nLength)
{
	JSValue Buffer = JS_NewArrayBufferCopy (ctx, pData, nLength);
	if (JS_IsException (Buffer))
	{
		return Buffer;
	}

	// JS_NewTypedArray reads argv[0..2] regardless of argc: pass all three
	JSValueConst Args[3] = { Buffer, JS_NewInt32 (ctx, 0), JS_UNDEFINED };
	JSValue Array = JS_NewTypedArray (ctx, 3, Args, JS_TYPED_ARRAY_UINT8);
	JS_FreeValue (ctx, Buffer);

	return Array;
}

// Points at the bytes of a typed array, DataView-less ArrayBuffer view or
// ArrayBuffer. Returns 0 (no exception set) if v is none of these.
static u8 *GetBytes (JSContext *ctx, JSValueConst v, size_t *pLength, JSValue *pHold)
{
	*pHold = JS_UNDEFINED;

	size_t nOffset, nLength, nElement;
	JSValue Buffer = JS_GetTypedArrayBuffer (ctx, v, &nOffset, &nLength, &nElement);
	if (!JS_IsException (Buffer))
	{
		size_t nSize;
		u8 *p = JS_GetArrayBuffer (ctx, &nSize, Buffer);
		if (p == 0)
		{
			JS_FreeValue (ctx, Buffer);
			return 0;
		}
		*pHold = Buffer;
		*pLength = nLength;
		return p + nOffset;
	}
	JS_FreeValue (ctx, JS_GetException (ctx));

	size_t nSize;
	u8 *p = JS_GetArrayBuffer (ctx, &nSize, v);
	if (p != 0)
	{
		*pLength = nSize;
		return p;
	}
	JS_FreeValue (ctx, JS_GetException (ctx));

	return 0;
}

// The bytes of an argument that may also be a string (taken as UTF-8).
// Release() must be called whenever Get() succeeded.
class CBytesArg
{
public:
	CBytesArg (JSContext *ctx) : m_ctx (ctx), m_pString (0), m_pData (0), m_nLength (0), m_Hold (JS_UNDEFINED) {}
	~CBytesArg (void) { Release (); }

	// FALSE: neither (no exception set), or a string conversion failed
	// (exception set: *pException)
	boolean Get (JSValueConst v, boolean *pException)
	{
		*pException = FALSE;
		if (JS_IsString (v))
		{
			m_pString = JS_ToCStringLen (m_ctx, &m_nLength, v);
			if (m_pString == 0)
			{
				*pException = TRUE;
				return FALSE;
			}
			m_pData = (const u8 *) m_pString;
			return TRUE;
		}
		m_pData = GetBytes (m_ctx, v, &m_nLength, &m_Hold);
		return m_pData != 0;
	}

	void Release (void)
	{
		if (m_pString != 0)
		{
			JS_FreeCString (m_ctx, m_pString);	// the heap wipes it
			m_pString = 0;
		}
		JS_FreeValue (m_ctx, m_Hold);
		m_Hold = JS_UNDEFINED;
		m_pData = 0;
	}

	const u8 *Data (void) const	{ return m_pData; }
	size_t Length (void) const	{ return m_nLength; }

private:
	JSContext *m_ctx;
	const char *m_pString;
	const u8 *m_pData;
	size_t m_nLength;
	JSValue m_Hold;
};

static JSValue ThrowBytesExpected (JSContext *ctx, const char *pFunction, const char *pWhat)
{
	return JS_ThrowTypeError (ctx, "%s: %s must be a Uint8Array (or other typed array), "
				  "an ArrayBuffer or a string", pFunction, pWhat);
}

// The HMAC test vectors (hmac.c), which also check SHA-1 and SHA-512, run
// once, before their first use. (SHA-256 is checked at boot, by the RNG.)
// If they fail, every hash but SHA-256 throws, and hmac, until reboot.
static boolean HashesOK (JSContext *ctx)
{
	static int s_nResult = -1;	// not run yet
	if (s_nResult < 0)
	{
		unsigned nStart = CTimer::Get ()->GetClockTicks ();
		s_nResult = gk_hmac_selftest ();
		unsigned nTicks = CTimer::Get ()->GetClockTicks () - nStart;
		if (s_nResult == 0)
		{
			CLogger::Get ()->Write ("crypto", LogNotice, "HMAC self-test passed (%u us)", nTicks);
		}
		else
		{
			CLogger::Get ()->Write ("crypto", LogError, "HMAC self-test FAILED (%d)", s_nResult);
		}
	}
	if (s_nResult != 0)
	{
		JS_ThrowInternalError (ctx, "SHA-1, SHA-224, SHA-384, SHA-512 and HMAC are disabled: "
				       "their self-test failed");
		return FALSE;
	}
	return TRUE;
}

// sha1/sha256/sha512(data) -> Uint8Array; data: typed array, ArrayBuffer or
// string (hashed as UTF-8)
static JSValue Digest (JSContext *ctx, int argc, JSValueConst *argv, const gk_hash_t *pHash,
		       const char *pFunction)
{
	if (pHash != &gk_hash_sha256 && !HashesOK (ctx))
	{
		return JS_EXCEPTION;
	}

	CBytesArg Data (ctx);
	boolean bException;
	if (!Data.Get (argc > 0 ? argv[0] : JS_UNDEFINED, &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, pFunction, "data");
	}

	u8 Digest[GK_HASH_MAX_DIGEST];
	gk_hash_ctx_t Hash;
	pHash->init (&Hash);
	pHash->update (&Hash, Data.Data (), Data.Length ());
	pHash->final (&Hash, Digest);
	Data.Release ();

	JSValue Result = NewUint8Array (ctx, Digest, pHash->digest_size);
	gk_wipe (Digest, sizeof Digest);

	return Result;
}

static JSValue js_crypto_sha1 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &gk_hash_sha1, "sha1");
}

static JSValue js_crypto_sha256 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &gk_hash_sha256, "sha256");
}

static JSValue js_crypto_sha512 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &gk_hash_sha512, "sha512");
}

// hmac(hash, key, data) -> Uint8Array; hash: "SHA-1", "SHA-224", "SHA-256",
// "SHA-384", "SHA-512"
static JSValue js_crypto_hmac (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!HashesOK (ctx))
	{
		return JS_EXCEPTION;
	}

	const gk_hash_t *pHash = 0;
	if (argc > 0 && JS_IsString (argv[0]))
	{
		const char *pName = JS_ToCString (ctx, argv[0]);
		if (pName == 0)
		{
			return JS_EXCEPTION;
		}
		pHash = gk_hash_find (pName);
		JS_FreeCString (ctx, pName);
	}
	if (pHash == 0)
	{
		return JS_ThrowTypeError (ctx, "hmac: hash must be \"SHA-1\", \"SHA-224\", \"SHA-256\", "
					  "\"SHA-384\" or \"SHA-512\"");
	}

	CBytesArg Key (ctx), Data (ctx);
	boolean bException;
	if (!Key.Get (argc > 1 ? argv[1] : JS_UNDEFINED, &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "hmac", "key");
	}
	if (!Data.Get (argc > 2 ? argv[2] : JS_UNDEFINED, &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "hmac", "data");
	}

	u8 Mac[GK_HASH_MAX_DIGEST];
	gk_hmac (pHash, Key.Data (), Key.Length (), Data.Data (), Data.Length (), Mac);
	Key.Release ();
	Data.Release ();

	JSValue Result = NewUint8Array (ctx, Mac, pHash->digest_size);
	gk_wipe (Mac, sizeof Mac);

	return Result;
}

static JSValue ThrowRNGFailure (JSContext *ctx)
{
	CGkRandom *pRNG = CGkRandom::Instance ();
	return JS_ThrowInternalError (ctx, "hardware random number generator unavailable: %s",
				      pRNG && pRNG->GetFailure () ? pRNG->GetFailure () : "not present");
}

// randomBytes(n) -> Uint8Array(n)
static JSValue js_crypto_random_bytes (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	uint32_t n;
	if (argc < 1 || JS_ToUint32 (ctx, &n, argv[0]))
	{
		return JS_ThrowTypeError (ctx, "randomBytes: length expected");
	}
	if (n > MaxRandomBytes)
	{
		return JS_ThrowRangeError (ctx, "randomBytes: at most %u bytes per call", MaxRandomBytes);
	}

	CGkRandom *pRNG = CGkRandom::Instance ();
	u8 *pBuffer = new u8[n ? n : 1];
	if (pRNG == 0 || !pRNG->Get (pBuffer, n))
	{
		delete [] pBuffer;
		return ThrowRNGFailure (ctx);
	}

	JSValue Result = NewUint8Array (ctx, pBuffer, n);
	gk_wipe (pBuffer, n);
	delete [] pBuffer;

	return Result;
}

// getRandomValues(typedArray) -> the same array, filled (WebCrypto semantics)
static JSValue js_crypto_get_random_values (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValueConst v = argc > 0 ? argv[0] : JS_UNDEFINED;
	JSValue Hold;
	size_t nLength;
	u8 *p = GetBytes (ctx, v, &nLength, &Hold);
	if (p == 0 || JS_IsUndefined (Hold))
	{
		JS_FreeValue (ctx, Hold);
		return JS_ThrowTypeError (ctx, "getRandomValues: typed array expected");
	}
	if (nLength > MaxRandomBytes)
	{
		JS_FreeValue (ctx, Hold);
		return JS_ThrowRangeError (ctx, "getRandomValues: at most %u bytes per call", MaxRandomBytes);
	}

	CGkRandom *pRNG = CGkRandom::Instance ();
	boolean bOK = pRNG != 0 && pRNG->Get (p, nLength);
	JS_FreeValue (ctx, Hold);
	if (!bOK)
	{
		return ThrowRNGFailure (ctx);
	}

	return JS_DupValue (ctx, v);
}

static JSValue js_crypto_rng_status (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CGkRandom *pRNG = CGkRandom::Instance ();

	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "healthy", JS_NewBool (ctx, pRNG && pRNG->IsHealthy ()));
	JS_SetPropertyStr (ctx, Obj, "failure", pRNG && pRNG->GetFailure ()
				? JS_NewString (ctx, pRNG->GetFailure ()) : JS_NULL);
	JS_SetPropertyStr (ctx, Obj, "rawBytes", JS_NewInt64 (ctx, pRNG ? (int64_t) pRNG->GetRawBytes () : 0));

	return Obj;
}

// Self-tests run once, before the first use of what they check; on failure
// the functions throw until reboot. Each logs its result and time.
static int RunSelfTest (const char *pName, int (*pTest) (void))
{
	unsigned nStart = CTimer::Get ()->GetClockTicks ();
	int nResult = pTest ();
	unsigned nTicks = CTimer::Get ()->GetClockTicks () - nStart;
	if (nResult == 0)
	{
		CLogger::Get ()->Write ("crypto", LogNotice, "%s self-test passed (%u us)", pName, nTicks);
	}
	else
	{
		CLogger::Get ()->Write ("crypto", LogError, "%s self-test FAILED (%d)", pName, nResult);
	}
	return nResult;
}

static int RipemdTest (void) { return gk_ripemd160_selftest (0); }
static int Pbkdf2Test (void) { return gk_pbkdf2_selftest (0); }

static boolean RipemdOK (JSContext *ctx)
{
	static int s_nResult = -1;
	if (s_nResult < 0)
	{
		s_nResult = RunSelfTest ("RIPEMD-160", RipemdTest);
	}
	if (s_nResult != 0)
	{
		JS_ThrowInternalError (ctx, "RIPEMD-160 is disabled: its self-test failed");
		return FALSE;
	}
	return TRUE;
}

static boolean Pbkdf2OK (JSContext *ctx)
{
	static int s_nResult = -1;
	if (s_nResult < 0)
	{
		s_nResult = RunSelfTest ("PBKDF2", Pbkdf2Test);
	}
	if (s_nResult != 0)
	{
		JS_ThrowInternalError (ctx, "PBKDF2 is disabled: its self-test failed");
		return FALSE;
	}
	return TRUE;
}

// secp256k1: the context is created on first use, blinded with random
// bytes, and checked (gk_secp_selftest).
static int s_nSecpResult = -1;
static u8 s_SecpSeed[32];

static int SecpInit (void)
{
	return gk_secp_init (s_SecpSeed);
}

static boolean SecpOK (JSContext *ctx)
{
	if (s_nSecpResult < 0)
	{
		CGkRandom *pRNG = CGkRandom::Instance ();
		if (pRNG == 0 || !pRNG->Get (s_SecpSeed, sizeof s_SecpSeed))
		{
			ThrowRNGFailure (ctx);
			return FALSE;
		}
		s_nSecpResult = RunSelfTest ("secp256k1", SecpInit);
		gk_wipe (s_SecpSeed, sizeof s_SecpSeed);
	}
	if (s_nSecpResult != 0)
	{
		JS_ThrowInternalError (ctx, "secp256k1 is disabled: its self-test failed");
		return FALSE;
	}
	return TRUE;
}

// ripemd160(data), hash160(data) -> Uint8Array(20)
static JSValue Ripemd (JSContext *ctx, int argc, JSValueConst *argv, boolean bHash160, const char *pFunction)
{
	if (!RipemdOK (ctx) || (bHash160 && !HashesOK (ctx)))
	{
		return JS_EXCEPTION;
	}

	CBytesArg Data (ctx);
	boolean bException;
	if (!Data.Get (argc > 0 ? argv[0] : JS_UNDEFINED, &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, pFunction, "data");
	}

	u8 Digest[GK_RIPEMD160_DIGEST_SIZE];
	if (bHash160)
	{
		gk_hash160 (Data.Data (), Data.Length (), Digest);
	}
	else
	{
		gk_ripemd160 (Data.Data (), Data.Length (), Digest);
	}
	Data.Release ();

	JSValue Result = NewUint8Array (ctx, Digest, sizeof Digest);
	gk_wipe (Digest, sizeof Digest);
	return Result;
}

static JSValue js_crypto_ripemd160 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Ripemd (ctx, argc, argv, FALSE, "ripemd160");
}

static JSValue js_crypto_hash160 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Ripemd (ctx, argc, argv, TRUE, "hash160");
}

static const uint32_t MaxPbkdf2Iterations = 10000000;
static const uint32_t MaxPbkdf2Length = 1024;

static const gk_hash_t *GetHashName (JSContext *ctx, JSValueConst v, const char *pFunction)
{
	const gk_hash_t *pHash = 0;
	if (JS_IsString (v))
	{
		const char *pName = JS_ToCString (ctx, v);
		if (pName == 0)
		{
			return 0;
		}
		pHash = gk_hash_find (pName);
		JS_FreeCString (ctx, pName);
	}
	if (pHash == 0)
	{
		JS_ThrowTypeError (ctx, "%s: hash must be \"SHA-1\", \"SHA-224\", \"SHA-256\", \"SHA-384\" "
				   "or \"SHA-512\"", pFunction);
	}
	return pHash;
}

// gk_pbkdf2_stoppable's question: Home, or the watchdog (millions of
// iterations take minutes on a Pi Zero)
static int StopNative (void *pParam)
{
	return CAppHost::ShouldInterrupt ((JSContext *) pParam);
}

static JSValue ThrowInterrupted (JSContext *ctx)
{
	return CAppHost::ThrowInterrupted (ctx);
}

// pbkdf2(hash, password, salt, iterations, length) -> Uint8Array(length)
static JSValue js_crypto_pbkdf2 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!HashesOK (ctx) || !Pbkdf2OK (ctx))
	{
		return JS_EXCEPTION;
	}
	const gk_hash_t *pHash = GetHashName (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "pbkdf2");
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}

	double fIterations, fLength;
	if (   argc < 5 || JS_ToFloat64 (ctx, &fIterations, argv[3]) || JS_ToFloat64 (ctx, &fLength, argv[4]))
	{
		return JS_ThrowTypeError (ctx, "pbkdf2: (hash, password, salt, iterations, length) expected");
	}
	if (!(fIterations >= 1 && fIterations <= MaxPbkdf2Iterations && fIterations == (uint32_t) fIterations))
	{
		return JS_ThrowRangeError (ctx, "pbkdf2: iterations must be a whole number from 1 to %u",
					   (unsigned) MaxPbkdf2Iterations);
	}
	if (!(fLength >= 1 && fLength <= MaxPbkdf2Length && fLength == (uint32_t) fLength))
	{
		return JS_ThrowRangeError (ctx, "pbkdf2: length must be a whole number from 1 to %u",
					   (unsigned) MaxPbkdf2Length);
	}

	CBytesArg Password (ctx), Salt (ctx);
	boolean bException;
	if (!Password.Get (argv[1], &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "pbkdf2", "password");
	}
	if (!Salt.Get (argv[2], &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "pbkdf2", "salt");
	}

	// derived straight into the result's buffer (the JS heap, wiped when
	// freed): no copy of the key elsewhere
	size_t nLength = (size_t) fLength;
	JSValue Result = NewUint8Array (ctx, 0, nLength);
	JSValue Hold;
	size_t nResultLength = 0;
	u8 *pKey = JS_IsException (Result) ? 0 : GetBytes (ctx, Result, &nResultLength, &Hold);
	if (pKey == 0 || nResultLength != nLength)
	{
		if (pKey != 0) JS_FreeValue (ctx, Hold);
		JS_FreeValue (ctx, Result);
		return JS_IsException (Result) ? Result : JS_ThrowInternalError (ctx, "pbkdf2: no buffer");
	}
	int nStopped = gk_pbkdf2_stoppable (pHash, Password.Data (), Password.Length (),
					    Salt.Data (), Salt.Length (), (uint32_t) fIterations,
					    pKey, nLength, StopNative, ctx);
	JS_FreeValue (ctx, Hold);
	Password.Release ();
	Salt.Release ();
	if (nStopped)
	{
		JS_FreeValue (ctx, Result);
		return ThrowInterrupted (ctx);
	}
	return Result;
}

// Fixed-size byte arguments of the secp256k1 functions: typed arrays or
// ArrayBuffers only (a key as a string would be a mistake), copied into
// a buffer the caller wipes.
static boolean GetFixed (JSContext *ctx, JSValueConst v, u8 *pOut, size_t nSize,
			 const char *pFunction, const char *pWhat)
{
	JSValue Hold;
	size_t nLength;
	u8 *p = GetBytes (ctx, v, &nLength, &Hold);
	if (p == 0)
	{
		JS_ThrowTypeError (ctx, "%s: %s must be a Uint8Array (or other typed array) or an ArrayBuffer",
				   pFunction, pWhat);
		return FALSE;
	}
	boolean bOK = nLength == nSize;
	if (bOK)
	{
		memcpy (pOut, p, nSize);
	}
	JS_FreeValue (ctx, Hold);
	if (!bOK)
	{
		JS_ThrowRangeError (ctx, "%s: %s must be %u bytes", pFunction, pWhat, (unsigned) nSize);
	}
	return bOK;
}

// A public key (33 or 65 bytes) or a signature: variable length, up to nMax.
static boolean GetVariable (JSContext *ctx, JSValueConst v, u8 *pOut, size_t nMax, size_t *pLength,
			    const char *pFunction, const char *pWhat)
{
	JSValue Hold;
	size_t nLength;
	u8 *p = GetBytes (ctx, v, &nLength, &Hold);
	if (p == 0)
	{
		JS_ThrowTypeError (ctx, "%s: %s must be a Uint8Array (or other typed array) or an ArrayBuffer",
				   pFunction, pWhat);
		return FALSE;
	}
	*pLength = nLength;
	if (nLength <= nMax)
	{
		memcpy (pOut, p, nLength);
	}
	JS_FreeValue (ctx, Hold);
	return TRUE;		// too long: the caller's check fails on *pLength
}

static boolean GetCompressed (JSContext *ctx, int argc, JSValueConst *argv, int nArg)
{
	return argc <= nArg || JS_IsUndefined (argv[nArg]) || JS_ToBool (ctx, argv[nArg]);
}

// Wipes a secret buffer when it goes out of scope, however the function returns.
class CSecret
{
public:
	CSecret (void)			{ memset (m_Data, 0, sizeof m_Data); }
	~CSecret (void)			{ gk_wipe (m_Data, sizeof m_Data); }
	u8 *operator* (void)		{ return m_Data; }
private:
	u8 m_Data[32];
};

static JSValue ThrowBadPrivateKey (JSContext *ctx, const char *pFunction)
{
	return JS_ThrowRangeError (ctx, "%s: not a valid private key (0 or not below the curve order)", pFunction);
}

static JSValue ThrowBadPublicKey (JSContext *ctx, const char *pFunction)
{
	return JS_ThrowRangeError (ctx, "%s: not a valid public key", pFunction);
}

// isPrivateKey(key) -> boolean
static JSValue js_crypto_is_private_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!SecpOK (ctx))
	{
		return JS_EXCEPTION;
	}
	CSecret Key;
	JSValue Hold;
	size_t nLength;
	u8 *p = GetBytes (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &nLength, &Hold);
	if (p == 0)
	{
		return JS_FALSE;
	}
	boolean bOK = nLength == 32;
	if (bOK)
	{
		memcpy (*Key, p, 32);
	}
	JS_FreeValue (ctx, Hold);
	return JS_NewBool (ctx, bOK && gk_secp_seckey_verify (*Key));
}

// isPublicKey(key) -> boolean
static JSValue js_crypto_is_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!SecpOK (ctx))
	{
		return JS_EXCEPTION;
	}
	u8 Pub[65], Out[33];
	size_t nLength;
	JSValue Hold;
	u8 *p = GetBytes (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &nLength, &Hold);
	if (p == 0)
	{
		return JS_FALSE;
	}
	boolean bOK = nLength <= sizeof Pub;
	if (bOK)
	{
		memcpy (Pub, p, nLength);
	}
	JS_FreeValue (ctx, Hold);
	return JS_NewBool (ctx, bOK && gk_secp_pubkey_convert (Pub, nLength, 1, Out));
}

// publicKey(privateKey, compressed = true) -> Uint8Array(33 or 65)
static JSValue js_crypto_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Key;
	if (!SecpOK (ctx) || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Key, 32, "publicKey", "privateKey"))
	{
		return JS_EXCEPTION;
	}
	boolean bCompressed = GetCompressed (ctx, argc, argv, 1);
	u8 Out[65];
	if (!gk_secp_pubkey_create (*Key, bCompressed, Out))
	{
		return ThrowBadPrivateKey (ctx, "publicKey");
	}
	return NewUint8Array (ctx, Out, bCompressed ? 33 : 65);
}

// publicKeyConvert(publicKey, compressed = true) -> Uint8Array(33 or 65)
static JSValue js_crypto_public_key_convert (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	u8 Pub[65], Out[65];
	size_t nLength;
	if (   !SecpOK (ctx)
	    || !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Pub, sizeof Pub, &nLength,
			     "publicKeyConvert", "publicKey"))
	{
		return JS_EXCEPTION;
	}
	boolean bCompressed = GetCompressed (ctx, argc, argv, 1);
	if (nLength > sizeof Pub || !gk_secp_pubkey_convert (Pub, nLength, bCompressed, Out))
	{
		return ThrowBadPublicKey (ctx, "publicKeyConvert");
	}
	return NewUint8Array (ctx, Out, bCompressed ? 33 : 65);
}

// privateKeyTweakAdd(privateKey, tweak) -> Uint8Array(32)
static JSValue js_crypto_private_key_tweak_add (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Key, Tweak, Out;
	if (   !SecpOK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Key, 32, "privateKeyTweakAdd", "privateKey")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, *Tweak, 32, "privateKeyTweakAdd", "tweak"))
	{
		return JS_EXCEPTION;
	}
	if (!gk_secp_seckey_verify (*Key))
	{
		return ThrowBadPrivateKey (ctx, "privateKeyTweakAdd");
	}
	if (!gk_secp_seckey_tweak_add (*Key, *Tweak, *Out))
	{
		return JS_ThrowRangeError (ctx, "privateKeyTweakAdd: the tweak is not below the curve order, "
					   "or the result is 0");
	}
	return NewUint8Array (ctx, *Out, 32);
}

// publicKeyTweakAdd(publicKey, tweak, compressed = true) -> Uint8Array(33 or 65)
static JSValue js_crypto_public_key_tweak_add (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	u8 Pub[65], Tweak[32], Out[65];
	size_t nLength;
	if (   !SecpOK (ctx)
	    || !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Pub, sizeof Pub, &nLength,
			     "publicKeyTweakAdd", "publicKey")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, Tweak, 32, "publicKeyTweakAdd", "tweak"))
	{
		return JS_EXCEPTION;
	}
	boolean bCompressed = GetCompressed (ctx, argc, argv, 2);
	if (nLength > sizeof Pub || !gk_secp_pubkey_convert (Pub, nLength, 1, Out))
	{
		return ThrowBadPublicKey (ctx, "publicKeyTweakAdd");
	}
	if (!gk_secp_pubkey_tweak_add (Pub, nLength, Tweak, bCompressed, Out))
	{
		return JS_ThrowRangeError (ctx, "publicKeyTweakAdd: the tweak is not below the curve order, "
					   "or the result is the point at infinity");
	}
	return NewUint8Array (ctx, Out, bCompressed ? 33 : 65);
}

// ecdsaSign(hash, privateKey) -> Uint8Array (DER, up to 71 bytes)
static JSValue js_crypto_ecdsa_sign (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Key, Hash;
	if (   !SecpOK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Hash, 32, "ecdsaSign", "hash")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, *Key, 32, "ecdsaSign", "privateKey"))
	{
		return JS_EXCEPTION;
	}
	u8 Der[GK_SECP_DER_MAX];
	size_t nLength;
	if (!gk_secp_ecdsa_sign (*Hash, *Key, Der, &nLength))
	{
		return ThrowBadPrivateKey (ctx, "ecdsaSign");
	}
	return NewUint8Array (ctx, Der, nLength);
}

// ecdsaVerify(signature, hash, publicKey) -> boolean
static JSValue js_crypto_ecdsa_verify (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	u8 Der[GK_SECP_DER_MAX], Hash[32], Pub[65];
	size_t nDer, nPub;
	if (   !SecpOK (ctx)
	    || !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Der, sizeof Der, &nDer, "ecdsaVerify", "signature")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, Hash, 32, "ecdsaVerify", "hash")
	    || !GetVariable (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, Pub, sizeof Pub, &nPub, "ecdsaVerify", "publicKey"))
	{
		return JS_EXCEPTION;
	}
	return JS_NewBool (ctx, nDer <= sizeof Der && nPub <= sizeof Pub
				&& gk_secp_ecdsa_verify (Der, nDer, Hash, Pub, nPub));
}

// xOnlyPublicKey(privateKey) -> Uint8Array(32)
static JSValue js_crypto_xonly_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Key;
	if (!SecpOK (ctx) || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Key, 32, "xOnlyPublicKey", "privateKey"))
	{
		return JS_EXCEPTION;
	}
	u8 Out[32];
	int nParity;
	if (!gk_secp_xonly_pubkey (*Key, Out, &nParity))
	{
		return ThrowBadPrivateKey (ctx, "xOnlyPublicKey");
	}
	return NewUint8Array (ctx, Out, 32);
}

// schnorrSign(message, privateKey, aux = 32 random bytes) -> Uint8Array(64)
static JSValue js_crypto_schnorr_sign (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Key, Msg, Aux;
	if (   !SecpOK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Msg, 32, "schnorrSign", "message")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, *Key, 32, "schnorrSign", "privateKey"))
	{
		return JS_EXCEPTION;
	}
	if (argc > 2 && !JS_IsUndefined (argv[2]))
	{
		if (!GetFixed (ctx, argv[2], *Aux, 32, "schnorrSign", "aux"))
		{
			return JS_EXCEPTION;
		}
	}
	else
	{
		CGkRandom *pRNG = CGkRandom::Instance ();
		if (pRNG == 0 || !pRNG->Get (*Aux, 32))
		{
			return ThrowRNGFailure (ctx);
		}
	}
	u8 Sig[64];
	if (!gk_secp_schnorr_sign (*Msg, *Key, *Aux, Sig))
	{
		return ThrowBadPrivateKey (ctx, "schnorrSign");
	}
	return NewUint8Array (ctx, Sig, 64);
}

// schnorrVerify(signature, message, xOnlyPublicKey) -> boolean; message:
// any length (BIP-340), typed array or ArrayBuffer
static JSValue js_crypto_schnorr_verify (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	u8 Sig[64], Key[32];
	size_t nSig, nKey;
	if (   !SecpOK (ctx)
	    || !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Sig, sizeof Sig, &nSig, "schnorrVerify", "signature")
	    || !GetVariable (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, Key, sizeof Key, &nKey, "schnorrVerify", "publicKey"))
	{
		return JS_EXCEPTION;
	}
	JSValue Hold;
	size_t nMsg;
	u8 *pMsg = GetBytes (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, &nMsg, &Hold);
	if (pMsg == 0)
	{
		return JS_ThrowTypeError (ctx, "schnorrVerify: message must be a Uint8Array (or other typed array) "
					  "or an ArrayBuffer");
	}
	boolean bOK = nSig == 64 && nKey == 32 && gk_secp_schnorr_verify (Sig, pMsg, nMsg, Key);
	JS_FreeValue (ctx, Hold);
	return JS_NewBool (ctx, bOK);
}

// taprootTweakPublicKey(xOnlyPublicKey, tweak) -> { key: Uint8Array(32), parity: 0 | 1 }
static JSValue js_crypto_taproot_tweak_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	u8 Key[32], Tweak[32], Out[32];
	if (   !SecpOK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Key, 32, "taprootTweakPublicKey", "publicKey")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, Tweak, 32, "taprootTweakPublicKey", "tweak"))
	{
		return JS_EXCEPTION;
	}
	int nParity;
	if (!gk_secp_xonly_tweak_add (Key, Tweak, Out, &nParity))
	{
		return JS_ThrowRangeError (ctx, "taprootTweakPublicKey: not a valid x-only public key, "
					   "or the tweak is not below the curve order");
	}
	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "key", NewUint8Array (ctx, Out, 32));
	JS_SetPropertyStr (ctx, Obj, "parity", JS_NewInt32 (ctx, nParity));
	return Obj;
}

// taprootTweakPrivateKey(privateKey, tweak) -> Uint8Array(32)
static JSValue js_crypto_taproot_tweak_private_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Key, Tweak, Out;
	if (   !SecpOK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Key, 32, "taprootTweakPrivateKey", "privateKey")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, *Tweak, 32, "taprootTweakPrivateKey", "tweak"))
	{
		return JS_EXCEPTION;
	}
	if (!gk_secp_seckey_verify (*Key))
	{
		return ThrowBadPrivateKey (ctx, "taprootTweakPrivateKey");
	}
	if (!gk_secp_seckey_taproot_tweak (*Key, *Tweak, *Out))
	{
		return JS_ThrowRangeError (ctx, "taprootTweakPrivateKey: the tweak is not below the curve order, "
					   "or the result is 0");
	}
	return NewUint8Array (ctx, *Out, 32);
}

// --- OpenPGP's primitives ---------------------------------------------------
//
// Ed25519 (Monocypher), RSA PKCS #1 v1.5 signatures and AES-CFB (Mbed TLS),
// OpenPGP's S2K, incremental hashes. Private keys are objects holding the
// key in native memory (Ed25519PrivateKey, RsaPrivateKey): created from the
// key's bytes, which JavaScript had, used to sign, wiped by destroy(), or
// when the object is collected, or at the latest when the app exits (its
// runtime is freed, and every object's finalizer runs).

static int Ed25519Test (void) { return gk_ed25519_selftest (); }
static int AesTest (void) { return gk_aes_selftest (); }
static int S2kTest (void) { return gk_s2k_selftest (); }

// Mbed TLS's random bytes (RSA blinding): the hardware generator's
static int RsaRandom (void *pParam, unsigned char *pOut, size_t nLength)
{
	CGkRandom *pRNG = CGkRandom::Instance ();
	return pRNG != 0 && pRNG->Get (pOut, nLength) ? 0 : -1;
}

static int RsaTest (void) { return gk_rsa_selftest (RsaRandom, 0); }

static boolean GroupOK (JSContext *ctx, int *pResult, const char *pName, int (*pTest) (void))
{
	if (*pResult < 0)
	{
		*pResult = RunSelfTest (pName, pTest);
	}
	if (*pResult != 0)
	{
		JS_ThrowInternalError (ctx, "%s is disabled: its self-test failed", pName);
		return FALSE;
	}
	return TRUE;
}

static boolean Ed25519OK (JSContext *ctx)
{
	static int s_nResult = -1;
	return GroupOK (ctx, &s_nResult, "Ed25519", Ed25519Test);
}

static boolean AesOK (JSContext *ctx)
{
	static int s_nResult = -1;
	return GroupOK (ctx, &s_nResult, "AES", AesTest);
}

static boolean S2kOK (JSContext *ctx)
{
	static int s_nResult = -1;
	return HashesOK (ctx) && GroupOK (ctx, &s_nResult, "S2K", S2kTest);
}

static boolean RsaOK (JSContext *ctx)
{
	static int s_nResult = -1;
	if (s_nResult < 0 && (CGkRandom::Instance () == 0 || !CGkRandom::Instance ()->IsHealthy ()))
	{
		ThrowRNGFailure (ctx);		// blinding needs it: don't fail the test for that
		return FALSE;
	}
	return HashesOK (ctx) && GroupOK (ctx, &s_nResult, "RSA", RsaTest);
}

static void DefineMethod (JSContext *ctx, JSValueConst Obj, const char *pName, JSCFunction *pFunc, int nArgs)
{
	JS_DefinePropertyValueStr (ctx, Obj, pName, JS_NewCFunction (ctx, pFunc, pName, nArgs),
				   JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
}

static void DefineGetter (JSContext *ctx, JSValueConst Obj, const char *pName, JSCFunction *pFunc)
{
	JSAtom Atom = JS_NewAtom (ctx, pName);
	JS_DefinePropertyGetSet (ctx, Obj, Atom, JS_NewCFunction (ctx, pFunc, pName, 0), JS_UNDEFINED,
				 JS_PROP_CONFIGURABLE);
	JS_FreeAtom (ctx, Atom);
}

// The bytes of a typed array or ArrayBuffer (not a string), held until
// Release() or the end of scope.
class CBytesOnly
{
public:
	CBytesOnly (JSContext *ctx) : m_ctx (ctx), m_pData (0), m_nLength (0), m_Hold (JS_UNDEFINED) {}
	~CBytesOnly (void) { Release (); }

	// FALSE: not bytes; a TypeError is thrown
	boolean Get (JSValueConst v, const char *pFunction, const char *pWhat)
	{
		m_pData = GetBytes (m_ctx, v, &m_nLength, &m_Hold);
		if (m_pData == 0)
		{
			JS_ThrowTypeError (m_ctx, "%s: %s must be a Uint8Array (or other typed array) or an ArrayBuffer",
					   pFunction, pWhat);
			return FALSE;
		}
		return TRUE;
	}

	void Release (void)
	{
		JS_FreeValue (m_ctx, m_Hold);
		m_Hold = JS_UNDEFINED;
		m_pData = 0;
	}

	const u8 *Data (void) const	{ return m_pData; }
	size_t Length (void) const	{ return m_nLength; }

private:
	JSContext *m_ctx;
	const u8 *m_pData;
	size_t m_nLength;
	JSValue m_Hold;
};

// A new Uint8Array(n) and a pointer to its bytes, to fill in place (the
// result stays in the JS heap, which is wiped when freed). JS_EXCEPTION
// if it could not be made.
static JSValue NewOutput (JSContext *ctx, size_t nLength, u8 **ppOut)
{
	JSValue Result = NewUint8Array (ctx, 0, nLength);
	if (JS_IsException (Result))
	{
		return Result;
	}
	JSValue Hold;
	size_t nGot = 0;
	*ppOut = GetBytes (ctx, Result, &nGot, &Hold);
	JS_FreeValue (ctx, Hold);	// Result keeps the buffer
	if (*ppOut == 0 || nGot != nLength)
	{
		JS_FreeValue (ctx, Result);
		return JS_ThrowInternalError (ctx, "no buffer");
	}
	return Result;
}

// --- incremental hashes: createHash(name) -> Hash ---------------------------

struct TGkHash
{
	const gk_hash_t *pHash;
	gk_hash_ctx_t Ctx;
	boolean bDone;			// digest() or destroy(): no more use
};

static JSClassID s_HashClass;

static void HashFinalizer (JSRuntime *rt, JSValue Val)
{
	TGkHash *pHash = (TGkHash *) JS_GetOpaque (Val, s_HashClass);
	if (pHash != 0)
	{
		gk_wipe (pHash, sizeof *pHash);
		js_free_rt (rt, pHash);
	}
}

static TGkHash *GetHash (JSContext *ctx, JSValueConst This, const char *pMethod)
{
	TGkHash *pHash = (TGkHash *) JS_GetOpaque2 (ctx, This, s_HashClass);
	if (pHash != 0 && pHash->bDone)
	{
		JS_ThrowTypeError (ctx, "Hash.%s: this hash is finished (digest() or destroy() was called)", pMethod);
		return 0;
	}
	return pHash;
}

static JSValue NewHashObject (JSContext *ctx, const gk_hash_t *pAlgorithm, const gk_hash_ctx_t *pFrom)
{
	JSValue Obj = JS_NewObjectClass (ctx, s_HashClass);
	if (JS_IsException (Obj))
	{
		return Obj;
	}
	TGkHash *pHash = (TGkHash *) js_mallocz (ctx, sizeof (TGkHash));
	if (pHash == 0)
	{
		JS_FreeValue (ctx, Obj);
		return JS_EXCEPTION;
	}
	pHash->pHash = pAlgorithm;
	if (pFrom != 0)
	{
		pHash->Ctx = *pFrom;
	}
	else
	{
		pAlgorithm->init (&pHash->Ctx);
	}
	JS_SetOpaque (Obj, pHash);
	return Obj;
}

// createHash(hash) -> Hash
static JSValue js_crypto_create_hash (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!HashesOK (ctx))
	{
		return JS_EXCEPTION;
	}
	const gk_hash_t *pAlgorithm = GetHashName (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "createHash");
	return pAlgorithm != 0 ? NewHashObject (ctx, pAlgorithm, 0) : JS_EXCEPTION;
}

// Hash.update(data) -> this
static JSValue js_hash_update (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkHash *pHash = GetHash (ctx, this_val, "update");
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}
	CBytesArg Data (ctx);
	boolean bException;
	if (!Data.Get (argc > 0 ? argv[0] : JS_UNDEFINED, &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "Hash.update", "data");
	}
	pHash->pHash->update (&pHash->Ctx, Data.Data (), Data.Length ());
	return JS_DupValue (ctx, this_val);
}

// Hash.digest() -> Uint8Array; the hash is finished
static JSValue js_hash_digest (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkHash *pHash = GetHash (ctx, this_val, "digest");
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}
	u8 Digest[GK_HASH_MAX_DIGEST];
	pHash->pHash->final (&pHash->Ctx, Digest);	// wipes the context
	pHash->bDone = TRUE;
	JSValue Result = NewUint8Array (ctx, Digest, pHash->pHash->digest_size);
	gk_wipe (Digest, sizeof Digest);
	return Result;
}

// Hash.copy() -> a new Hash in the same state
static JSValue js_hash_copy (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkHash *pHash = GetHash (ctx, this_val, "copy");
	return pHash != 0 ? NewHashObject (ctx, pHash->pHash, &pHash->Ctx) : JS_EXCEPTION;
}

// Hash.destroy(): wipes the state; again: nothing
static JSValue js_hash_destroy (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkHash *pHash = (TGkHash *) JS_GetOpaque2 (ctx, this_val, s_HashClass);
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}
	gk_wipe (&pHash->Ctx, sizeof pHash->Ctx);
	pHash->bDone = TRUE;
	return JS_UNDEFINED;
}

static JSValue js_hash_get_algorithm (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkHash *pHash = (TGkHash *) JS_GetOpaque2 (ctx, this_val, s_HashClass);
	return pHash != 0 ? JS_NewString (ctx, pHash->pHash->name) : JS_EXCEPTION;
}

// sha224(data), sha384(data) -> Uint8Array
static JSValue js_crypto_sha224 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &gk_hash_sha224, "sha224");
}

static JSValue js_crypto_sha384 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &gk_hash_sha384, "sha384");
}

// --- Ed25519 ----------------------------------------------------------------

struct TGkEd25519
{
	u8 Secret[GK_ED25519_SECRET_SIZE];
	u8 Public[GK_ED25519_PUBLIC_SIZE];
	boolean bDestroyed;
};

static JSClassID s_Ed25519Class;

static void Ed25519Finalizer (JSRuntime *rt, JSValue Val)
{
	TGkEd25519 *pKey = (TGkEd25519 *) JS_GetOpaque (Val, s_Ed25519Class);
	if (pKey != 0)
	{
		gk_wipe (pKey, sizeof *pKey);
		js_free_rt (rt, pKey);
	}
}

// ed25519PrivateKey(seed) -> Ed25519PrivateKey
static JSValue js_crypto_ed25519_private_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Seed;
	if (   !Ed25519OK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Seed, 32, "ed25519PrivateKey", "seed"))
	{
		return JS_EXCEPTION;
	}
	JSValue Obj = JS_NewObjectClass (ctx, s_Ed25519Class);
	if (JS_IsException (Obj))
	{
		return Obj;
	}
	TGkEd25519 *pKey = (TGkEd25519 *) js_mallocz (ctx, sizeof (TGkEd25519));
	if (pKey == 0)
	{
		JS_FreeValue (ctx, Obj);
		return JS_EXCEPTION;
	}
	gk_ed25519_keypair (*Seed, pKey->Secret, pKey->Public);
	JS_SetOpaque (Obj, pKey);
	return Obj;
}

static JSValue js_ed25519_get_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkEd25519 *pKey = (TGkEd25519 *) JS_GetOpaque2 (ctx, this_val, s_Ed25519Class);
	return pKey != 0 ? NewUint8Array (ctx, pKey->Public, sizeof pKey->Public) : JS_EXCEPTION;
}

// Ed25519PrivateKey.sign(message) -> Uint8Array(64)
static JSValue js_ed25519_sign (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkEd25519 *pKey = (TGkEd25519 *) JS_GetOpaque2 (ctx, this_val, s_Ed25519Class);
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	if (pKey->bDestroyed)
	{
		return JS_ThrowTypeError (ctx, "Ed25519PrivateKey.sign: the key was destroyed");
	}
	CBytesOnly Message (ctx);
	if (!Message.Get (argc > 0 ? argv[0] : JS_UNDEFINED, "Ed25519PrivateKey.sign", "message"))
	{
		return JS_EXCEPTION;
	}
	u8 Sig[GK_ED25519_SIGNATURE_SIZE];
	if (gk_ed25519_sign (pKey->Secret, Message.Data (), Message.Length (), Sig) != 0)
	{
		CLogger::Get ()->Write ("crypto", LogError, "Ed25519 signature failed its check");
		return JS_ThrowInternalError (ctx, "Ed25519PrivateKey.sign: the signature failed its check "
					      "(a hardware fault?): none returned");
	}
	return NewUint8Array (ctx, Sig, sizeof Sig);
}

static JSValue js_ed25519_destroy (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkEd25519 *pKey = (TGkEd25519 *) JS_GetOpaque2 (ctx, this_val, s_Ed25519Class);
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	gk_wipe (pKey->Secret, sizeof pKey->Secret);
	pKey->bDestroyed = TRUE;
	return JS_UNDEFINED;
}

// ed25519Verify(signature, message, publicKey) -> boolean
static JSValue js_crypto_ed25519_verify (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	u8 Sig[GK_ED25519_SIGNATURE_SIZE], Pub[GK_ED25519_PUBLIC_SIZE];
	size_t nSig, nPub;
	CBytesOnly Message (ctx);
	if (   !Ed25519OK (ctx)
	    || !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Sig, sizeof Sig, &nSig, "ed25519Verify", "signature")
	    || !Message.Get (argc > 1 ? argv[1] : JS_UNDEFINED, "ed25519Verify", "message")
	    || !GetVariable (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, Pub, sizeof Pub, &nPub, "ed25519Verify", "publicKey"))
	{
		return JS_EXCEPTION;
	}
	return JS_NewBool (ctx, nSig == sizeof Sig && nPub == sizeof Pub
				&& gk_ed25519_verify (Sig, Pub, Message.Data (), Message.Length ()));
}

// --- RSA --------------------------------------------------------------------

static const unsigned MaxRsaKeys = 64;		// alive at once (native memory, ~7 KB each)
static const size_t MaxRsaNumber = 1024;	// bytes per number given, leading zeros too
static unsigned s_nRsaKeys;

struct TGkRsa
{
	gk_rsa_key_t *pKey;			// 0: destroyed
};

static JSClassID s_RsaClass;

static void RsaDestroy (TGkRsa *pRsa)
{
	if (pRsa->pKey != 0)
	{
		gk_rsa_free (pRsa->pKey);
		pRsa->pKey = 0;
		s_nRsaKeys--;
	}
}

static void RsaFinalizer (JSRuntime *rt, JSValue Val)
{
	TGkRsa *pRsa = (TGkRsa *) JS_GetOpaque (Val, s_RsaClass);
	if (pRsa != 0)
	{
		RsaDestroy (pRsa);
		js_free_rt (rt, pRsa);
	}
}

// The numbers of an RSA key, { n, e, ... }: each a typed array or
// ArrayBuffer, unsigned big-endian. Holds them until the end of scope.
class CRsaNumbers
{
public:
	CRsaNumbers (JSContext *ctx) : m_ctx (ctx)
	{
		for (unsigned i = 0; i < Count; i++)
		{
			m_Value[i] = JS_UNDEFINED;
			m_pNumber[i] = new CBytesOnly (ctx);
		}
	}
	~CRsaNumbers (void)
	{
		for (unsigned i = 0; i < Count; i++)
		{
			delete m_pNumber[i];
			JS_FreeValue (m_ctx, m_Value[i]);
		}
	}

	// nWanted: a bit for each number read (1 << N, ...); those in
	// nOptional may be absent (undefined or null). FALSE: exception set.
	boolean Get (JSValueConst Obj, unsigned nWanted, unsigned nOptional, const char *pFunction)
	{
		if (!JS_IsObject (Obj))
		{
			JS_ThrowTypeError (m_ctx, "%s: an object { %s } expected", pFunction,
					   nWanted == Public ? "n, e" : "n, e, d, p, q, u");
			return FALSE;
		}
		// every property first (a getter could run code), then the bytes
		for (unsigned i = 0; i < Count; i++)
		{
			if (nWanted & (1 << i))
			{
				m_Value[i] = JS_GetPropertyStr (m_ctx, Obj, Names[i]);
				if (JS_IsException (m_Value[i]))
				{
					return FALSE;
				}
			}
		}
		for (unsigned i = 0; i < Count; i++)
		{
			if (!(nWanted & (1 << i)))
			{
				continue;
			}
			if ((nOptional & (1 << i)) && (JS_IsUndefined (m_Value[i]) || JS_IsNull (m_Value[i])))
			{
				continue;
			}
			if (!m_pNumber[i]->Get (m_Value[i], pFunction, Names[i]))
			{
				return FALSE;
			}
			if (m_pNumber[i]->Length () > MaxRsaNumber)
			{
				JS_ThrowRangeError (m_ctx, "%s: %s is too long (more than %u bytes)", pFunction,
						    Names[i], (unsigned) MaxRsaNumber);
				return FALSE;
			}
		}
		return TRUE;
	}

	const u8 *Data (unsigned i) const	{ return m_pNumber[i]->Data (); }
	size_t Length (unsigned i) const	{ return m_pNumber[i]->Length (); }

	enum { N, E, D, P, Q, U, Count };
	static const unsigned Public = 1 << N | 1 << E;
	static const unsigned Private = Public | 1 << D | 1 << P | 1 << Q | 1 << U;
	static const char *const Names[Count];

private:
	JSContext *m_ctx;
	JSValue m_Value[Count];
	CBytesOnly *m_pNumber[Count];
};

const char *const CRsaNumbers::Names[CRsaNumbers::Count] = { "n", "e", "d", "p", "q", "u" };

// rsaPrivateKey({ n, e, d, p, q, u }) -> RsaPrivateKey
static JSValue js_crypto_rsa_private_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!RsaOK (ctx))
	{
		return JS_EXCEPTION;
	}
	CRsaNumbers Numbers (ctx);
	if (!Numbers.Get (argc > 0 ? argv[0] : JS_UNDEFINED, CRsaNumbers::Private, 1 << CRsaNumbers::U, "rsaPrivateKey"))
	{
		return JS_EXCEPTION;
	}
	if (s_nRsaKeys >= MaxRsaKeys)
	{
		return JS_ThrowRangeError (ctx, "rsaPrivateKey: at most %u RSA keys at a time: destroy() those not needed",
					   MaxRsaKeys);
	}

	gk_rsa_key_t *pKey;
	int nResult = gk_rsa_import (&pKey, Numbers.Data (CRsaNumbers::N), Numbers.Length (CRsaNumbers::N),
				     Numbers.Data (CRsaNumbers::E), Numbers.Length (CRsaNumbers::E),
				     Numbers.Data (CRsaNumbers::D), Numbers.Length (CRsaNumbers::D),
				     Numbers.Data (CRsaNumbers::P), Numbers.Length (CRsaNumbers::P),
				     Numbers.Data (CRsaNumbers::Q), Numbers.Length (CRsaNumbers::Q),
				     Numbers.Data (CRsaNumbers::U), Numbers.Length (CRsaNumbers::U));
	switch (nResult)
	{
	case GK_RSA_OK:
		break;
	case GK_RSA_BAD_SIZE:
		return JS_ThrowRangeError (ctx, "rsaPrivateKey: the modulus must be %u to %u bits",
					   GK_RSA_MIN_BITS, GK_RSA_MAX_BITS);
	case GK_RSA_NO_MEMORY:
		return JS_ThrowOutOfMemory (ctx);
	default:
		return JS_ThrowRangeError (ctx, "rsaPrivateKey: n, e, d, p, q (and u) are not one RSA key");
	}

	JSValue Obj = JS_NewObjectClass (ctx, s_RsaClass);
	TGkRsa *pRsa = JS_IsException (Obj) ? 0 : (TGkRsa *) js_mallocz (ctx, sizeof (TGkRsa));
	if (pRsa == 0)
	{
		gk_rsa_free (pKey);
		JS_FreeValue (ctx, Obj);
		return JS_EXCEPTION;
	}
	pRsa->pKey = pKey;
	s_nRsaKeys++;
	JS_SetOpaque (Obj, pRsa);
	return Obj;
}

static TGkRsa *GetRsa (JSContext *ctx, JSValueConst This, const char *pMethod, boolean bAlive)
{
	TGkRsa *pRsa = (TGkRsa *) JS_GetOpaque2 (ctx, This, s_RsaClass);
	if (pRsa != 0 && bAlive && pRsa->pKey == 0)
	{
		JS_ThrowTypeError (ctx, "RsaPrivateKey.%s: the key was destroyed", pMethod);
		return 0;
	}
	return pRsa;
}

static JSValue js_rsa_get_bits (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkRsa *pRsa = GetRsa (ctx, this_val, "bits", TRUE);
	return pRsa != 0 ? JS_NewInt32 (ctx, (int) gk_rsa_bits (pRsa->pKey)) : JS_EXCEPTION;
}

// RsaPrivateKey.publicKey -> { n, e }
static JSValue js_rsa_get_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkRsa *pRsa = GetRsa (ctx, this_val, "publicKey", TRUE);
	if (pRsa == 0)
	{
		return JS_EXCEPTION;
	}
	size_t nN, nE;
	const u8 *pN = gk_rsa_n (pRsa->pKey, &nN), *pE = gk_rsa_e (pRsa->pKey, &nE);
	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "n", NewUint8Array (ctx, pN, nN));
	JS_SetPropertyStr (ctx, Obj, "e", NewUint8Array (ctx, pE, nE));
	return Obj;
}

static const gk_hash_t *GetRsaHash (JSContext *ctx, JSValueConst v, boolean bSign, const char *pFunction)
{
	const gk_hash_t *pHash = 0;
	if (JS_IsString (v))
	{
		const char *pName = JS_ToCString (ctx, v);
		if (pName == 0)
		{
			return 0;
		}
		pHash = gk_hash_find (pName);
		JS_FreeCString (ctx, pName);
	}
	if (pHash == 0 || (bSign && pHash == &gk_hash_sha1))
	{
		JS_ThrowTypeError (ctx, "%s: hash must be %s\"SHA-224\", \"SHA-256\", \"SHA-384\" or \"SHA-512\"",
				   pFunction, bSign ? "" : "\"SHA-1\", ");
		return 0;
	}
	return pHash;
}

// Before a deadline in clock ticks (wraps around)
static boolean Before (unsigned nDeadline)
{
	return (int) (CTimer::Get ()->GetClockTicks () - nDeadline) < 0;
}

// RsaPrivateKey.sign as a job (jobs.h): the steps of gk_rsa_job_step, as
// many as fit in a slice (the CRT's exponentiations, each one, for big keys)
struct TGkRsaSignJob
{
	JSValue KeyObject;		// held: the key stays alive (destroy() still wipes it)
	TGkRsa *pRsa;
	gk_rsa_job_t *pJob;
	int nResult;			// 1: under way
	boolean bDestroyed;		// the key was, before the end
	boolean bDecrypt;		// else a signature
};

static boolean RsaSignStep (void *pParam, unsigned nDeadline)
{
	TGkRsaSignJob *pState = (TGkRsaSignJob *) pParam;
	do
	{
		if (pState->pRsa->pKey == 0)
		{
			pState->bDestroyed = TRUE;
			return FALSE;
		}
		pState->nResult = gk_rsa_job_step (pState->pJob, pState->pRsa->pKey, RsaRandom, 0);
	}
	while (pState->nResult > 0 && Before (nDeadline));
	return pState->nResult > 0;
}

static double RsaSignProgress (void *pParam)
{
	return gk_rsa_job_progress (((TGkRsaSignJob *) pParam)->pJob);
}

static JSValue RsaSignFinish (JSContext *ctx, void *pParam)
{
	TGkRsaSignJob *pState = (TGkRsaSignJob *) pParam;
	if (pState->bDestroyed)
	{
		return JS_ThrowTypeError (ctx, pState->bDecrypt
					  ? "RsaPrivateKey.decrypt: the key was destroyed before the decryption"
					  : "RsaPrivateKey.sign: the key was destroyed before the signature was made");
	}
	switch (pState->nResult)
	{
	case GK_RSA_OK:
	{
		size_t nLength;
		const u8 *pSig = gk_rsa_job_result (pState->pJob, &nLength);
		return NewUint8Array (ctx, pSig, nLength);
	}
	case GK_RSA_RNG:
		return ThrowRNGFailure (ctx);
	default:
		CLogger::Get ()->Write ("crypto", LogError, "RSA private operation failed its check (%d)", pState->nResult);
		return JS_ThrowInternalError (ctx, "RsaPrivateKey.%s: the result failed its check "
					      "(a hardware fault?): none returned", pState->bDecrypt ? "decrypt" : "sign");
	}
}

static void RsaSignFree (JSContext *ctx, void *pParam)
{
	TGkRsaSignJob *pState = (TGkRsaSignJob *) pParam;
	gk_rsa_job_end (pState->pJob);
	JS_FreeValue (ctx, pState->KeyObject);
	delete pState;
}

static const TGkJobOps s_RsaSignJob = { "RSA signature", RsaSignStep, RsaSignProgress, RsaSignFinish, RsaSignFree };

// RsaPrivateKey.sign(hash, digest, { onProgress }?) -> Promise<Uint8Array(modulus bytes)>
static JSValue js_rsa_sign (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkRsa *pRsa = GetRsa (ctx, this_val, "sign", TRUE);
	if (pRsa == 0)
	{
		return JS_EXCEPTION;
	}
	const gk_hash_t *pHash = GetRsaHash (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, TRUE, "RsaPrivateKey.sign");
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}
	u8 Digest[GK_HASH_MAX_DIGEST];
	if (!GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, Digest, pHash->digest_size, "RsaPrivateKey.sign", "digest"))
	{
		return JS_EXCEPTION;
	}
	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "RsaPrivateKey.sign", &OnProgress))
	{
		return JS_EXCEPTION;
	}

	gk_rsa_job_t *pJob;
	int nResult = gk_rsa_sign_begin (&pJob, pRsa->pKey, pHash, Digest, pHash->digest_size);
	gk_wipe (Digest, sizeof Digest);
	if (nResult != GK_RSA_OK)
	{
		JS_FreeValue (ctx, OnProgress);
		return nResult == GK_RSA_NO_MEMORY ? JS_ThrowOutOfMemory (ctx)
			: JS_ThrowRangeError (ctx, "RsaPrivateKey.sign: the digest can't be signed with this key");
	}
	TGkRsaSignJob *pState = new TGkRsaSignJob;
	pState->KeyObject = JS_DupValue (ctx, this_val);
	pState->pRsa = pRsa;
	pState->pJob = pJob;
	pState->nResult = 1;
	pState->bDestroyed = FALSE;
	pState->bDecrypt = FALSE;
	JSValue Promise = GkJobStart (ctx, &s_RsaSignJob, pState, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

static const TGkJobOps s_RsaDecryptJob = { "RSA decryption", RsaSignStep, RsaSignProgress, RsaSignFinish, RsaSignFree };

// RsaPrivateKey.decrypt(ciphertext, { onProgress }?) -> Promise<Uint8Array>:
// RSAES-PKCS1-v1_5 with implicit rejection (rsa.h)
static JSValue js_rsa_decrypt (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkRsa *pRsa = GetRsa (ctx, this_val, "decrypt", TRUE);
	if (pRsa == 0)
	{
		return JS_EXCEPTION;
	}
	CBytesOnly Cipher (ctx);
	if (!Cipher.Get (argc > 0 ? argv[0] : JS_UNDEFINED, "RsaPrivateKey.decrypt", "ciphertext"))
	{
		return JS_EXCEPTION;
	}
	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "RsaPrivateKey.decrypt", &OnProgress))
	{
		return JS_EXCEPTION;
	}
	gk_rsa_job_t *pJob;
	int nResult = gk_rsa_decrypt_begin (&pJob, pRsa->pKey, Cipher.Data (), Cipher.Length ());
	Cipher.Release ();
	if (nResult != GK_RSA_OK)
	{
		JS_FreeValue (ctx, OnProgress);
		return nResult == GK_RSA_NO_MEMORY ? JS_ThrowOutOfMemory (ctx)
			: JS_ThrowRangeError (ctx, "RsaPrivateKey.decrypt: the ciphertext must be exactly as long as n "
					      "(%u bytes: pad an OpenPGP MPI with zeros on the left) and below n",
					      (gk_rsa_bits (pRsa->pKey) + 7) / 8);
	}
	TGkRsaSignJob *pState = new TGkRsaSignJob;
	pState->KeyObject = JS_DupValue (ctx, this_val);
	pState->pRsa = pRsa;
	pState->pJob = pJob;
	pState->nResult = 1;
	pState->bDestroyed = FALSE;
	pState->bDecrypt = TRUE;
	JSValue Promise = GkJobStart (ctx, &s_RsaDecryptJob, pState, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

static JSValue js_rsa_destroy (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkRsa *pRsa = GetRsa (ctx, this_val, "destroy", FALSE);
	if (pRsa == 0)
	{
		return JS_EXCEPTION;
	}
	RsaDestroy (pRsa);
	return JS_UNDEFINED;
}

// rsaVerify(signature, hash, digest, { n, e }) -> boolean
static JSValue js_crypto_rsa_verify (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!HashesOK (ctx))
	{
		return JS_EXCEPTION;
	}
	CBytesOnly Sig (ctx);
	if (!Sig.Get (argc > 0 ? argv[0] : JS_UNDEFINED, "rsaVerify", "signature"))
	{
		return JS_EXCEPTION;
	}
	const gk_hash_t *pHash = GetRsaHash (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, FALSE, "rsaVerify");
	u8 Digest[GK_HASH_MAX_DIGEST];
	if (   pHash == 0
	    || !GetFixed (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, Digest, pHash->digest_size, "rsaVerify", "digest"))
	{
		return JS_EXCEPTION;
	}
	CRsaNumbers Key (ctx);
	if (!Key.Get (argc > 3 ? argv[3] : JS_UNDEFINED, CRsaNumbers::Public, 0, "rsaVerify"))
	{
		return JS_EXCEPTION;
	}
	return JS_NewBool (ctx, gk_rsa_verify (Key.Data (CRsaNumbers::N), Key.Length (CRsaNumbers::N),
					       Key.Data (CRsaNumbers::E), Key.Length (CRsaNumbers::E),
					       pHash, Digest, pHash->digest_size, Sig.Data (), Sig.Length ()));
}

// --- AES-CFB ----------------------------------------------------------------

static const size_t MaxAesBytes = 2 * 1024 * 1024;	// about 0.2 s on a Pi Zero

// aesCfbEncrypt / aesCfbDecrypt (key, iv, data) -> Uint8Array
static JSValue AesCfb (JSContext *ctx, int argc, JSValueConst *argv, int bDecrypt, const char *pFunction)
{
	if (!AesOK (ctx))
	{
		return JS_EXCEPTION;
	}
	u8 Key[32], IV[GK_AES_BLOCK_SIZE];
	size_t nKey;
	CBytesOnly Data (ctx);
	if (   !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Key, sizeof Key, &nKey, pFunction, "key")
	    || !GetFixed (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, IV, sizeof IV, pFunction, "iv")
	    || !Data.Get (argc > 2 ? argv[2] : JS_UNDEFINED, pFunction, "data"))
	{
		gk_wipe (Key, sizeof Key);
		return JS_EXCEPTION;
	}
	if (nKey != 16 && nKey != 24 && nKey != 32)
	{
		gk_wipe (Key, sizeof Key);
		return JS_ThrowRangeError (ctx, "%s: key must be 16, 24 or 32 bytes (AES-128, -192, -256)", pFunction);
	}
	if (Data.Length () > MaxAesBytes)
	{
		gk_wipe (Key, sizeof Key);
		return JS_ThrowRangeError (ctx, "%s: at most %u bytes per call", pFunction, (unsigned) MaxAesBytes);
	}

	u8 *pOut;
	JSValue Result = NewOutput (ctx, Data.Length (), &pOut);
	if (!JS_IsException (Result))
	{
		int nResult = gk_aes_cfb (Key, nKey, IV, bDecrypt, Data.Data (), pOut, Data.Length (), StopNative, ctx);
		if (nResult != 0)
		{
			JS_FreeValue (ctx, Result);
			Result = ThrowInterrupted (ctx);
		}
	}
	gk_wipe (Key, sizeof Key);
	gk_wipe (IV, sizeof IV);
	return Result;
}

static JSValue js_crypto_aes_cfb_encrypt (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return AesCfb (ctx, argc, argv, 0, "aesCfbEncrypt");
}

static JSValue js_crypto_aes_cfb_decrypt (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return AesCfb (ctx, argc, argv, 1, "aesCfbDecrypt");
}

// --- OpenPGP S2K ------------------------------------------------------------

static const uint32_t MaxS2kLength = GK_S2K_MAX_OUTPUT;
static const size_t MaxS2kPassphrase = 65536;

// openpgpS2k as a job: hashing, 64 KiB at a time (about 4 ms with
// SHA-256 on a Pi Zero), until the slice's deadline
struct TGkS2kJob
{
	gk_s2k_job_t Job;
};

static boolean S2kStep (void *pParam, unsigned nDeadline)
{
	gk_s2k_job_t *pJob = &((TGkS2kJob *) pParam)->Job;
	boolean bMore;
	do
	{
		bMore = gk_s2k_step (pJob, 64 * 1024);
	}
	while (bMore && Before (nDeadline));
	return bMore;
}

static double S2kProgress (void *pParam)
{
	return gk_s2k_progress (&((TGkS2kJob *) pParam)->Job);
}

static JSValue S2kFinish (JSContext *ctx, void *pParam)
{
	gk_s2k_job_t *pJob = &((TGkS2kJob *) pParam)->Job;
	return NewUint8Array (ctx, pJob->out, pJob->outlen);	// the JS heap: wiped when freed
}

static void S2kFree (JSContext *ctx, void *pParam)
{
	TGkS2kJob *pState = (TGkS2kJob *) pParam;
	gk_s2k_end (&pState->Job);
	delete pState;
}

static const TGkJobOps s_S2kJob = { "S2K", S2kStep, S2kProgress, S2kFinish, S2kFree };

static boolean IsAbsent (JSValueConst v)
{
	return JS_IsUndefined (v) || JS_IsNull (v);
}

// openpgpS2k(type, hash, passphrase, salt, count, length, { onProgress }?)
//   -> Promise<Uint8Array(length)>
static JSValue js_crypto_openpgp_s2k (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!S2kOK (ctx))
	{
		return JS_EXCEPTION;
	}
	JSValueConst Args[7];
	for (int i = 0; i < 7; i++)
	{
		Args[i] = i < argc ? argv[i] : JS_UNDEFINED;
	}

	double fType, fLength;
	if (JS_ToFloat64 (ctx, &fType, Args[0]) || JS_ToFloat64 (ctx, &fLength, Args[5]))
	{
		return JS_EXCEPTION;
	}
	if (!(fType == 0 || fType == 1 || fType == 3))
	{
		return JS_ThrowRangeError (ctx, "openpgpS2k: type must be 0 (simple), 1 (salted) "
					   "or 3 (iterated and salted)");
	}
	int nType = (int) fType;
	if (!(fLength >= 1 && fLength <= MaxS2kLength && fLength == (uint32_t) fLength))
	{
		return JS_ThrowRangeError (ctx, "openpgpS2k: length must be a whole number from 1 to %u",
					   (unsigned) MaxS2kLength);
	}
	const gk_hash_t *pHash = GetHashName (ctx, Args[1], "openpgpS2k");
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}

	u8 Salt[GK_S2K_SALT_SIZE];
	if (nType == GK_S2K_SIMPLE)
	{
		if (!IsAbsent (Args[3]))
		{
			return JS_ThrowTypeError (ctx, "openpgpS2k: type 0 has no salt (pass null)");
		}
	}
	else if (!GetFixed (ctx, Args[3], Salt, sizeof Salt, "openpgpS2k", "salt"))
	{
		return JS_EXCEPTION;
	}

	uint32_t nCoded = 0;
	if (nType == GK_S2K_ITERATED)
	{
		double fCount;
		if (JS_ToFloat64 (ctx, &fCount, Args[4]))
		{
			return JS_EXCEPTION;
		}
		if (!(fCount >= 0 && fCount <= 255 && fCount == (uint32_t) fCount))
		{
			return JS_ThrowRangeError (ctx, "openpgpS2k: count must be the coded count octet, 0 to 255");
		}
		nCoded = (uint32_t) fCount;
	}
	else if (!IsAbsent (Args[4]))
	{
		return JS_ThrowTypeError (ctx, "openpgpS2k: only type 3 has a count (pass null)");
	}

	CBytesArg Passphrase (ctx);
	boolean bException;
	if (!Passphrase.Get (Args[2], &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "openpgpS2k", "passphrase");
	}
	if (Passphrase.Length () > MaxS2kPassphrase)
	{
		return JS_ThrowRangeError (ctx, "openpgpS2k: the passphrase may be at most %u bytes",
					   (unsigned) MaxS2kPassphrase);
	}
	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, Args[6], "openpgpS2k", &OnProgress))
	{
		return JS_EXCEPTION;
	}

	TGkS2kJob *pState = new TGkS2kJob;
	int nResult = gk_s2k_begin (&pState->Job, pHash, nType, Passphrase.Data (), Passphrase.Length (), Salt,
				    (uint8_t) nCoded, (size_t) fLength);
	Passphrase.Release ();
	gk_wipe (Salt, sizeof Salt);
	if (nResult != 0)
	{
		delete pState;
		JS_FreeValue (ctx, OnProgress);
		return JS_ThrowOutOfMemory (ctx);
	}
	JSValue Promise = GkJobStart (ctx, &s_S2kJob, pState, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

// An Error (not a TypeError or RangeError): a check of the data failed
static JSValue ThrowPlainError (JSContext *ctx, const char *pFormat, ...)
{
	char Message[256];
	va_list Args;
	va_start (Args, pFormat);
	vsnprintf (Message, sizeof Message, pFormat, Args);
	va_end (Args);
	JSValue Error = JS_NewError (ctx);
	JS_DefinePropertyValueStr (ctx, Error, "message", JS_NewString (ctx, Message),
				   JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	return JS_Throw (ctx, Error);
}

// --- pbkdf2Async ------------------------------------------------------------

// pbkdf2 as a job: 64 iterations at a time (about 4 ms with SHA-512 on a
// Pi Zero), until the slice's deadline
struct TGkPbkdf2Job
{
	gk_pbkdf2_job_t Job;
};

static boolean Pbkdf2Step (void *pParam, unsigned nDeadline)
{
	gk_pbkdf2_job_t *pJob = &((TGkPbkdf2Job *) pParam)->Job;
	boolean bMore;
	do
	{
		bMore = gk_pbkdf2_step (pJob, 64);
	}
	while (bMore && Before (nDeadline));
	return bMore;
}

static double Pbkdf2Progress (void *pParam)
{
	return gk_pbkdf2_progress (&((TGkPbkdf2Job *) pParam)->Job);
}

static JSValue Pbkdf2Finish (JSContext *ctx, void *pParam)
{
	gk_pbkdf2_job_t *pJob = &((TGkPbkdf2Job *) pParam)->Job;
	return NewUint8Array (ctx, pJob->out, pJob->outlen);
}

static void Pbkdf2Free (JSContext *ctx, void *pParam)
{
	TGkPbkdf2Job *pState = (TGkPbkdf2Job *) pParam;
	gk_pbkdf2_end (&pState->Job);
	delete pState;
}

static const TGkJobOps s_Pbkdf2Job = { "PBKDF2", Pbkdf2Step, Pbkdf2Progress, Pbkdf2Finish, Pbkdf2Free };

// pbkdf2Async(hash, password, salt, iterations, length, { onProgress }?) -> Promise<Uint8Array(length)>
static JSValue js_crypto_pbkdf2_async (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!HashesOK (ctx) || !Pbkdf2OK (ctx))
	{
		return JS_EXCEPTION;
	}
	const gk_hash_t *pHash = GetHashName (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "pbkdf2Async");
	if (pHash == 0)
	{
		return JS_EXCEPTION;
	}
	double fIterations, fLength;
	if (argc < 5 || JS_ToFloat64 (ctx, &fIterations, argv[3]) || JS_ToFloat64 (ctx, &fLength, argv[4]))
	{
		return JS_ThrowTypeError (ctx, "pbkdf2Async: (hash, password, salt, iterations, length) expected");
	}
	if (!(fIterations >= 1 && fIterations <= MaxPbkdf2Iterations && fIterations == (uint32_t) fIterations))
	{
		return JS_ThrowRangeError (ctx, "pbkdf2Async: iterations must be a whole number from 1 to %u",
					   (unsigned) MaxPbkdf2Iterations);
	}
	if (!(fLength >= 1 && fLength <= MaxPbkdf2Length && fLength == (uint32_t) fLength))
	{
		return JS_ThrowRangeError (ctx, "pbkdf2Async: length must be a whole number from 1 to %u",
					   (unsigned) MaxPbkdf2Length);
	}
	CBytesArg Password (ctx), Salt (ctx);
	boolean bException;
	if (!Password.Get (argv[1], &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "pbkdf2Async", "password");
	}
	if (!Salt.Get (argv[2], &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, "pbkdf2Async", "salt");
	}
	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, argc > 5 ? argv[5] : JS_UNDEFINED, "pbkdf2Async", &OnProgress))
	{
		return JS_EXCEPTION;
	}
	TGkPbkdf2Job *pState = new TGkPbkdf2Job;
	int nResult = gk_pbkdf2_begin (&pState->Job, pHash, Password.Data (), Password.Length (),
				       Salt.Data (), Salt.Length (), (uint32_t) fIterations, (size_t) fLength);
	Password.Release ();
	Salt.Release ();
	if (nResult != 0)
	{
		delete pState;
		JS_FreeValue (ctx, OnProgress);
		return JS_ThrowOutOfMemory (ctx);
	}
	JSValue Promise = GkJobStart (ctx, &s_Pbkdf2Job, pState, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

// --- X25519 -----------------------------------------------------------------

static int X25519Test (void) { return gk_x25519_selftest (); }

static boolean X25519OK (JSContext *ctx)
{
	static int s_nResult = -1;
	return GroupOK (ctx, &s_nResult, "X25519", X25519Test);
}

struct TGkX25519
{
	u8 Secret[GK_X25519_SIZE];
	u8 Public[GK_X25519_SIZE];
	boolean bDestroyed;
};

static JSClassID s_X25519Class;

static void X25519Finalizer (JSRuntime *rt, JSValue Val)
{
	TGkX25519 *pKey = (TGkX25519 *) JS_GetOpaque (Val, s_X25519Class);
	if (pKey != 0)
	{
		gk_wipe (pKey, sizeof *pKey);
		js_free_rt (rt, pKey);
	}
}

// x25519PrivateKey(secret) -> X25519PrivateKey
static JSValue js_crypto_x25519_private_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CSecret Secret;
	if (   !X25519OK (ctx)
	    || !GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, *Secret, 32, "x25519PrivateKey", "secret"))
	{
		return JS_EXCEPTION;
	}
	JSValue Obj = JS_NewObjectClass (ctx, s_X25519Class);
	TGkX25519 *pKey = JS_IsException (Obj) ? 0 : (TGkX25519 *) js_mallocz (ctx, sizeof (TGkX25519));
	if (pKey == 0)
	{
		JS_FreeValue (ctx, Obj);
		return JS_EXCEPTION;
	}
	memcpy (pKey->Secret, *Secret, 32);
	gk_x25519_public (pKey->Secret, pKey->Public);
	JS_SetOpaque (Obj, pKey);
	return Obj;
}

static JSValue js_x25519_get_public_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkX25519 *pKey = (TGkX25519 *) JS_GetOpaque2 (ctx, this_val, s_X25519Class);
	return pKey != 0 ? NewUint8Array (ctx, pKey->Public, sizeof pKey->Public) : JS_EXCEPTION;
}

// X25519PrivateKey.sharedSecret(peerPublic) -> Uint8Array(32)
static JSValue js_x25519_shared_secret (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkX25519 *pKey = (TGkX25519 *) JS_GetOpaque2 (ctx, this_val, s_X25519Class);
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	if (pKey->bDestroyed)
	{
		return JS_ThrowTypeError (ctx, "X25519PrivateKey.sharedSecret: the key was destroyed");
	}
	u8 Peer[GK_X25519_SIZE];
	if (!GetFixed (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Peer, sizeof Peer, "X25519PrivateKey.sharedSecret",
		       "peerPublic"))
	{
		return JS_EXCEPTION;
	}
	CSecret Shared;
	if (gk_x25519_shared (pKey->Secret, Peer, *Shared) != 0)
	{
		return JS_ThrowRangeError (ctx, "X25519PrivateKey.sharedSecret: the shared secret is zero "
					   "(the peer's key is of small order): refused");
	}
	return NewUint8Array (ctx, *Shared, 32);
}

static JSValue js_x25519_destroy (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkX25519 *pKey = (TGkX25519 *) JS_GetOpaque2 (ctx, this_val, s_X25519Class);
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	gk_wipe (pKey->Secret, sizeof pKey->Secret);
	pKey->bDestroyed = TRUE;
	return JS_UNDEFINED;
}

// --- AES key wrap -----------------------------------------------------------

static const size_t MaxWrapBytes = 4096;

static JSValue KeyWrap (JSContext *ctx, int argc, JSValueConst *argv, boolean bWrap, const char *pFunction)
{
	if (!AesOK (ctx))
	{
		return JS_EXCEPTION;
	}
	u8 Kek[32];
	size_t nKek;
	CBytesOnly Data (ctx);
	if (   !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Kek, sizeof Kek, &nKek, pFunction, "kek")
	    || !Data.Get (argc > 1 ? argv[1] : JS_UNDEFINED, pFunction, bWrap ? "key" : "wrapped"))
	{
		gk_wipe (Kek, sizeof Kek);
		return JS_EXCEPTION;
	}
	size_t nLength = Data.Length ();
	if (nKek != 16 && nKek != 24 && nKek != 32)
	{
		gk_wipe (Kek, sizeof Kek);
		return JS_ThrowRangeError (ctx, "%s: kek must be 16, 24 or 32 bytes", pFunction);
	}
	if (nLength % 8 != 0 || nLength < (bWrap ? 16u : 24u) || nLength > MaxWrapBytes)
	{
		gk_wipe (Kek, sizeof Kek);
		return JS_ThrowRangeError (ctx, "%s: %s must be a multiple of 8 bytes, %u to %u", pFunction,
					   bWrap ? "key" : "wrapped", bWrap ? 16u : 24u, (unsigned) MaxWrapBytes);
	}
	u8 *pOut;
	JSValue Result = NewOutput (ctx, bWrap ? nLength + GK_AES_WRAP_OVERHEAD : nLength - GK_AES_WRAP_OVERHEAD, &pOut);
	if (!JS_IsException (Result))
	{
		int nResult = bWrap ? gk_aes_wrap (Kek, nKek, Data.Data (), nLength, pOut)
				    : gk_aes_unwrap (Kek, nKek, Data.Data (), nLength, pOut);
		if (nResult != 0)
		{
			JS_FreeValue (ctx, Result);	// zeroed by gk_aes_unwrap, the heap wipes it
			Result = ThrowPlainError (ctx, "%s: the integrity check failed (a wrong key, or the data "
						     "was changed)", pFunction);
		}
	}
	gk_wipe (Kek, sizeof Kek);
	return Result;
}

// aesKeyWrap(kek, key) -> Uint8Array(key.length + 8)
static JSValue js_crypto_aes_key_wrap (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return KeyWrap (ctx, argc, argv, TRUE, "aesKeyWrap");
}

// aesKeyUnwrap(kek, wrapped) -> Uint8Array(wrapped.length - 8)
static JSValue js_crypto_aes_key_unwrap (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return KeyWrap (ctx, argc, argv, FALSE, "aesKeyUnwrap");
}

// --- SEIPD v1 ---------------------------------------------------------------

static const size_t MaxSeipdBytes = 8 * 1024 * 1024;

static int SeipdTest (void) { return gk_seipd1_selftest (); }

static boolean SeipdOK (JSContext *ctx)
{
	static int s_nResult = -1;
	return AesOK (ctx) && GroupOK (ctx, &s_nResult, "SEIPD", SeipdTest);
}

// seipdV1Decrypt as a job: 64 KiB decrypted and hashed at a time (about
// 11 ms on a Pi Zero)
struct TGkSeipdJob
{
	gk_seipd1_job_t Job;
};

static boolean SeipdStep (void *pParam, unsigned nDeadline)
{
	gk_seipd1_job_t *pJob = &((TGkSeipdJob *) pParam)->Job;
	boolean bMore;
	do
	{
		bMore = gk_seipd1_step (pJob, 64 * 1024);
	}
	while (bMore && Before (nDeadline));
	return bMore;
}

static double SeipdProgress (void *pParam)
{
	return gk_seipd1_progress (&((TGkSeipdJob *) pParam)->Job);
}

static JSValue SeipdFinish (JSContext *ctx, void *pParam)
{
	gk_seipd1_job_t *pJob = &((TGkSeipdJob *) pParam)->Job;
	const u8 *pPlain;
	size_t nLength;
	if (gk_seipd1_result (pJob, &pPlain, &nLength) != 0)
	{
		return ThrowPlainError (ctx, "seipdV1Decrypt: the integrity check failed (a wrong session key, "
					   "or the message was changed or cut)");
	}
	return NewUint8Array (ctx, pPlain, nLength);
}

static void SeipdFree (JSContext *ctx, void *pParam)
{
	TGkSeipdJob *pState = (TGkSeipdJob *) pParam;
	gk_seipd1_end (&pState->Job);
	delete pState;
}

static const TGkJobOps s_SeipdJob = { "SEIPD v1", SeipdStep, SeipdProgress, SeipdFinish, SeipdFree };

// seipdV1Decrypt(sessionKey, data, { onProgress }?) -> Promise<Uint8Array>
static JSValue js_crypto_seipd_v1_decrypt (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!SeipdOK (ctx))
	{
		return JS_EXCEPTION;
	}
	u8 Key[32];
	size_t nKey;
	CBytesOnly Data (ctx);
	if (   !GetVariable (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, Key, sizeof Key, &nKey, "seipdV1Decrypt", "sessionKey")
	    || !Data.Get (argc > 1 ? argv[1] : JS_UNDEFINED, "seipdV1Decrypt", "data"))
	{
		gk_wipe (Key, sizeof Key);
		return JS_EXCEPTION;
	}
	if (nKey != 16 && nKey != 24 && nKey != 32)
	{
		gk_wipe (Key, sizeof Key);
		return JS_ThrowRangeError (ctx, "seipdV1Decrypt: sessionKey must be 16, 24 or 32 bytes (AES-128, -192, -256)");
	}
	if (Data.Length () < GK_SEIPD1_MIN || Data.Length () > MaxSeipdBytes)
	{
		gk_wipe (Key, sizeof Key);
		return JS_ThrowRangeError (ctx, "seipdV1Decrypt: data must be %u bytes to %u MiB", (unsigned) GK_SEIPD1_MIN,
					   (unsigned) (MaxSeipdBytes >> 20));
	}
	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "seipdV1Decrypt", &OnProgress))
	{
		gk_wipe (Key, sizeof Key);
		return JS_EXCEPTION;
	}
	TGkSeipdJob *pState = new TGkSeipdJob;
	int nResult = gk_seipd1_begin (&pState->Job, Key, nKey, Data.Data (), Data.Length ());
	gk_wipe (Key, sizeof Key);
	Data.Release ();
	if (nResult != 0)
	{
		delete pState;
		JS_FreeValue (ctx, OnProgress);
		return JS_ThrowOutOfMemory (ctx);
	}
	JSValue Promise = GkJobStart (ctx, &s_SeipdJob, pState, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

// The classes, once per runtime; their prototypes, once per context.
static void InitClasses (JSContext *ctx)
{
	JSRuntime *rt = JS_GetRuntime (ctx);
	static const struct { JSClassID *pID; const char *pName; JSClassFinalizer *pFinalizer; } Classes[] =
	{
		{ &s_HashClass, "Hash", HashFinalizer },
		{ &s_Ed25519Class, "Ed25519PrivateKey", Ed25519Finalizer },
		{ &s_RsaClass, "RsaPrivateKey", RsaFinalizer },
		{ &s_X25519Class, "X25519PrivateKey", X25519Finalizer },
	};
	for (unsigned i = 0; i < sizeof Classes / sizeof Classes[0]; i++)
	{
		if (*Classes[i].pID == 0)
		{
			JS_NewClassID (Classes[i].pID);
		}
		if (!JS_IsRegisteredClass (rt, *Classes[i].pID))
		{
			JSClassDef Def;
			memset (&Def, 0, sizeof Def);
			Def.class_name = Classes[i].pName;
			Def.finalizer = Classes[i].pFinalizer;
			JS_NewClass (rt, *Classes[i].pID, &Def);
		}
	}

	JSValue Proto = JS_NewObject (ctx);
	DefineMethod (ctx, Proto, "update", js_hash_update, 1);
	DefineMethod (ctx, Proto, "digest", js_hash_digest, 0);
	DefineMethod (ctx, Proto, "copy", js_hash_copy, 0);
	DefineMethod (ctx, Proto, "destroy", js_hash_destroy, 0);
	DefineGetter (ctx, Proto, "algorithm", js_hash_get_algorithm);
	JS_SetClassProto (ctx, s_HashClass, Proto);

	Proto = JS_NewObject (ctx);
	DefineMethod (ctx, Proto, "sign", js_ed25519_sign, 1);
	DefineMethod (ctx, Proto, "destroy", js_ed25519_destroy, 0);
	DefineGetter (ctx, Proto, "publicKey", js_ed25519_get_public_key);
	JS_SetClassProto (ctx, s_Ed25519Class, Proto);

	Proto = JS_NewObject (ctx);
	DefineMethod (ctx, Proto, "sign", js_rsa_sign, 3);
	DefineMethod (ctx, Proto, "decrypt", js_rsa_decrypt, 2);
	DefineMethod (ctx, Proto, "destroy", js_rsa_destroy, 0);
	DefineGetter (ctx, Proto, "bits", js_rsa_get_bits);
	DefineGetter (ctx, Proto, "publicKey", js_rsa_get_public_key);
	JS_SetClassProto (ctx, s_RsaClass, Proto);

	Proto = JS_NewObject (ctx);
	DefineMethod (ctx, Proto, "sharedSecret", js_x25519_shared_secret, 1);
	DefineMethod (ctx, Proto, "destroy", js_x25519_destroy, 0);
	DefineGetter (ctx, Proto, "publicKey", js_x25519_get_public_key);
	JS_SetClassProto (ctx, s_X25519Class, Proto);
}

static const JSCFunctionListEntry s_CryptoFunctions[] =
{
	JS_CFUNC_DEF ("sha224", 1, js_crypto_sha224),
	JS_CFUNC_DEF ("sha384", 1, js_crypto_sha384),
	JS_CFUNC_DEF ("createHash", 1, js_crypto_create_hash),
	JS_CFUNC_DEF ("ed25519PrivateKey", 1, js_crypto_ed25519_private_key),
	JS_CFUNC_DEF ("ed25519Verify", 3, js_crypto_ed25519_verify),
	JS_CFUNC_DEF ("rsaPrivateKey", 1, js_crypto_rsa_private_key),
	JS_CFUNC_DEF ("rsaVerify", 4, js_crypto_rsa_verify),
	JS_CFUNC_DEF ("aesCfbEncrypt", 3, js_crypto_aes_cfb_encrypt),
	JS_CFUNC_DEF ("aesCfbDecrypt", 3, js_crypto_aes_cfb_decrypt),
	JS_CFUNC_DEF ("openpgpS2k", 7, js_crypto_openpgp_s2k),
	JS_CFUNC_DEF ("pbkdf2Async", 6, js_crypto_pbkdf2_async),
	JS_CFUNC_DEF ("x25519PrivateKey", 1, js_crypto_x25519_private_key),
	JS_CFUNC_DEF ("aesKeyWrap", 2, js_crypto_aes_key_wrap),
	JS_CFUNC_DEF ("aesKeyUnwrap", 2, js_crypto_aes_key_unwrap),
	JS_CFUNC_DEF ("seipdV1Decrypt", 3, js_crypto_seipd_v1_decrypt),
	JS_CFUNC_DEF ("ripemd160", 1, js_crypto_ripemd160),
	JS_CFUNC_DEF ("hash160", 1, js_crypto_hash160),
	JS_CFUNC_DEF ("pbkdf2", 5, js_crypto_pbkdf2),
	JS_CFUNC_DEF ("isPrivateKey", 1, js_crypto_is_private_key),
	JS_CFUNC_DEF ("isPublicKey", 1, js_crypto_is_public_key),
	JS_CFUNC_DEF ("publicKey", 2, js_crypto_public_key),
	JS_CFUNC_DEF ("publicKeyConvert", 2, js_crypto_public_key_convert),
	JS_CFUNC_DEF ("privateKeyTweakAdd", 2, js_crypto_private_key_tweak_add),
	JS_CFUNC_DEF ("publicKeyTweakAdd", 3, js_crypto_public_key_tweak_add),
	JS_CFUNC_DEF ("ecdsaSign", 2, js_crypto_ecdsa_sign),
	JS_CFUNC_DEF ("ecdsaVerify", 3, js_crypto_ecdsa_verify),
	JS_CFUNC_DEF ("xOnlyPublicKey", 1, js_crypto_xonly_public_key),
	JS_CFUNC_DEF ("schnorrSign", 3, js_crypto_schnorr_sign),
	JS_CFUNC_DEF ("schnorrVerify", 3, js_crypto_schnorr_verify),
	JS_CFUNC_DEF ("taprootTweakPublicKey", 2, js_crypto_taproot_tweak_public_key),
	JS_CFUNC_DEF ("taprootTweakPrivateKey", 2, js_crypto_taproot_tweak_private_key),
};

static int CryptoModuleInit (JSContext *ctx, JSModuleDef *m)
{
	InitClasses (ctx);
	JS_SetModuleExportList (ctx, m, s_CryptoFunctions, sizeof s_CryptoFunctions / sizeof s_CryptoFunctions[0]);
	JS_SetModuleExport (ctx, m, "sha1", JS_NewCFunction (ctx, js_crypto_sha1, "sha1", 1));
	JS_SetModuleExport (ctx, m, "sha256", JS_NewCFunction (ctx, js_crypto_sha256, "sha256", 1));
	JS_SetModuleExport (ctx, m, "sha512", JS_NewCFunction (ctx, js_crypto_sha512, "sha512", 1));
	JS_SetModuleExport (ctx, m, "hmac", JS_NewCFunction (ctx, js_crypto_hmac, "hmac", 3));
	JS_SetModuleExport (ctx, m, "randomBytes", JS_NewCFunction (ctx, js_crypto_random_bytes, "randomBytes", 1));
	JS_SetModuleExport (ctx, m, "getRandomValues", JS_NewCFunction (ctx, js_crypto_get_random_values, "getRandomValues", 1));
	JS_SetModuleExport (ctx, m, "rngStatus", JS_NewCFunction (ctx, js_crypto_rng_status, "rngStatus", 0));

	return 0;
}

JSModuleDef *GkInitCryptoModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, CryptoModuleInit);
	if (m == 0)
	{
		return 0;
	}

	JS_AddModuleExport (ctx, m, "sha1");
	JS_AddModuleExport (ctx, m, "sha256");
	JS_AddModuleExport (ctx, m, "sha512");
	JS_AddModuleExport (ctx, m, "hmac");
	JS_AddModuleExport (ctx, m, "randomBytes");
	JS_AddModuleExport (ctx, m, "getRandomValues");
	JS_AddModuleExport (ctx, m, "rngStatus");
	JS_AddModuleExportList (ctx, m, s_CryptoFunctions, sizeof s_CryptoFunctions / sizeof s_CryptoFunctions[0]);

	return m;
}
