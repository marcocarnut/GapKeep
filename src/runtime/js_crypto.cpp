//
// js_crypto.cpp
//
// The "gk:crypto" module: SHA-1, SHA-256, SHA-512, RIPEMD-160, HMAC,
// PBKDF2, secp256k1 (ECDSA, BIP-340 Schnorr, BIP-32 and Taproot key
// tweaks), and health-checked hardware random bytes.
// See docs/API.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "../crypto/hmac.h"
#include "../crypto/ripemd160.h"
#include "../crypto/pbkdf2.h"
#include "../crypto/secp.h"
#include "../crypto/hwrng.h"
#include "../crypto/wipe.h"
#include <circle/util.h>
#include <circle/logger.h>
#include <circle/timer.h>

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
// If they fail, sha1, sha512 and hmac throw, until reboot.
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
		JS_ThrowInternalError (ctx, "SHA-1, SHA-512 and HMAC are disabled: their self-test failed");
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

// hmac(hash, key, data) -> Uint8Array; hash: "SHA-1", "SHA-256", "SHA-512"
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
		return JS_ThrowTypeError (ctx, "hmac: hash must be \"SHA-1\", \"SHA-256\" or \"SHA-512\"");
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
		JS_ThrowTypeError (ctx, "%s: hash must be \"SHA-1\", \"SHA-256\" or \"SHA-512\"", pFunction);
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

static const JSCFunctionListEntry s_CryptoFunctions[] =
{
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
