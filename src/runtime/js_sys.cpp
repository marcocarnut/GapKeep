//
// js_sys.cpp
//
// Globals (console, timers) and the "zg:sys" and "zg:apps" modules.
// See docs/API.md for the JavaScript-side documentation.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "version.h"
#include <circle/version.h>
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/string.h>
#include <circle/util.h>
#include <assert.h>

// --- console ----------------------------------------------------------------

// Formats arguments like console.log: strings verbatim, errors with their
// stack, other objects as JSON.
static void FormatArgs (JSContext *ctx, int argc, JSValueConst *argv, CString *pOut)
{
	for (int i = 0; i < argc; i++)
	{
		if (i > 0)
		{
			pOut->Append (" ");
		}

		JSValueConst v = argv[i];
		JSValue Str = JS_UNDEFINED;

		if (   JS_IsObject (v)
		    && !JS_IsFunction (ctx, v)
		    && !JS_IsError (ctx, v))
		{
			Str = JS_JSONStringify (ctx, v, JS_UNDEFINED, JS_UNDEFINED);
			if (JS_IsException (Str))
			{
				JS_FreeValue (ctx, JS_GetException (ctx));
				Str = JS_UNDEFINED;
			}
		}

		if (JS_IsUndefined (Str))
		{
			Str = JS_ToString (ctx, v);
		}

		const char *p = JS_ToCString (ctx, Str);
		if (p != 0)
		{
			pOut->Append (p);
			JS_FreeCString (ctx, p);
		}
		JS_FreeValue (ctx, Str);

		if (JS_IsError (ctx, v))
		{
			JSValue Stack = JS_GetPropertyStr (ctx, v, "stack");
			const char *s = JS_IsString (Stack) ? JS_ToCString (ctx, Stack) : 0;
			if (s != 0)
			{
				pOut->Append ("\n");
				pOut->Append (s);
				JS_FreeCString (ctx, s);
			}
			JS_FreeValue (ctx, Stack);
		}
	}
}

// magic: TLogSeverity
static JSValue js_console_log (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);

	CString Text;
	FormatArgs (ctx, argc, argv, &Text);

	CString Source;
	Source.Format ("app:%s", pApp->pBundle->id);
	CLogger::Get ()->Write (Source, (TLogSeverity) magic, "%s", (const char *) Text);

	return JS_UNDEFINED;
}

// --- timers -----------------------------------------------------------------

struct TZgTimer
{
	TZgTimer *pNext;
	TZgApp *pApp;
	unsigned nID;
	boolean bRepeat;
	lv_timer_t *pLVTimer;
	JSValue Func;
};

static void TimerUnlink (TZgApp *pApp, TZgTimer *pTimer)
{
	for (TZgTimer **pp = &pApp->pTimers; *pp != 0; pp = &(*pp)->pNext)
	{
		if (*pp == pTimer)
		{
			*pp = pTimer->pNext;
			return;
		}
	}
}

static void TimerFree (TZgTimer *pTimer)
{
	lv_timer_delete (pTimer->pLVTimer);
	JS_FreeValue (pTimer->pApp->pContext, pTimer->Func);
	delete pTimer;
}

static TZgTimer *TimerFind (TZgApp *pApp, unsigned nID)
{
	for (TZgTimer *p = pApp->pTimers; p != 0; p = p->pNext)
	{
		if (p->nID == nID)
		{
			return p;
		}
	}

	return 0;
}

static void TimerCallback (lv_timer_t *pLVTimer)
{
	TZgTimer *pTimer = (TZgTimer *) lv_timer_get_user_data (pLVTimer);
	TZgApp *pApp = pTimer->pApp;
	JSContext *ctx = pApp->pContext;

	// the callback may clear this very timer: hold what we need
	JSValue Func = JS_DupValue (ctx, pTimer->Func);
	unsigned nID = pTimer->nID;

	if (!pTimer->bRepeat)
	{
		TimerUnlink (pApp, pTimer);
		TimerFree (pTimer);		// LVGL allows deleting a timer in its callback
	}

	JSValue Result = CAppHost::Get ()->Call (Func, JS_UNDEFINED, 0, 0);
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Func);

	(void) nID;
}

