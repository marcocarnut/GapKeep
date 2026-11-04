//
// js_clock.cpp
//
// The "zg:clock" module: the wall clock (clock.h). Every app may read it
// and ask to be called on its marks (every 30 s, ...); only apps with the
// "rtc" permission may set it, its trim or its UTC offset. See docs/API.md
// and docs/CLOCK.md.
//
// Alarms ("every") are kept per app and checked by one LVGL timer, against
// the wall clock rather than the uptime: they fire on the clock's marks
// (:00 and :30 for 30 s), and at once when the clock is changed, so an app
// showing the time (or a code that depends on it) is redrawn right away.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "clock.h"
#include <circle/logger.h>
#include <circle/util.h>
#include <assert.h>

// set() takes times from 2000 to 2100: anything else is a typo.
static const double MinTime = 946684800000.0;	// 2000-01-01, ms
static const double MaxTime = 4102444800000.0;	// 2100-01-01, ms
static const unsigned MaxPeriod = 86400;	// s
static const unsigned CheckMs = 50;

struct TZgAlarm
{
	TZgAlarm *pNext;
	unsigned nID;
	s64 nPeriod;			// µs
	s64 nNext;			// µs since the epoch: the next mark
	JSValue Func;
};

struct TZgClockState
{
	TZgAlarm *pAlarms;
	unsigned nNextID;
	unsigned nSerial;		// the clock's, when the marks were worked out
	lv_timer_t *pTimer;
	TZgApp *pApp;
};

static s64 NextMark (s64 nNow, s64 nPeriod)
{
	s64 n = nNow / nPeriod;
	if (nNow < 0 && n * nPeriod != nNow)
	{
		n--;
	}
	return (n + 1) * nPeriod;
}

static TZgAlarm *FindAlarm (TZgClockState *pState, unsigned nID)
{
	for (TZgAlarm *p = pState->pAlarms; p != 0; p = p->pNext)
	{
		if (p->nID == nID)
		{
			return p;
		}
	}
	return 0;
}

static void FreeAlarm (JSContext *ctx, TZgClockState *pState, TZgAlarm *pAlarm)
{
	for (TZgAlarm **pp = &pState->pAlarms; *pp != 0; pp = &(*pp)->pNext)
	{
		if (*pp == pAlarm)
		{
			*pp = pAlarm->pNext;
			break;
		}
	}
	JS_FreeValue (ctx, pAlarm->Func);
	delete pAlarm;
}

static void Fire (TZgClockState *pState, unsigned nID, s64 nNow, boolean bChanged)
{
	TZgAlarm *pAlarm = FindAlarm (pState, nID);	// a handler may have cancelled it
	if (pAlarm == 0)
	{
		return;
	}
	pAlarm->nNext = NextMark (nNow, pAlarm->nPeriod);

	JSContext *ctx = pState->pApp->pContext;
	JSValue Func = JS_DupValue (ctx, pAlarm->Func);		// it may cancel itself
	JSValue Ev = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Ev, "time", JS_NewFloat64 (ctx, (double) (nNow / 1000)));
	JS_SetPropertyStr (ctx, Ev, "changed", JS_NewBool (ctx, bChanged));
	JSValue Result = CAppHost::Get ()->Call (Func, JS_UNDEFINED, 1, &Ev);
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Ev);
	JS_FreeValue (ctx, Func);
}

static void CheckAlarms (lv_timer_t *pTimer)
{
	TZgClockState *pState = (TZgClockState *) lv_timer_get_user_data (pTimer);
	s64 nNow = CZgClock::Now ();
	boolean bChanged = CZgClock::GetSerial () != pState->nSerial;
	pState->nSerial = CZgClock::GetSerial ();

	// the due ones first: handlers may add or cancel alarms
	static const unsigned MaxDue = 32;
	unsigned Due[MaxDue], nDue = 0;
	for (TZgAlarm *p = pState->pAlarms; p != 0 && nDue < MaxDue; p = p->pNext)
	{
		if (bChanged || nNow >= p->nNext)
		{
			Due[nDue++] = p->nID;
		}
	}
	for (unsigned i = 0; i < nDue; i++)
	{
		Fire (pState, Due[i], nNow, bChanged);
	}
}

