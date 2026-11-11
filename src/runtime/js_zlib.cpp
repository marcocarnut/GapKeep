//
// js_zlib.cpp
//
// The "gk:zlib" module: decompression (DEFLATE: raw, as OpenPGP's ZIP, or
// in zlib's format), as a long operation (jobs.h), with a limit on the
// output that the caller must give. See docs/API.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "jobs.h"
#include "inflate.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>

static const size_t MaxInput = 8 * 1024 * 1024;
static const double MaxOutput = 32 * 1024 * 1024;

static int s_nSelfTest = -1;

static boolean InflateOK (JSContext *ctx)
{
	if (s_nSelfTest < 0)
	{
		unsigned nStart = CTimer::Get ()->GetClockTicks ();
		s_nSelfTest = gk_inflate_selftest ();
		unsigned nTicks = CTimer::Get ()->GetClockTicks () - nStart;
		if (s_nSelfTest == 0)
		{
			CLogger::Get ()->Write ("zlib", LogNotice, "inflate self-test passed (%u us)", nTicks);
		}
		else
		{
			CLogger::Get ()->Write ("zlib", LogError, "inflate self-test FAILED (%d)", s_nSelfTest);
		}
	}
	if (s_nSelfTest != 0)
	{
		JS_ThrowInternalError (ctx, "gk:zlib is disabled: its self-test failed");
		return FALSE;
	}
	return TRUE;
}

static boolean Before (unsigned nDeadline)
{
	return (int) (CTimer::Get ()->GetClockTicks () - nDeadline) < 0;
}

struct TGkInflateJob
{
	gk_inflate_job_t Job;
};

// 64 KiB out at a time, until the slice's deadline
static boolean InflateStep (void *pParam, unsigned nDeadline)
{
	gk_inflate_job_t *pJob = &((TGkInflateJob *) pParam)->Job;
	boolean bMore;
	do
	{
		bMore = gk_inflate_step (pJob, 64 * 1024);
	}
	while (bMore && Before (nDeadline));
	return bMore;
}

static double InflateProgress (void *pParam)
{
	return gk_inflate_progress (&((TGkInflateJob *) pParam)->Job);
}