// magic: 1 = setInterval
static JSValue js_set_timer (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);

	if (argc < 1 || !JS_IsFunction (ctx, argv[0]))
	{
		return JS_ThrowTypeError (ctx, "%s: first argument must be a function",
					  magic ? "setInterval" : "setTimeout");
	}

	double fDelay = 0;
	if (argc >= 2 && JS_ToFloat64 (ctx, &fDelay, argv[1]))
	{
		return JS_EXCEPTION;
	}
	if (!(fDelay >= 0))		// also catches NaN
	{
		fDelay = 0;
	}
	if (fDelay > 0x7FFFFFFF)
	{
		fDelay = 0x7FFFFFFF;
	}
	if (magic && fDelay < 1)
	{
		fDelay = 1;		// no busy intervals
	}

	TZgTimer *pTimer = new TZgTimer;
	pTimer->pApp = pApp;
	pTimer->nID = pApp->nNextTimerID++;
	pTimer->bRepeat = magic ? TRUE : FALSE;
	pTimer->Func = JS_DupValue (ctx, argv[0]);
	pTimer->pLVTimer = lv_timer_create (TimerCallback, (u32) fDelay, pTimer);
	pTimer->pNext = pApp->pTimers;
	pApp->pTimers = pTimer;

	return JS_NewUint32 (ctx, pTimer->nID);
}

static JSValue js_clear_timer (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);

	uint32_t nID;
	if (argc < 1 || JS_ToUint32 (ctx, &nID, argv[0]))
	{
		return JS_UNDEFINED;
	}

	TZgTimer *pTimer = TimerFind (pApp, nID);
	if (pTimer != 0)
	{
		TimerUnlink (pApp, pTimer);
		TimerFree (pTimer);
	}

	return JS_UNDEFINED;
}

void ZgTimersFree (TZgApp *pApp)
{
	while (pApp->pTimers != 0)
	{
		TZgTimer *pTimer = pApp->pTimers;
		pApp->pTimers = pTimer->pNext;
		TimerFree (pTimer);
	}
}

void ZgInitGlobals (JSContext *ctx)
{
	JSValue Global = JS_GetGlobalObject (ctx);

	JSValue Console = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Console, "log",   JS_NewCFunctionMagic (ctx, js_console_log, "log", 1, JS_CFUNC_generic_magic, LogNotice));
	JS_SetPropertyStr (ctx, Console, "info",  JS_NewCFunctionMagic (ctx, js_console_log, "info", 1, JS_CFUNC_generic_magic, LogNotice));
	JS_SetPropertyStr (ctx, Console, "warn",  JS_NewCFunctionMagic (ctx, js_console_log, "warn", 1, JS_CFUNC_generic_magic, LogWarning));
	JS_SetPropertyStr (ctx, Console, "error", JS_NewCFunctionMagic (ctx, js_console_log, "error", 1, JS_CFUNC_generic_magic, LogError));
	JS_SetPropertyStr (ctx, Console, "debug", JS_NewCFunctionMagic (ctx, js_console_log, "debug", 1, JS_CFUNC_generic_magic, LogDebug));
	JS_SetPropertyStr (ctx, Global, "console", Console);

	JS_SetPropertyStr (ctx, Global, "setTimeout",    JS_NewCFunctionMagic (ctx, js_set_timer, "setTimeout", 2, JS_CFUNC_generic_magic, 0));
	JS_SetPropertyStr (ctx, Global, "setInterval",   JS_NewCFunctionMagic (ctx, js_set_timer, "setInterval", 2, JS_CFUNC_generic_magic, 1));
	JS_SetPropertyStr (ctx, Global, "clearTimeout",  JS_NewCFunction (ctx, js_clear_timer, "clearTimeout", 1));
	JS_SetPropertyStr (ctx, Global, "clearInterval", JS_NewCFunction (ctx, js_clear_timer, "clearInterval", 1));

	JS_FreeValue (ctx, Global);
}

// --- zg:sys -----------------------------------------------------------------

static JSValue js_sys_uptime (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	unsigned nSec, nUsec;
	CTimer::Get ()->GetUptime (&nSec, &nUsec);

	return JS_NewFloat64 (ctx, nSec * 1000.0 + nUsec / 1000.0);	// microsecond resolution
}

static JSValue js_sys_memory (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSMemoryUsage Usage;
	JS_ComputeMemoryUsage (JS_GetRuntime (ctx), &Usage);

	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "used", JS_NewInt64 (ctx, Usage.malloc_size));
	JS_SetPropertyStr (ctx, Obj, "limit", JS_NewInt64 (ctx, Usage.malloc_limit));
	JS_SetPropertyStr (ctx, Obj, "objects", JS_NewInt64 (ctx, Usage.obj_count));

	return Obj;
}

static JSValue js_sys_exit (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CAppHost::Get ()->RequestExit ();

	return JS_UNDEFINED;
}

static JSValue js_sys_gc (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JS_RunGC (JS_GetRuntime (ctx));

	return JS_UNDEFINED;
}

