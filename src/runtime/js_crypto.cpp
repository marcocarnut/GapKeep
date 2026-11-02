//
// js_crypto.cpp
//
// The "zg:crypto" module: SHA-256 and health-checked hardware random bytes.
// See docs/API.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "../crypto/sha256.h"
#include "../crypto/hwrng.h"
#include <circle/util.h>

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

// sha256(data) -> Uint8Array(32); data: Uint8Array (any typed array),
// ArrayBuffer or string (hashed as UTF-8)
static JSValue js_crypto_sha256 (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValueConst v = argc > 0 ? argv[0] : JS_UNDEFINED;
	u8 Digest[ZG_SHA256_DIGEST_SIZE];

	if (JS_IsString (v))
	{
		size_t nLength;
		const char *p = JS_ToCStringLen (ctx, &nLength, v);
		if (p == 0) return JS_EXCEPTION;
		zg_sha256 (p, nLength, Digest);
		JS_FreeCString (ctx, p);
	}
	else
	{
		JSValue Hold;
		size_t nLength;
		u8 *p = GetBytes (ctx, v, &nLength, &Hold);
		if (p == 0)
		{
			return JS_ThrowTypeError (ctx, "sha256: Uint8Array, ArrayBuffer or string expected");
		}
		zg_sha256 (p, nLength, Digest);
		JS_FreeValue (ctx, Hold);
	}

	JSValue Result = NewUint8Array (ctx, Digest, sizeof Digest);
	memset (Digest, 0, sizeof Digest);

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
	JS_SetModuleExport (ctx, m, "sha256", JS_NewCFunction (ctx, js_crypto_sha256, "sha256", 1));
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

	JS_AddModuleExport (ctx, m, "sha256");
	JS_AddModuleExport (ctx, m, "randomBytes");
	JS_AddModuleExport (ctx, m, "getRandomValues");
	JS_AddModuleExport (ctx, m, "rngStatus");

	return m;
}