static TZgClockState *GetState (JSContext *ctx)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);
	if (pApp->pClock == 0)
	{
		TZgClockState *pState = new TZgClockState;
		pState->pAlarms = 0;
		pState->nNextID = 1;
		pState->nSerial = CZgClock::GetSerial ();
		pState->pApp = pApp;
		pState->pTimer = lv_timer_create (CheckAlarms, CheckMs, pState);
		pApp->pClock = pState;
	}
	return pApp->pClock;
}

void ZgClockFree (TZgApp *pApp)
{
	TZgClockState *pState = pApp->pClock;
	if (pState == 0)
	{
		return;
	}
	lv_timer_delete (pState->pTimer);
	while (pState->pAlarms != 0)
	{
		FreeAlarm (pApp->pContext, pState, pState->pAlarms);
	}
	delete pState;
	pApp->pClock = 0;
}

static boolean MayChange (JSContext *ctx, const char *pFunction)
{
	if (CAppHost::GetApp (ctx)->pBundle->permissions & ZG_PERM_RTC)
	{
		return TRUE;
	}
	JS_ThrowTypeError (ctx, "clock.%s needs \"permissions\": [\"rtc\"] in manifest.json", pFunction);
	return FALSE;
}

// --- functions --------------------------------------------------------------

static JSValue js_clock_now (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return JS_NewFloat64 (ctx, (double) (CZgClock::Now () / 1000));
}

static JSValue js_clock_status (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "set", JS_NewBool (ctx, CZgClock::IsSet ()));
	JS_SetPropertyStr (ctx, Obj, "time", JS_NewFloat64 (ctx, (double) (CZgClock::Now () / 1000)));
	JS_SetPropertyStr (ctx, Obj, "trimPpm", JS_NewFloat64 (ctx, CZgClock::GetTrim ()));
	JS_SetPropertyStr (ctx, Obj, "utcOffset", JS_NewInt32 (ctx, CZgClock::GetUtcOffset ()));

	const TZgDrift *pDrift = CZgClock::GetDrift ();
	JSValue Drift = JS_NULL;
	if (pDrift->bValid)
	{
		Drift = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, Drift, "correction", JS_NewFloat64 (ctx, pDrift->fCorrection));
		JS_SetPropertyStr (ctx, Drift, "over", JS_NewFloat64 (ctx, pDrift->fOver));
		JS_SetPropertyStr (ctx, Drift, "trimPpm", JS_NewFloat64 (ctx, pDrift->fTrim));
		JS_SetPropertyStr (ctx, Drift, "uncertaintyPpm", JS_NewFloat64 (ctx, pDrift->fUncertainty));
	}
	JS_SetPropertyStr (ctx, Obj, "drift", Drift);

	return Obj;
}

// set(time): ms since the epoch, or a Date
static JSValue js_clock_set (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!MayChange (ctx, "set"))
	{
		return JS_EXCEPTION;
	}

	if (argc < 1 || !(JS_IsNumber (argv[0]) || JS_IsObject (argv[0])))
	{
		return JS_ThrowTypeError (ctx, "clock.set: a time (ms since 1970) or a Date expected");
	}
	double fTime;
	if (JS_ToFloat64 (ctx, &fTime, argv[0]))	// a Date: its valueOf()
	{
		return JS_EXCEPTION;
	}
	if (!(fTime >= MinTime && fTime < MaxTime))
	{
		return JS_ThrowRangeError (ctx, "clock.set: the time must be from 2000 to 2099");
	}

	CZgClock::Set ((s64) fTime * 1000);
	return js_clock_status (ctx, this_val, 0, 0);
}