static JSValue ThrowError (JSContext *ctx, const char *pMessage)
{
	JSValue Error = JS_NewError (ctx);
	JS_DefinePropertyValueStr (ctx, Error, "message", JS_NewString (ctx, pMessage),
				   JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	return JS_Throw (ctx, Error);
}

static void FreeOutput (JSRuntime *rt, void *pOpaque, void *pData)
{
	gk_inflate_free_output (pData);
}

static JSValue InflateFinish (JSContext *ctx, void *pParam)
{
	gk_inflate_job_t *pJob = &((TGkInflateJob *) pParam)->Job;
	uint8_t *pOut;
	size_t nLength;
	switch (gk_inflate_result (pJob, &pOut, &nLength))
	{
	case 0:
	{
		// the native buffer becomes the ArrayBuffer's (no copy of what
		// may be megabytes, in one slice); wiped when it is freed
		JSValue Buffer = JS_NewArrayBuffer (ctx, pOut, nLength, FreeOutput, 0, FALSE);
		if (JS_IsException (Buffer))
		{
			gk_inflate_free_output (pOut);		// not taken
			return Buffer;
		}
		JSValueConst Args[3] = { Buffer, JS_NewInt32 (ctx, 0), JS_UNDEFINED };
		JSValue Array = JS_NewTypedArray (ctx, 3, Args, JS_TYPED_ARRAY_UINT8);
		JS_FreeValue (ctx, Buffer);
		return Array;
	}
	case GK_INFLATE_TOO_BIG:
		return JS_ThrowRangeError (ctx, "inflate: the data decompresses to more than maxOutput bytes");
	case GK_INFLATE_NO_MEMORY:
		return JS_ThrowOutOfMemory (ctx);
	default:
		return ThrowError (ctx, "inflate: not valid compressed data (or cut short, or followed by more)");
	}
}

static void InflateFree (JSContext *ctx, void *pParam)
{
	TGkInflateJob *pState = (TGkInflateJob *) pParam;
	gk_inflate_end (&pState->Job);
	delete pState;
}

static const TGkJobOps s_InflateJob = { "inflate", InflateStep, InflateProgress, InflateFinish, InflateFree };

// inflate(data, { format, maxOutput, onProgress }) -> Promise<Uint8Array>
static JSValue js_zlib_inflate (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!InflateOK (ctx))
	{
		return JS_EXCEPTION;
	}
	JSValueConst Options = argc > 1 ? argv[1] : JS_UNDEFINED;
	if (!JS_IsObject (Options))
	{
		return JS_ThrowTypeError (ctx, "inflate: options { format, maxOutput } expected");
	}

	int nFormat;
	JSValue Format = JS_GetPropertyStr (ctx, Options, "format");
	const char *pFormat = JS_IsString (Format) ? JS_ToCString (ctx, Format) : 0;
	JS_FreeValue (ctx, Format);
	if (pFormat != 0 && strcmp (pFormat, "raw") == 0)
	{
		nFormat = GK_INFLATE_RAW;
	}
	else if (pFormat != 0 && strcmp (pFormat, "zlib") == 0)
	{
		nFormat = GK_INFLATE_ZLIB;
	}
	else
	{
		if (pFormat != 0) JS_FreeCString (ctx, pFormat);
		return JS_ThrowTypeError (ctx, "inflate: format must be \"raw\" (DEFLATE; OpenPGP's ZIP) "
					  "or \"zlib\" (OpenPGP's ZLIB)");
	}
	JS_FreeCString (ctx, pFormat);

	double fMax;
	JSValue Max = JS_GetPropertyStr (ctx, Options, "maxOutput");
	boolean bNumber = JS_IsNumber (Max);
	int nError = bNumber ? JS_ToFloat64 (ctx, &fMax, Max) : 0;
	JS_FreeValue (ctx, Max);
	if (!bNumber || nError)
	{
		return JS_ThrowTypeError (ctx, "inflate: maxOutput (the most bytes the data may decompress to) "
					  "must be given");
	}
	if (!(fMax >= 1 && fMax <= MaxOutput && fMax == (double) (size_t) fMax))
	{
		return JS_ThrowRangeError (ctx, "inflate: maxOutput must be a whole number from 1 to %u MiB in bytes",
					   (unsigned) (MaxOutput / (1024 * 1024)));
	}

	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, Options, "inflate", &OnProgress))
	{
		return JS_EXCEPTION;
	}

	// the data: a typed array or ArrayBuffer
	size_t nOffset = 0, nLength = 0, nElement, nSize;
	JSValueConst Data = argc > 0 ? argv[0] : JS_UNDEFINED;
	JSValue Buffer = JS_GetTypedArrayBuffer (ctx, Data, &nOffset, &nLength, &nElement);
	uint8_t *p;
	if (!JS_IsException (Buffer))
	{
		p = JS_GetArrayBuffer (ctx, &nSize, Buffer);
		p = p != 0 ? p + nOffset : 0;
	}
	else
	{
		JS_FreeValue (ctx, JS_GetException (ctx));
		Buffer = JS_UNDEFINED;
		p = JS_GetArrayBuffer (ctx, &nLength, Data);
		if (p == 0)
		{
			JS_FreeValue (ctx, JS_GetException (ctx));
		}
	}
	if (p == 0)
	{
		JS_FreeValue (ctx, Buffer);
		JS_FreeValue (ctx, OnProgress);
		return JS_ThrowTypeError (ctx, "inflate: data must be a Uint8Array (or other typed array) or an ArrayBuffer");
	}
	if (nLength > MaxInput)
	{
		JS_FreeValue (ctx, Buffer);
		JS_FreeValue (ctx, OnProgress);
		return JS_ThrowRangeError (ctx, "inflate: at most %u MiB of data", (unsigned) (MaxInput >> 20));
	}

	TGkInflateJob *pState = new TGkInflateJob;
	int nResult = gk_inflate_begin (&pState->Job, nFormat, p, nLength, (size_t) fMax);
	JS_FreeValue (ctx, Buffer);
	if (nResult != 0)
	{
		delete pState;
		JS_FreeValue (ctx, OnProgress);
		return JS_ThrowOutOfMemory (ctx);
	}
	JSValue Promise = GkJobStart (ctx, &s_InflateJob, pState, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

static const JSCFunctionListEntry s_ZlibFunctions[] =
{
	JS_CFUNC_DEF ("inflate", 2, js_zlib_inflate),
};

static int ZlibModuleInit (JSContext *ctx, JSModuleDef *m)
{
	return JS_SetModuleExportList (ctx, m, s_ZlibFunctions, sizeof s_ZlibFunctions / sizeof s_ZlibFunctions[0]);
}

JSModuleDef *GkInitZlibModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, ZlibModuleInit);
	if (m != 0)
	{
		JS_AddModuleExportList (ctx, m, s_ZlibFunctions, sizeof s_ZlibFunctions / sizeof s_ZlibFunctions[0]);
	}
	return m;
}
