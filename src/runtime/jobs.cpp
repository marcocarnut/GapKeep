//
// jobs.cpp
//
// Long native work as promises, in slices from the main loop. See jobs.h.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "jobs.h"
#include "../crypto/wipe.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>

static const char FromJobs[] = "jobs";

struct TGkJob
{
	const TGkJobOps *pOps;
	void *pState;
	JSValue Resolve, Reject, OnProgress;
	double fLastProgress;
	unsigned nSlices;
	unsigned nWorkTicks;		// in slices
	unsigned nLongestTicks;		// the longest slice
	unsigned nQueuedTicks;
	unsigned nSerial;		// for its abort listener
	boolean bAborting;		// aborted, cleaning up (Reason: what to reject with)
	JSValue Reason;
};

struct TGkJobsState
{
	TGkJob Queue[GkMaxJobs];	// a ring
	unsigned nFirst, nCount;
	unsigned nSerial;		// the last job's
};

static void FreeJob (JSContext *ctx, TGkJob *pJob)
{
	pJob->pOps->Free (ctx, pJob->pState);
	JS_FreeValue (ctx, pJob->Resolve);
	JS_FreeValue (ctx, pJob->Reject);
	JS_FreeValue (ctx, pJob->OnProgress);
	JS_FreeValue (ctx, pJob->Reason);
	memset (pJob, 0, sizeof *pJob);
}

static JSValue RejectJob (JSContext *ctx, int argc, JSValueConst *argv)
{
	return JS_Call (ctx, argv[0], JS_UNDEFINED, 1, &argv[1]);
}

// Rejects a promise from native code called by JavaScript (an abort
// listener, a job's start), as a promise job: after the running script,
// so that it can still add its handlers (await, .catch) without the
// rejection being reported as unhandled.
static void RejectWith (JSContext *ctx, JSValueConst Reject, JSValueConst Reason)
{
	JSValueConst Args[2] = { Reject, Reason };
	JS_EnqueueJob (ctx, RejectJob, 2, Args);
}

// The signal's reason, or an AbortError if it has none.
static JSValue AbortReason (JSContext *ctx, JSValueConst Signal)
{
	JSValue Reason = JS_GetPropertyStr (ctx, Signal, "reason");
	if (JS_IsException (Reason) || JS_IsUndefined (Reason))
	{
		JS_FreeValue (ctx, JS_IsException (Reason) ? JS_GetException (ctx) : Reason);
		Reason = JS_NewError (ctx);
		JS_SetPropertyStr (ctx, Reason, "name", JS_NewString (ctx, "AbortError"));
		JS_SetPropertyStr (ctx, Reason, "message", JS_NewString (ctx, "the operation was aborted"));
	}
	return Reason;
}

// The "abort" listener of a job's signal: data[0] is the job's serial. A
// job not found has ended already: nothing to do.
static JSValue AbortListener (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic,
			      JSValue *data)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	TGkJobsState *pJobs = pApp != 0 ? pApp->pJobs : 0;
	uint32_t nSerial;
	if (pJobs == 0 || JS_ToUint32 (ctx, &nSerial, data[0]) != 0)
	{
		return JS_UNDEFINED;
	}
	for (unsigned i = 0; i < pJobs->nCount; i++)
	{
		TGkJob *pJob = &pJobs->Queue[(pJobs->nFirst + i) % GkMaxJobs];
		if (pJob->nSerial != nSerial || pJob->bAborting)
		{
			continue;
		}
		JSValue Reason = AbortReason (ctx, this_val);
		// the running job, started: its own clean-up first, if it has one
		if (i == 0 && pJob->nSlices > 0 && pJob->pOps->Abort != 0 && pJob->pOps->Abort (pJob->pState))
		{
			pJob->bAborting = TRUE;
			pJob->Reason = Reason;
			CLogger::Get ()->Write (FromJobs, LogNotice, "%s: aborted, cleaning up", pJob->pOps->pName);
			return JS_UNDEFINED;
		}
		// off the queue (the ones behind it move up), then rejected
		TGkJob Job = *pJob;
		for (unsigned k = i; k + 1 < pJobs->nCount; k++)
		{
			pJobs->Queue[(pJobs->nFirst + k) % GkMaxJobs] = pJobs->Queue[(pJobs->nFirst + k + 1) % GkMaxJobs];
		}
		memset (&pJobs->Queue[(pJobs->nFirst + pJobs->nCount - 1) % GkMaxJobs], 0, sizeof Job);
		pJobs->nCount--;
		CLogger::Get ()->Write (FromJobs, LogNotice, "%s: aborted (%s)", Job.pOps->pName,
					Job.nSlices > 0 ? "running" : "waiting");
		RejectWith (ctx, Job.Reject, Reason);
		JS_FreeValue (ctx, Reason);
		FreeJob (ctx, &Job);
		break;
	}
	return JS_UNDEFINED;
}

