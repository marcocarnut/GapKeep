//
// js_session.cpp
//
// The "zg:session" module: values an app keeps across its runs, in RAM,
// until the device is switched off (session.h). See docs/API.md.
//
// Values are serialized with QuickJS's object writer, without bytecode or
// references: plain data (objects, arrays, strings, numbers, booleans,
// null, BigInt, Date, ArrayBuffer and typed arrays), copied in and out, as
// a structured clone. Functions, classes' instances with getters, Map, Set
// and cycles are refused. The serialized bytes are made in the app's heap,
// which overwrites what it frees.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "session.h"
#include <circle/util.h>

static const size_t MaxOwner = 128;

// "<id>:<hash>"
static void GetOwner (JSContext *ctx, char *pOwner)
{
	const zg_app_t *pBundle = CAppHost::GetApp (ctx)->pBundle;
	size_t nID = strlen (pBundle->id);
	size_t nHash = pBundle->hash ? strlen (pBundle->hash) : 0;
	if (nID + 1 + nHash + 1 > MaxOwner)
	{
		nHash = MaxOwner - nID - 2;	// ids are short; can't happen
	}
	memcpy (pOwner, pBundle->id, nID);
	pOwner[nID] = ':';
	memcpy (pOwner + nID + 1, pBundle->hash ? pBundle->hash : "", nHash);
	pOwner[nID + 1 + nHash] = '\0';
}

// The key argument: a string of 1 to MaxKeyLength bytes. 0 (exception
// set) if not; else free with JS_FreeCString.
static const char *GetKey (JSContext *ctx, int argc, JSValueConst *argv, const char *pFunction)
{
	if (argc < 1 || !JS_IsString (argv[0]))
	{
		JS_ThrowTypeError (ctx, "session.%s: the key must be a string", pFunction);
		return 0;
	}
	size_t nLength;
	const char *pKey = JS_ToCStringLen (ctx, &nLength, argv[0]);
	if (pKey == 0)
	{
		return 0;
	}
	if (nLength == 0 || nLength > CZgSession::MaxKeyLength || strlen (pKey) != nLength)
	{
		JS_FreeCString (ctx, pKey);
		JS_ThrowRangeError (ctx, "session.%s: the key must be 1 to %u bytes, without NUL",
				    pFunction, (unsigned) CZgSession::MaxKeyLength);
		return 0;
	}
	return pKey;
}

// set(key, value): undefined removes the key
static JSValue js_session_set (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const char *pKey = GetKey (ctx, argc, argv, "set");
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	char Owner[MaxOwner];
	GetOwner (ctx, Owner);

	JSValueConst Value = argc > 1 ? argv[1] : JS_UNDEFINED;
	if (JS_IsUndefined (Value))
	{
		CZgSession::Remove (Owner, pKey);
		JS_FreeCString (ctx, pKey);
		return JS_UNDEFINED;
	}

	size_t nSize;
	u8 *pData = JS_WriteObject (ctx, &nSize, Value, 0);
	if (pData == 0)
	{
		JS_FreeCString (ctx, pKey);
		return JS_EXCEPTION;	// "unsupported object class", "circular reference", ...
	}

	CZgSession::TResult Result = CZgSession::Set (Owner, pKey, pData, nSize);
	js_free (ctx, pData);		// the heap overwrites it
	JS_FreeCString (ctx, pKey);

	switch (Result)
	{
	case CZgSession::TooBig:
		return JS_ThrowRangeError (ctx, "session.set: over this app's %u KiB (the value takes %u bytes)",
					   (unsigned) (CZgSession::MaxPerApp / 1024), (unsigned) nSize);
	case CZgSession::Full:
		return JS_ThrowRangeError (ctx, "session.set: the session store is full (%u KiB for all apps)",
					   (unsigned) (CZgSession::MaxTotal / 1024));
	default:
		return JS_UNDEFINED;
	}
}

// get(key) -> a copy of the value, or undefined
static JSValue js_session_get (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const char *pKey = GetKey (ctx, argc, argv, "get");
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	char Owner[MaxOwner];
	GetOwner (ctx, Owner);

	size_t nSize;
	const u8 *pData = CZgSession::Get (Owner, pKey, &nSize);
	JS_FreeCString (ctx, pKey);
	if (pData == 0)
	{
		return JS_UNDEFINED;
	}

	return JS_ReadObject (ctx, pData, nSize, 0);
}

// remove(key) -> whether it was there
static JSValue js_session_remove (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const char *pKey = GetKey (ctx, argc, argv, "remove");
	if (pKey == 0)
	{
		return JS_EXCEPTION;
	}
	char Owner[MaxOwner];
	GetOwner (ctx, Owner);

	boolean bRemoved = CZgSession::Remove (Owner, pKey);
	JS_FreeCString (ctx, pKey);

	return JS_NewBool (ctx, bRemoved);
}

static JSValue js_session_clear (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	char Owner[MaxOwner];
	GetOwner (ctx, Owner);
	CZgSession::Clear (Owner);

	return JS_UNDEFINED;
}

// keys() -> string[], in the order they were first set
static JSValue js_session_keys (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	char Owner[MaxOwner];
	GetOwner (ctx, Owner);

	JSValue Array = JS_NewArray (ctx);
	uint32_t n = 0;
	for (const char *pKey = CZgSession::NextKey (Owner, 0); pKey != 0;
	     pKey = CZgSession::NextKey (Owner, pKey))
	{
		JS_SetPropertyUint32 (ctx, Array, n++, JS_NewString (ctx, pKey));
	}

	return Array;
}

// usage() -> { used, limit } in bytes
static JSValue js_session_usage (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	char Owner[MaxOwner];
	GetOwner (ctx, Owner);

	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "used", JS_NewInt64 (ctx, (int64_t) CZgSession::GetUsed (Owner)));
	JS_SetPropertyStr (ctx, Obj, "limit", JS_NewInt64 (ctx, (int64_t) CZgSession::MaxPerApp));

	return Obj;
}

static const JSCFunctionListEntry SessionFunctions[] =
{
	JS_CFUNC_DEF ("set", 2, js_session_set),
	JS_CFUNC_DEF ("get", 1, js_session_get),
	JS_CFUNC_DEF ("remove", 1, js_session_remove),
	JS_CFUNC_DEF ("clear", 0, js_session_clear),
	JS_CFUNC_DEF ("keys", 0, js_session_keys),
	JS_CFUNC_DEF ("usage", 0, js_session_usage),
};

static int SessionModuleInit (JSContext *ctx, JSModuleDef *m)
{
	return JS_SetModuleExportList (ctx, m, SessionFunctions,
				       sizeof SessionFunctions / sizeof SessionFunctions[0]);
}

JSModuleDef *ZgInitSessionModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, SessionModuleInit);
	if (m == 0)
	{
		return 0;
	}
	JS_AddModuleExportList (ctx, m, SessionFunctions, sizeof SessionFunctions / sizeof SessionFunctions[0]);

	return m;
}