static JSValue AppInfo (JSContext *ctx, const zg_app_t *pApp)
{
	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "id", JS_NewString (ctx, pApp->id));
	JS_SetPropertyStr (ctx, Obj, "name", JS_NewString (ctx, pApp->name));
	JS_SetPropertyStr (ctx, Obj, "version", JS_NewString (ctx, pApp->version));
	JS_SetPropertyStr (ctx, Obj, "description", JS_NewString (ctx, pApp->description));
	JS_SetPropertyStr (ctx, Obj, "icon", JS_NewString (ctx, pApp->icon));

	JSValue Perms = JS_NewArray (ctx);
	if (pApp->permissions & ZG_PERM_APPS)
	{
		JS_SetPropertyUint32 (ctx, Perms, 0, JS_NewString (ctx, "apps"));
	}
	JS_SetPropertyStr (ctx, Obj, "permissions", Perms);

	return Obj;
}

static int SysModuleInit (JSContext *ctx, JSModuleDef *m)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);

	JSValue Version = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Version, "zerogap", JS_NewString (ctx, ZEROGAP_VERSION));
	JS_SetPropertyStr (ctx, Version, "quickjs", JS_NewString (ctx, QJS_VERSION));
	CString LVGL;
	LVGL.Format ("%u.%u.%u", LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR, LVGL_VERSION_PATCH);
	JS_SetPropertyStr (ctx, Version, "lvgl", JS_NewString (ctx, LVGL));
	JS_SetPropertyStr (ctx, Version, "circle", JS_NewString (ctx, CIRCLE_VERSION_STRING));

	JS_SetModuleExport (ctx, m, "version", Version);
	JS_SetModuleExport (ctx, m, "app", AppInfo (ctx, pApp->pBundle));
	JS_SetModuleExport (ctx, m, "log", JS_NewCFunctionMagic (ctx, js_console_log, "log", 1, JS_CFUNC_generic_magic, LogNotice));
	JS_SetModuleExport (ctx, m, "uptime", JS_NewCFunction (ctx, js_sys_uptime, "uptime", 0));
	JS_SetModuleExport (ctx, m, "memory", JS_NewCFunction (ctx, js_sys_memory, "memory", 0));
	JS_SetModuleExport (ctx, m, "gc", JS_NewCFunction (ctx, js_sys_gc, "gc", 0));
	JS_SetModuleExport (ctx, m, "exit", JS_NewCFunction (ctx, js_sys_exit, "exit", 0));

	return 0;
}

JSModuleDef *ZgInitSysModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, SysModuleInit);
	if (m == 0)
	{
		return 0;
	}

	static const char *Exports[] = {"version", "app", "log", "uptime", "memory", "gc", "exit"};
	for (unsigned i = 0; i < sizeof Exports / sizeof Exports[0]; i++)
	{
		JS_AddModuleExport (ctx, m, Exports[i]);
	}

	return m;
}

// --- zg:apps ----------------------------------------------------------------

static JSValue js_apps_list (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValue Array = JS_NewArray (ctx);
	unsigned n = 0;
	for (unsigned i = 0; i < zg_app_count; i++)
	{
		if (!zg_apps[i].hidden)
		{
			JS_SetPropertyUint32 (ctx, Array, n++, AppInfo (ctx, &zg_apps[i]));
		}
	}

	return Array;
}

static JSValue js_apps_launch (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const char *pID = argc >= 1 ? JS_ToCString (ctx, argv[0]) : 0;
	if (pID == 0)
	{
		return JS_ThrowTypeError (ctx, "launch: app id expected");
	}

	boolean bOK = CAppHost::Get ()->RequestLaunch (pID);
	if (!bOK)
	{
		JSValue Err = JS_ThrowReferenceError (ctx, "launch: no app '%s'", pID);
		JS_FreeCString (ctx, pID);
		return Err;
	}

	JS_FreeCString (ctx, pID);

	return JS_UNDEFINED;
}

static int AppsModuleInit (JSContext *ctx, JSModuleDef *m)
{
	JS_SetModuleExport (ctx, m, "list", JS_NewCFunction (ctx, js_apps_list, "list", 0));
	JS_SetModuleExport (ctx, m, "launch", JS_NewCFunction (ctx, js_apps_launch, "launch", 1));

	return 0;
}

JSModuleDef *ZgInitAppsModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, AppsModuleInit);
	if (m == 0)
	{
		return 0;
	}

	JS_AddModuleExport (ctx, m, "list");
	JS_AddModuleExport (ctx, m, "launch");

	return m;
}