JSValue GkJobStart (JSContext *ctx, const TGkJobOps *pOps, void *pState, JSValueConst OnProgress)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	if (pApp->pJobs == 0)
	{
		pApp->pJobs = new TGkJobsState;
		memset (pApp->pJobs, 0, sizeof *pApp->pJobs);
	}
	TGkJobsState *pJobs = pApp->pJobs;
	if (pJobs->nCount >= GkMaxJobs)
	{
		pOps->Free (ctx, pState);
		return JS_ThrowRangeError (ctx, "at most %u long operations (%s...) may wait at a time",
					   GkMaxJobs, pOps->pName);
	}

	JSValue Funcs[2];
	JSValue Promise = JS_NewPromiseCapability (ctx, Funcs);
	if (JS_IsException (Promise))
	{
		pOps->Free (ctx, pState);
		return Promise;
	}
	TGkJob *pJob = &pJobs->Queue[(pJobs->nFirst + pJobs->nCount) % GkMaxJobs];
	pJob->pOps = pOps;
	pJob->pState = pState;
	pJob->Resolve = Funcs[0];
	pJob->Reject = Funcs[1];
	pJob->OnProgress = JS_IsFunction (ctx, OnProgress) ? JS_DupValue (ctx, OnProgress) : JS_UNDEFINED;
	pJob->Reason = JS_UNDEFINED;
	pJob->fLastProgress = 0;
	pJob->nQueuedTicks = CTimer::Get ()->GetClockTicks ();
	pJob->nSerial = ++pJobs->nSerial;
	pJobs->nCount++;
	return Promise;
}

JSValue GkJobStart (JSContext *ctx, const TGkJobOps *pOps, void *pState, const TGkJobOptions &Options)
{
	JSValueConst Signal = Options.Signal;
	if (!JS_IsUndefined (Signal))
	{
		JSValue Aborted = JS_GetPropertyStr (ctx, Signal, "aborted");
		int nAborted = JS_IsException (Aborted) ? -1 : JS_ToBool (ctx, Aborted);
		JS_FreeValue (ctx, Aborted);
		if (nAborted < 0)
		{
			pOps->Free (ctx, pState);
			return JS_EXCEPTION;
		}
		if (nAborted)
		{
			// rejected at once, nothing queued
			pOps->Free (ctx, pState);
			JSValue Funcs[2];
			JSValue Promise = JS_NewPromiseCapability (ctx, Funcs);
			if (!JS_IsException (Promise))
			{
				JSValue Reason = AbortReason (ctx, Signal);
				RejectWith (ctx, Funcs[1], Reason);
				JS_FreeValue (ctx, Reason);
				JS_FreeValue (ctx, Funcs[0]);
				JS_FreeValue (ctx, Funcs[1]);
			}
			return Promise;
		}
	}
	JSValue Promise = GkJobStart (ctx, pOps, pState, Options.OnProgress);
	if (JS_IsException (Promise) || JS_IsUndefined (Signal))
	{
		return Promise;
	}
	// listen for "abort", the job's serial with the listener
	TGkJobsState *pJobs = CAppHost::GetApp (ctx)->pJobs;
	JSValue Serial = JS_NewUint32 (ctx, pJobs->nSerial);
	JSValue Listener = JS_NewCFunctionData (ctx, AbortListener, 1, 0, 1, &Serial);
	JSValue Add = JS_GetPropertyStr (ctx, Signal, "addEventListener");
	JSValue Args[2] = { JS_NewString (ctx, "abort"), Listener };
	JSValue Result = JS_Call (ctx, Add, Signal, 2, Args);
	if (JS_IsException (Result))
	{
		JS_FreeValue (ctx, JS_GetException (ctx));	// (checked when the options were read)
	}
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Args[0]);
	JS_FreeValue (ctx, Add);
	JS_FreeValue (ctx, Listener);
	return Promise;
}