static JSValue js_clock_set_trim (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!MayChange (ctx, "setTrim"))
	{
		return JS_EXCEPTION;
	}

	double fPPM;
	if (argc < 1 || !JS_IsNumber (argv[0]) || JS_ToFloat64 (ctx, &fPPM, argv[0]))
	{
		return JS_ThrowTypeError (ctx, "clock.setTrim: a number (ppm) expected");
	}
	if (!CZgClock::SetTrim (fPPM))
	{
		return JS_ThrowRangeError (ctx, "clock.setTrim: from -%d to %d ppm",
					   CZgClock::MaxTrim, CZgClock::MaxTrim);
	}
	return JS_UNDEFINED;
}

static JSValue js_clock_set_utc_offset (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!MayChange (ctx, "setUtcOffset"))
	{
		return JS_EXCEPTION;
	}

	double fMinutes;
	if (argc < 1 || !JS_IsNumber (argv[0]) || JS_ToFloat64 (ctx, &fMinutes, argv[0])
	    || fMinutes != (double) (int) fMinutes)
	{
		return JS_ThrowTypeError (ctx, "clock.setUtcOffset: whole minutes expected");
	}
	if (!CZgClock::SetUtcOffset ((int) fMinutes))
	{
		return JS_ThrowRangeError (ctx, "clock.setUtcOffset: from -720 (UTC-12:00) to 840 (UTC+14:00)");
	}
	return JS_UNDEFINED;
}

// every(seconds, fn) -> id
static JSValue js_clock_every (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	double fSeconds;
	if (   argc < 2 || !JS_IsNumber (argv[0]) || JS_ToFloat64 (ctx, &fSeconds, argv[0])
	    || fSeconds != (double) (unsigned) fSeconds || fSeconds < 1 || fSeconds > MaxPeriod)
	{
		return JS_ThrowTypeError (ctx, "clock.every: whole seconds from 1 to %u expected", MaxPeriod);
	}
	if (!JS_IsFunction (ctx, argv[1]))
	{
		return JS_ThrowTypeError (ctx, "clock.every: a function expected");
	}

	TZgClockState *pState = GetState (ctx);
	TZgAlarm *pAlarm = new TZgAlarm;
	pAlarm->nID = pState->nNextID++;
	pAlarm->nPeriod = (s64) fSeconds * 1000000;
	pAlarm->nNext = NextMark (CZgClock::Now (), pAlarm->nPeriod);
	pAlarm->Func = JS_DupValue (ctx, argv[1]);
	pAlarm->pNext = pState->pAlarms;
	pState->pAlarms = pAlarm;

	return JS_NewUint32 (ctx, pAlarm->nID);
}

static JSValue js_clock_cancel (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);
	uint32_t nID;
	if (pApp->pClock == 0 || argc < 1 || JS_ToUint32 (ctx, &nID, argv[0]))
	{
		return JS_UNDEFINED;
	}
	TZgAlarm *pAlarm = FindAlarm (pApp->pClock, nID);
	if (pAlarm != 0)
	{
		FreeAlarm (ctx, pApp->pClock, pAlarm);
	}
	return JS_UNDEFINED;
}

// --- module -----------------------------------------------------------------

static const JSCFunctionListEntry ClockFunctions[] =
{
	JS_CFUNC_DEF ("now", 0, js_clock_now),
	JS_CFUNC_DEF ("status", 0, js_clock_status),
	JS_CFUNC_DEF ("set", 1, js_clock_set),
	JS_CFUNC_DEF ("setTrim", 1, js_clock_set_trim),
	JS_CFUNC_DEF ("setUtcOffset", 1, js_clock_set_utc_offset),
	JS_CFUNC_DEF ("every", 2, js_clock_every),
	JS_CFUNC_DEF ("cancel", 1, js_clock_cancel),
};

static int ClockModuleInit (JSContext *ctx, JSModuleDef *m)
{
	return JS_SetModuleExportList (ctx, m, ClockFunctions,
				       sizeof ClockFunctions / sizeof ClockFunctions[0]);
}

JSModuleDef *ZgInitClockModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, ClockModuleInit);
	if (m != 0)
	{
		JS_AddModuleExportList (ctx, m, ClockFunctions,
					sizeof ClockFunctions / sizeof ClockFunctions[0]);
	}
	return m;
}
