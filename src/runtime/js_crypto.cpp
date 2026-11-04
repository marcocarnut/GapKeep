//
// js_crypto.cpp
//
// The "zg:crypto" module: SHA-1, SHA-256, SHA-512, HMAC, and health-checked
// hardware random bytes.
// See docs/API.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "../crypto/hmac.h"
#include "../crypto/hwrng.h"
#include <circle/util.h>
#include <circle/logger.h>
#include <circle/timer.h>

static const unsigned MaxRandomBytes = 65536;	// as WebCrypto's getRandomValues

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
		s_nResult = zg_hmac_selftest ();
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
static JSValue Digest (JSContext *ctx, int argc, JSValueConst *argv, const zg_hash_t *pHash,
		       const char *pFunction)
{
	if (pHash != &zg_hash_sha256 && !HashesOK (ctx))
	{
		return JS_EXCEPTION;
	}

	CBytesArg Data (ctx);
	boolean bException;
	if (!Data.Get (argc > 0 ? argv[0] : JS_UNDEFINED, &bException))
	{
		return bException ? JS_EXCEPTION : ThrowBytesExpected (ctx, pFunction, "data");
	}

	u8 Digest[ZG_HASH_MAX_DIGEST];
	zg_hash_ctx_t Hash;
	pHash->init (&Hash);
	pHash->update (&Hash, Data.Data (), Data.Length ());
	pHash->final (&Hash, Digest);
	Data.Release ();

	JSValue Result = NewUint8Array (ctx, Digest, pHash->digest_size);
	memset (Digest, 0, sizeof Digest);

	return Result;
}

static JSValue js_crypto_sha1 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &zg_hash_sha1, "sha1");
}

static JSValue js_crypto_sha256 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &zg_hash_sha256, "sha256");
}

static JSValue js_crypto_sha512 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return Digest (ctx, argc, argv, &zg_hash_sha512, "sha512");
}

// hmac(hash, key, data) -> Uint8Array; hash: "SHA-1", "SHA-256", "SHA-512"
static JSValue js_crypto_hmac (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!HashesOK (ctx))
	{
		return JS_EXCEPTION;
	}

	const zg_hash_t *pHash = 0;
	if (argc > 0 && JS_IsString (argv[0]))
	{
		const char *pName = JS_ToCString (ctx, argv[0]);
		if (pName == 0)
		{
			return JS_EXCEPTION;
		}
		pHash = zg_hash_find (pName);
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

	u8 Mac[ZG_HASH_MAX_DIGEST];
	zg_hmac (pHash, Key.Data (), Key.Length (), Data.Data (), Data.Length (), Mac);
	Key.Release ();
	Data.Release ();

	JSValue Result = NewUint8Array (ctx, Mac, pHash->digest_size);
	memset (Mac, 0, sizeof Mac);

	return Result;
}

static JSValue ThrowRNGFailure (JSContext *ctx)
{
	CZgRandom *pRNG = CZgRandom::Instance ();
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

	CZgRandom *pRNG = CZgRandom::Instance ();
	u8 *pBuffer = new u8[n ? n : 1];
	if (pRNG == 0 || !pRNG->Get (pBuffer, n))
	{
		delete [] pBuffer;
		return ThrowRNGFailure (ctx);
	}

	JSValue Result = NewUint8Array (ctx, pBuffer, n);
	memset (pBuffer, 0, n);
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

	CZgRandom *pRNG = CZgRandom::Instance ();
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
	CZgRandom *pRNG = CZgRandom::Instance ();

	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "healthy", JS_NewBool (ctx, pRNG && pRNG->IsHealthy ()));
	JS_SetPropertyStr (ctx, Obj, "failure", pRNG && pRNG->GetFailure ()
				? JS_NewString (ctx, pRNG->GetFailure ()) : JS_NULL);
	JS_SetPropertyStr (ctx, Obj, "rawBytes", JS_NewInt64 (ctx, pRNG ? (int64_t) pRNG->GetRawBytes () : 0));

	return Obj;
}

static int CryptoModuleInit (JSContext *ctx, JSModuleDef *m)
{
	JS_SetModuleExport (ctx, m, "sha1", JS_NewCFunction (ctx, js_crypto_sha1, "sha1", 1));
	JS_SetModuleExport (ctx, m, "sha256", JS_NewCFunction (ctx, js_crypto_sha256, "sha256", 1));
	JS_SetModuleExport (ctx, m, "sha512", JS_NewCFunction (ctx, js_crypto_sha512, "sha512", 1));
	JS_SetModuleExport (ctx, m, "hmac", JS_NewCFunction (ctx, js_crypto_hmac, "hmac", 3));
	JS_SetModuleExport (ctx, m, "randomBytes", JS_NewCFunction (ctx, js_crypto_random_bytes, "randomBytes", 1));
	JS_SetModuleExport (ctx, m, "getRandomValues", JS_NewCFunction (ctx, js_crypto_get_random_values, "getRandomValues", 1));
	JS_SetModuleExport (ctx, m, "rngStatus", JS_NewCFunction (ctx, js_crypto_rng_status, "rngStatus", 0));

	return 0;
}

JSModuleDef *ZgInitCryptoModule (JSContext *ctx, const char *pName)
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

	return m;
}