void GkJobsUpdate (TGkApp *pApp)
{
	TGkJobsState *pJobs = pApp != 0 && pApp->pBundle != 0 ? pApp->pJobs : 0;
	if (pJobs == 0 || pJobs->nCount == 0)
	{
		return;
	}
	JSContext *ctx = pApp->pContext;
	TGkJob *pJob = &pJobs->Queue[pJobs->nFirst];
	if (pJob->pOps->Idle != 0 && pJob->pOps->Idle (pJob->pState))
	{
		return;			// waiting, nothing to do now
	}

	unsigned nStart = CTimer::Get ()->GetClockTicks ();
	boolean bMore = pJob->pOps->Step (pJob->pState, nStart + GkJobSliceMs * (CLOCKHZ / 1000));
	unsigned nTicks = CTimer::Get ()->GetClockTicks () - nStart;
	pJob->nSlices++;
	pJob->nWorkTicks += nTicks;
	if (nTicks > pJob->nLongestTicks)
	{
		pJob->nLongestTicks = nTicks;
	}
	if (nTicks > 250 * (CLOCKHZ / 1000))
	{
		// over a quarter of a second: the screen waited too long
		CLogger::Get ()->Write (FromJobs, LogWarning, "%s: a slice of %u ms (slice %u)",
					pJob->pOps->pName, nTicks / 1000, pJob->nSlices);
	}

	if (bMore)
	{
		if (!pJob->bAborting && !JS_IsUndefined (pJob->OnProgress) && pJob->pOps->Progress != 0)
		{
			double fProgress = pJob->pOps->Progress (pJob->pState);
			if (fProgress > pJob->fLastProgress)
			{
				pJob->fLastProgress = fProgress;
				JSValue Arg = JS_NewFloat64 (ctx, fProgress);
				JSValue Func = JS_DupValue (ctx, pJob->OnProgress);
				JSValue Result = CAppHost::Get ()->Call (Func, JS_UNDEFINED, 1, &Arg);
				JS_FreeValue (ctx, Result);
				JS_FreeValue (ctx, Func);
			}
		}
		return;
	}

	// done: off the queue first (the handlers may queue more)
	TGkJob Job = *pJob;
	memset (pJob, 0, sizeof *pJob);
	pJobs->nFirst = (pJobs->nFirst + 1) % GkMaxJobs;
	pJobs->nCount--;

	// the long ones: how the main loop fared (how long the screen waited)
	if (Job.nWorkTicks >= 100 * (CLOCKHZ / 1000))
	{
		CLogger::Get ()->Write (FromJobs, LogNotice, "%s: %u ms of work in %u slices (the longest %u ms), "
					"%u ms in all", Job.pOps->pName, Job.nWorkTicks / 1000, Job.nSlices,
					Job.nLongestTicks / 1000, (CTimer::Get ()->GetClockTicks () - Job.nQueuedTicks) / 1000);
	}

	JSValue Value;
	boolean bOK;
	if (Job.bAborting)
	{
		// cleaned up after an abort: rejected with the signal's reason
		Value = JS_DupValue (ctx, Job.Reason);
		bOK = FALSE;
		CLogger::Get ()->Write (FromJobs, LogNotice, "%s: aborted, cleaned up", Job.pOps->pName);
	}
	else
	{
		Value = Job.pOps->Finish (ctx, Job.pState);
		bOK = !JS_IsException (Value);
		if (!bOK)
		{
			Value = JS_GetException (ctx);
		}
	}
	JSValue Result = CAppHost::Get ()->Call (bOK ? Job.Resolve : Job.Reject, JS_UNDEFINED, 1, &Value);
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Value);
	FreeJob (ctx, &Job);
}

