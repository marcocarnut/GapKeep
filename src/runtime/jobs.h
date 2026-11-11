//
// jobs.h
//
// Long native work for the running app, as promises: a job is done in
// slices of about SliceMs (20 ms) of native work, one slice per pass of the
// main loop, between LVGL's input handling and drawing and the app's
// JavaScript, so the screen keeps being drawn and keys keep working while a
// key is derived or a signature made. Shared by the kernel and the
// simulator (native and WebAssembly), for any module: gk:crypto's S2K and
// RSA signatures now, Argon2id or decompression later.
//
// One job runs at a time, the others wait in order (at most MaxJobs per
// app). A job ends by resolving or rejecting its promise (from the main
// loop, as gk:usb's transfers do, with the watchdog armed for the handlers
// that follow); it is dropped, its state wiped, its promise never settled,
// when the app stops (it exits, or the Windows key takes it home), and
// rejected ("interrupted") when the watchdog stops one of the app's
// scripts (something is wrong with the app). The slices themselves are
// native code, not JavaScript: the watchdog doesn't time them (each is
// short by construction).
//
// A job may report progress: onProgress(fraction), called after each slice
// that moved it on (a JavaScript call, with the watchdog).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _jobs_h
#define _jobs_h

#include "apphost.h"

struct TGkJobOps
{
	const char *pName;		// for the log: "S2K", "RSA signature"

	// Works on the job until about nDeadline (CTimer clock ticks, which
	// it may overrun by one unit of its work). TRUE: more to do.
	boolean (*Step) (void *pState, unsigned nDeadline);

	// How far it is, 0 to 1 (0 may be 0: no progress reported).
	double (*Progress) (void *pState);

	// Once Step returned FALSE: the value to resolve with, or JS_EXCEPTION
	// with an exception thrown, to reject with.
	JSValue (*Finish) (JSContext *ctx, void *pState);

	// Wipes and frees pState, and the JS values it holds (ctx may be the
	// app's last moments: no JavaScript may run).
	void (*Free) (JSContext *ctx, void *pState);
};

static const unsigned GkJobSliceMs = 20;
static const unsigned GkMaxJobs = 16;

// Queues a job and returns its promise. pState is the job's from then on
// (freed by ops->Free, also on failure). OnProgress: a function or
// undefined. JS_EXCEPTION (a RangeError) if MaxJobs are queued already.
JSValue GkJobStart (JSContext *ctx, const TGkJobOps *pOps, void *pState, JSValueConst OnProgress);

// From the app host's Update(): a slice of the first job.
void GkJobsUpdate (TGkApp *pApp);

// From StopApp(): drops every job, wiped.
void GkJobsFree (TGkApp *pApp);

// When the watchdog stopped one of the app's scripts: every job ends, its
// promise rejected with an InternalError ("interrupted").
void GkJobsCancel (TGkApp *pApp);

// The onProgress of an options argument ({ onProgress }), undefined if
// there is none. FALSE: not an object or not a function (TypeError
// thrown); *pFunc then undefined. The result is held: free it.
boolean GkJobOnProgress (JSContext *ctx, JSValueConst Options, const char *pFunction, JSValue *pFunc);

#endif
