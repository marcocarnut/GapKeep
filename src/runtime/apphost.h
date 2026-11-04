//
// apphost.h
//
// The app host runs zerogap apps: JavaScript programs built into the kernel
// image or loaded from the SD card (see appstore.h), each with its own
// QuickJS runtime, its own LVGL screen and its own keyboard focus group.
//
// Isolation: every app gets a fresh JSRuntime. When an app exits (or the
// user presses Home), its screen is deleted, its timers cancelled and its
// runtime freed, so nothing an app allocated survives it.
//
// Only one app runs at a time. The launcher is itself an app (with the
// "apps" permission); it is started at boot and whenever another app exits.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _apphost_h
#define _apphost_h

#include <circle/types.h>
#include <lvgl/lvgl.h>
#include "../kbdindev.h"
#include "bundle.h"

extern "C" {
#include <quickjs.h>
}

struct TZgTimer;
struct TZgNode;
struct TZgUIState;

// State of the running app. Reachable from any JSContext via
// JS_GetContextOpaque().
struct TZgApp
{
	const zg_app_t *pBundle;
	JSRuntime *pRuntime;
	JSContext *pContext;

	lv_obj_t *pScreen;		// root of everything the app shows
	lv_group_t *pGroup;		// focus group for the app's widgets

	TZgTimer *pTimers;		// setTimeout / setInterval
	unsigned nNextTimerID;

	TZgNode *pDeferredDelete;	// widgets to delete outside LVGL event processing

	JSValue KeyHandler;		// ui.onKey() handler or JS_UNDEFINED
	TZgUIState *pUI;		// zg:ui state, 0 until the app imports it
	struct TZgClockState *pClock;	// zg:clock alarms, 0 until the first every()

	unsigned nCallStartTicks;	// for the runaway-script watchdog
	unsigned nCallDepth;

	// Work done by the app's JavaScript: QuickJS calls the interrupt
	// handler after a fixed amount of execution (calls and loop
	// iterations), whatever the machine. Logged when the app starts and
	// stops; the simulator turns it into an estimate of Pi Zero time.
	unsigned long long nWork;

	// The reason of the last unhandled promise rejection reported: QuickJS
	// reports a failing module twice (its promise and its evaluation's),
	// with the same reason. Held, so its identity stays unique.
	JSValue LastRejection;
};

class CAppHost
{
public:
	CAppHost (CKeyboardIndev *pKeyboard);
	~CAppHost (void);

	// Starts the launcher.
	boolean Initialize (void);

	// Call from the main loop: runs pending JS jobs (promises), deferred
	// deletions and app switches.
	void Update (void);

	// --- services for the JS modules ---

	static CAppHost *Get (void);
	static TZgApp *GetApp (JSContext *pContext);

	// Requests to switch to another app (by id) or back to the launcher
	// (pID == 0). Performed in Update(), never inside a JS call.
	boolean RequestLaunch (const char *pID);
	void RequestExit (void);

	// Calls a JS function on behalf of the running app, with the watchdog
	// armed. Reports uncaught exceptions. Returns the result (to be freed by
	// the caller), or JS_EXCEPTION.
	JSValue Call (JSValueConst Func, JSValueConst This, int argc, JSValueConst *argv);

	// Reports the pending exception of pContext (log + on-screen banner).
	void ReportException (JSContext *pContext, const char *pWhere);

	CKeyboardIndev *GetKeyboard (void) const	{ return m_pKeyboard; }

	// A JS runtime with the zeroing allocator, no memory limit
	static JSRuntime *NewRuntime (void);

private:
	boolean StartApp (const zg_app_t *pApp);
	void StopApp (void);
	void RunJobs (void);

	void ShowError (const char *pTitle, const char *pText);
	void ClearError (void);
	static void ErrorBannerEvent (lv_event_t *e);

	static boolean KeyHook (const TZgKey &rKey, void *pParam);
	static void HomeHandler (void *pParam);
	static int InterruptHandler (JSRuntime *pRuntime, void *pParam);

	static JSModuleDef *ModuleLoader (JSContext *pContext, const char *pName, void *pParam);
	static char *ModuleNormalize (JSContext *pContext, const char *pBase, const char *pName, void *pParam);

private:
	CKeyboardIndev *m_pKeyboard;

	TZgApp m_App;			// the running app (pBundle == 0: none)
	lv_obj_t *m_pIdleScreen;	// shown while switching apps
	lv_obj_t *m_pErrorBanner;	// on the top layer, survives app switches

	const zg_app_t *m_pPendingLaunch;
	volatile boolean m_bHomeRequested;	// set from IRQ context
	boolean m_bInterrupted;			// the pending exception is our interrupt

	static CAppHost *s_pThis;
};

// --- shared with the JS modules (js_ui.cpp, js_sys.cpp) ---

// Creates the "zg:ui", "zg:sys", "zg:apps" and "zg:crypto" native modules.
JSModuleDef *ZgInitUIModule (JSContext *pContext, const char *pName);
JSModuleDef *ZgInitSysModule (JSContext *pContext, const char *pName);
JSModuleDef *ZgInitAppsModule (JSContext *pContext, const char *pName);
JSModuleDef *ZgInitCryptoModule (JSContext *pContext, const char *pName);
JSModuleDef *ZgInitClockModule (JSContext *pContext, const char *pName);
void ZgClockFree (TZgApp *pApp);		// js_clock.cpp: the app's alarms

// Globals: console, setTimeout, setInterval, clearTimeout, clearInterval.
void ZgInitGlobals (JSContext *pContext);

// Called by the host while tearing an app down.
void ZgUIAppStopping (TZgApp *pApp);	// before its screen is deleted
void ZgUIFree (TZgApp *pApp);		// after its screen is deleted
void ZgTimersFree (TZgApp *pApp);
void ZgUIProcessDeferred (TZgApp *pApp);

// Delivers a key to the app's ui.onKey handler. TRUE: consumed.
boolean ZgUIDispatchKey (TZgApp *pApp, const TZgKey &rKey);

// Focus callback for every focus group: shows the focus ring however focus
// moved (keyboard, mouse or code). zerogap is keyboard-first.
void ZgGroupFocusCallback (lv_group_t *pGroup);

// The UTF-8 symbol for an icon name in ui.symbols ("home", ...), or 0.
const char *ZgSymbolByName (const char *pName);

// Applies the system theme (dark, teal/amber).
void ZgUIApplyDefaultTheme (void);

#endif