void GkJobsFree (TGkApp *pApp)
{
	TGkJobsState *pJobs = pApp->pJobs;
	if (pJobs == 0)
	{
		return;
	}
	if (pJobs->nCount > 0)
	{
		CLogger::Get ()->Write (FromJobs, LogNotice, "%u dropped (the app stopped)", pJobs->nCount);
	}
	while (pJobs->nCount > 0)
	{
		FreeJob (pApp->pContext, &pJobs->Queue[pJobs->nFirst]);
		pJobs->nFirst = (pJobs->nFirst + 1) % GkMaxJobs;
		pJobs->nCount--;
	}
	gk_wipe (pJobs, sizeof *pJobs);
	delete pJobs;
	pApp->pJobs = 0;
}

void GkJobsCancel (TGkApp *pApp)
{
	TGkJobsState *pJobs = pApp->pJobs;
	if (pJobs == 0 || pJobs->nCount == 0)
	{
		return;
	}
	JSContext *ctx = pApp->pContext;
	CLogger::Get ()->Write (FromJobs, LogNotice, "%u cancelled (a script was interrupted)", pJobs->nCount);
	while (pJobs->nCount > 0)
	{
		TGkJob Job = pJobs->Queue[pJobs->nFirst];
		memset (&pJobs->Queue[pJobs->nFirst], 0, sizeof Job);
		pJobs->nFirst = (pJobs->nFirst + 1) % GkMaxJobs;
		pJobs->nCount--;

		JS_ThrowInternalError (ctx, "%s: interrupted (a script ran for too long)", Job.pOps->pName);
		JSValue Value = JS_GetException (ctx);
		JSValue Result = CAppHost::Get ()->Call (Job.Reject, JS_UNDEFINED, 1, &Value);
		JS_FreeValue (ctx, Result);
		JS_FreeValue (ctx, Value);
		FreeJob (ctx, &Job);
	}
}

boolean GkJobOnProgress (JSContext *ctx, JSValueConst Options, const char *pFunction, TGkJobOptions *pOptions)
{
	pOptions->Signal = JS_UNDEFINED;
	if (!GkJobOnProgress (ctx, Options, pFunction, &pOptions->OnProgress))
	{
		return FALSE;
	}
	if (!JS_IsObject (Options))
	{
		return TRUE;
	}
	JSValue Signal = JS_GetPropertyStr (ctx, Options, "signal");
	if (JS_IsException (Signal))
	{
		GkJobOptionsFree (ctx, pOptions);
		return FALSE;
	}
	if (JS_IsUndefined (Signal) || JS_IsNull (Signal))
	{
		return TRUE;
	}
	JSValue Add = JS_IsObject (Signal) ? JS_GetPropertyStr (ctx, Signal, "addEventListener") : JS_UNDEFINED;
	boolean bOK = JS_IsFunction (ctx, Add);
	if (JS_IsException (Add))
	{
		JS_FreeValue (ctx, JS_GetException (ctx));
	}
	JS_FreeValue (ctx, Add);
	if (!bOK)
	{
		JS_FreeValue (ctx, Signal);
		GkJobOptionsFree (ctx, pOptions);
		JS_ThrowTypeError (ctx, "%s: signal must be an AbortSignal (new AbortController().signal)", pFunction);
		return FALSE;
	}
	pOptions->Signal = Signal;
	return TRUE;
}

void GkJobOptionsFree (JSContext *ctx, TGkJobOptions *pOptions)
{
	JS_FreeValue (ctx, pOptions->OnProgress);
	JS_FreeValue (ctx, pOptions->Signal);
	pOptions->OnProgress = JS_UNDEFINED;
	pOptions->Signal = JS_UNDEFINED;
}

boolean GkJobOnProgress (JSContext *ctx, JSValueConst Options, const char *pFunction, JSValue *pFunc)
{
	*pFunc = JS_UNDEFINED;
	if (JS_IsUndefined (Options) || JS_IsNull (Options))
	{
		return TRUE;
	}
	if (!JS_IsObject (Options))
	{
		JS_ThrowTypeError (ctx, "%s: options must be an object ({ onProgress, signal })", pFunction);
		return FALSE;
	}
	JSValue Func = JS_GetPropertyStr (ctx, Options, "onProgress");
	if (JS_IsException (Func))
	{
		return FALSE;
	}
	if (!JS_IsUndefined (Func) && !JS_IsFunction (ctx, Func))
	{
		JS_FreeValue (ctx, Func);
		JS_ThrowTypeError (ctx, "%s: onProgress must be a function", pFunction);
		return FALSE;
	}
	*pFunc = Func;
	return TRUE;
}
