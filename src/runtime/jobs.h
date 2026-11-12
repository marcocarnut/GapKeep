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
// A job may be cancelled with an AbortSignal ({ signal }, the web's shape;
// the globals are js_sys.cpp's): an already aborted signal rejects the
// promise at once, nothing queued; otherwise the job listens for "abort",
// and when it comes (from JavaScript, between slices) a waiting job is
// dropped, wiped, and a running one either too or, if it has an Abort op,
// given the slices it asks for to clean up (Argon2id wipes its memory),
// then dropped; its promise is rejected with the signal's reason (an Error
// named "AbortError" unless abort() was given another).
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

	// Optional: the job was aborted after it started. TRUE: it wants more
	// slices (Step until FALSE) to clean up first; FALSE (or no op): it is
	// dropped at once.
	boolean (*Abort) (void *pState);

	// Optional: TRUE while the job only waits (for a device) and has
	// nothing to do in this pass of the main loop: no slice is spent.
	boolean (*Idle) (void *pState);
};

// What a long operation's options argument gave: { onProgress, signal }
struct TGkJobOptions
{
	JSValue OnProgress;		// a function, or undefined
	JSValue Signal;			// an AbortSignal, or undefined
};

static const unsigned GkJobSliceMs = 20;
static const unsigned GkMaxJobs = 16;

// Queues a job and returns its promise. pState is the job's from then on
// (freed by ops->Free, also on failure). OnProgress: a function or
// undefined. JS_EXCEPTION (a RangeError) if MaxJobs are queued already.
JSValue GkJobStart (JSContext *ctx, const TGkJobOps *pOps, void *pState, JSValueConst OnProgress);
// The same with { onProgress, signal }: an aborted signal rejects at once.
JSValue GkJobStart (JSContext *ctx, const TGkJobOps *pOps, void *pState, const TGkJobOptions &Options);

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

// The same with the signal too ({ onProgress, signal }); free with
// GkJobOptionsFree. FALSE: a TypeError thrown, *pOptions all undefined.
boolean GkJobOnProgress (JSContext *ctx, JSValueConst Options, const char *pFunction, TGkJobOptions *pOptions);
void GkJobOptionsFree (JSContext *ctx, TGkJobOptions *pOptions);

#endif
