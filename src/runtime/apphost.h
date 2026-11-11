//
// apphost.h
//
// The app host runs GapKeep apps: JavaScript programs built into the kernel
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

struct TGkTimer;
struct TGkNode;
struct TGkUIState;

// State of the running app. Reachable from any JSContext via
// JS_GetContextOpaque().
struct TGkApp
{
	const gk_app_t *pBundle;
	JSRuntime *pRuntime;
	JSContext *pContext;

	lv_obj_t *pScreen;		// root of everything the app shows
	lv_group_t *pGroup;		// focus group for the app's widgets

	TGkTimer *pTimers;		// setTimeout / setInterval
	unsigned nNextTimerID;

	TGkNode *pDeferredDelete;	// widgets to delete outside LVGL event processing

	JSValue KeyHandler;		// ui.onKey() handler or JS_UNDEFINED
	TGkUIState *pUI;		// gk:ui state, 0 until the app imports it
	struct TGkClockState *pClock;	// gk:clock alarms, 0 until the first every()
	struct TGkI18nState *pI18n;	// its translations (i18n.h), from its start
	struct TGkUSBState *pUSB;	// gk:usb: its handlers, devices and transfers,
					// 0 until it imports it (js_usb.cpp)

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
	static TGkApp *GetApp (JSContext *pContext);

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

	// For long native work done for the running app (gk:crypto's pbkdf2):
	// whether to give up now, as QuickJS's interrupt handler would (Home,
	// or the watchdog: more than 10 s in one call). TRUE: the caller
	// throws with ThrowInterrupted() and returns.
	static boolean ShouldInterrupt (JSContext *pContext);
	static JSValue ThrowInterrupted (JSContext *pContext);

	CKeyboardIndev *GetKeyboard (void) const	{ return m_pKeyboard; }

	// A JS runtime with the zeroing allocator, no memory limit
	static JSRuntime *NewRuntime (void);

private:
	boolean StartApp (const gk_app_t *pApp);
	void StopApp (void);
	void RunJobs (void);

	void ShowError (const char *pTitle, const char *pText);
	void ClearError (void);
	static void ErrorBannerEvent (lv_event_t *e);

	static boolean KeyHook (const TGkKey &rKey, void *pParam);
	static void HomeHandler (void *pParam);
	static int InterruptHandler (JSRuntime *pRuntime, void *pParam);

	static JSModuleDef *ModuleLoader (JSContext *pContext, const char *pName, void *pParam);
	static char *ModuleNormalize (JSContext *pContext, const char *pBase, const char *pName, void *pParam);

private:
	CKeyboardIndev *m_pKeyboard;

	TGkApp m_App;			// the running app (pBundle == 0: none)
	lv_obj_t *m_pIdleScreen;	// shown while switching apps
	lv_obj_t *m_pErrorBanner;	// on the top layer, survives app switches

	const gk_app_t *m_pPendingLaunch;
	volatile boolean m_bHomeRequested;	// set from IRQ context
	boolean m_bInterrupted;			// the pending exception is our interrupt

	static CAppHost *s_pThis;
};

// --- shared with the JS modules (js_ui.cpp, js_sys.cpp) ---

// Creates the "gk:ui", "gk:sys", "gk:apps" and "gk:crypto" native modules.
JSModuleDef *GkInitUIModule (JSContext *pContext, const char *pName);
JSModuleDef *GkInitSysModule (JSContext *pContext, const char *pName);
JSModuleDef *GkInitAppsModule (JSContext *pContext, const char *pName);
JSModuleDef *GkInitCryptoModule (JSContext *pContext, const char *pName);
JSModuleDef *GkInitClockModule (JSContext *pContext, const char *pName);
void GkClockFree (TGkApp *pApp);		// js_clock.cpp: the app's alarms
JSModuleDef *GkInitSessionModule (JSContext *pContext, const char *pName);	// js_session.cpp
JSModuleDef *GkInitDataModule (JSContext *pContext, const char *pName);	// js_data.cpp
JSModuleDef *GkInitUSBModule (JSContext *pContext, const char *pName);	// js_usb.cpp
void GkUSBUpdate (TGkApp *pApp);	// js_usb.cpp: events and a transfer, from Update()
void GkUSBFree (TGkApp *pApp);		// the app's devices, handlers and transfers

// Globals: console, setTimeout, setInterval, clearTimeout, clearInterval.
void GkInitGlobals (JSContext *pContext);

// Called by the host while tearing an app down.
void GkUIAppStopping (TGkApp *pApp);	// before its screen is deleted
void GkUIFree (TGkApp *pApp);		// after its screen is deleted
void GkTimersFree (TGkApp *pApp);
void GkUIProcessDeferred (TGkApp *pApp);

// Delivers a key to the app's ui.onKey handler. TRUE: consumed.
boolean GkUIDispatchKey (TGkApp *pApp, const TGkKey &rKey);

// Focus callback for every focus group: shows the focus ring however focus
// moved (keyboard, mouse or code). GapKeep is keyboard-first.
void GkGroupFocusCallback (lv_group_t *pGroup);

// The UTF-8 symbol for an icon name in ui.symbols ("home", ...), or 0.
const char *GkSymbolByName (const char *pName);

// Applies the system theme (dark, teal/amber).
void GkUIApplyDefaultTheme (void);

#endif
