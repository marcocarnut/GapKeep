//
// apphost.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "appstore.h"
#include "i18n.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>
#include <circle/alloc.h>
#include <circle/string.h>
#include <assert.h>

static const char FromHost[] = "apphost";

// Per-app limits
static const size_t AppMemoryLimit = 96 * 1024 * 1024;	// of 512 MB total
static const size_t AppStackLimit = 512 * 1024;		// kernel stack is 1 MB
static const unsigned WatchdogSeconds = 10;		// max. time in one JS call

CAppHost *CAppHost::s_pThis = 0;

// --- JS memory allocation ---------------------------------------------------
//
// Circle's allocator cannot report block sizes, which QuickJS needs to
// enforce the memory limit. So each block carries its size in a header.
// Freed blocks are zeroed (and realloc always moves, so the old block can
// be zeroed too): whatever an app held - seed words, keys - does not linger
// in freed memory after it is released or the app exits.

static void Wipe (volatile u8 *p, size_t n)
{
	while (n--)
	{
		*p++ = 0;		// volatile: not optimized away
	}
}

static const size_t HeaderSize = 8;	// keeps 8-byte alignment

static size_t ZgUsableSize (const void *ptr)
{
	return ptr ? *(const size_t *) ((const u8 *) ptr - HeaderSize) : 0;
}

static void *ZgMalloc (JSMallocState *s, size_t size)
{
	if (s->malloc_size + size > s->malloc_limit)
	{
		return 0;
	}

	u8 *p = (u8 *) malloc (size + HeaderSize);
	if (p == 0)
	{
		return 0;
	}

	*(size_t *) p = size;
	s->malloc_count++;
	s->malloc_size += size + HeaderSize;

	return p + HeaderSize;
}

static void ZgFree (JSMallocState *s, void *ptr)
{
	if (ptr == 0)
	{
		return;
	}

	size_t size = ZgUsableSize (ptr);
	s->malloc_count--;
	s->malloc_size -= size + HeaderSize;
	Wipe ((u8 *) ptr - HeaderSize, size + HeaderSize);
	free ((u8 *) ptr - HeaderSize);
}

static void *ZgRealloc (JSMallocState *s, void *ptr, size_t size)
{
	if (ptr == 0)
	{
		return size ? ZgMalloc (s, size) : 0;
	}

	if (size == 0)
	{
		ZgFree (s, ptr);
		return 0;
	}

	size_t old = ZgUsableSize (ptr);
	if (s->malloc_size + size - old > s->malloc_limit)
	{
		return 0;
	}

	void *p = ZgMalloc (s, size);	// checks the limit with both blocks counted
	if (p == 0)
	{
		return 0;
	}

	memcpy (p, ptr, old < size ? old : size);
	ZgFree (s, ptr);

	return p;
}

static const JSMallocFunctions MallocFunctions =
{
	ZgMalloc, ZgFree, ZgRealloc, ZgUsableSize
};

// --- host -------------------------------------------------------------------

CAppHost::CAppHost (CKeyboardIndev *pKeyboard)
:	m_pKeyboard (pKeyboard),
	m_pIdleScreen (0),
	m_pErrorBanner (0),
	m_pPendingLaunch (0),
	m_bHomeRequested (FALSE),
	m_bInterrupted (FALSE)
{
	memset (&m_App, 0, sizeof m_App);

	assert (s_pThis == 0);
	s_pThis = this;
}

CAppHost::~CAppHost (void)
{
	StopApp ();
	s_pThis = 0;
}

CAppHost *CAppHost::Get (void)
{
	assert (s_pThis != 0);
	return s_pThis;
}

TZgApp *CAppHost::GetApp (JSContext *pContext)
{
	return (TZgApp *) JS_GetContextOpaque (pContext);
}

JSRuntime *CAppHost::NewRuntime (void)
{
	return JS_NewRuntime2 (&MallocFunctions, 0);
}

boolean CAppHost::Initialize (void)
{
	ZgUIApplyDefaultTheme ();

	m_pIdleScreen = lv_obj_create (0);

	m_pKeyboard->SetKeyHook (KeyHook, this);
	m_pKeyboard->SetHomeHandler (HomeHandler, this);

	const zg_app_t *pLauncher = CAppStore::Find ("launcher");
	if (pLauncher == 0)
	{
		CLogger::Get ()->Write (FromHost, LogError, "No launcher app");
		return FALSE;
	}

	return StartApp (pLauncher);
}

boolean CAppHost::RequestLaunch (const char *pID)
{
	const zg_app_t *pApp = CAppStore::Find (pID != 0 ? pID : "launcher");
	if (pApp == 0)
	{
		return FALSE;
	}
	if (!CAppStore::IsAvailable (pApp))
	{
		CLogger::Get ()->Write (FromHost, LogWarning, "%s is experimental:"
					" it needs \"experimental = yes\" in zerogap.txt", pApp->id);
		return FALSE;
	}

	m_pPendingLaunch = pApp;

	return TRUE;
}

void CAppHost::RequestExit (void)
{
	RequestLaunch (0);
}

void CAppHost::Update (void)
{
	if (m_bHomeRequested)
	{
		m_bHomeRequested = FALSE;

		if (   m_App.pBundle == 0
		    || strcmp (m_App.pBundle->id, "launcher") != 0)
		{
			CLogger::Get ()->Write (FromHost, LogNotice, "Home");
			RequestLaunch (0);
		}
	}

	if (m_pPendingLaunch != 0)
	{
		const zg_app_t *pApp = m_pPendingLaunch;
		m_pPendingLaunch = 0;

		StopApp ();
		if (!StartApp (pApp))
		{
			// the app's screen stays up with the error banner; Home returns
		}
	}

	if (m_App.pBundle != 0)
	{
		RunJobs ();
		ZgUIProcessDeferred (&m_App);
	}
}

static void PromiseRejectionTracker (JSContext *pContext, JSValueConst Promise,
				     JSValueConst Reason, JS_BOOL bHandled, void *pParam)
{
	if (bHandled)
	{
		return;
	}

	// the same reason again: already reported
	TZgApp *pApp = CAppHost::GetApp (pContext);
	if (   JS_IsObject (Reason)
	    && JS_IsObject (pApp->LastRejection)
	    && JS_VALUE_GET_PTR (Reason) == JS_VALUE_GET_PTR (pApp->LastRejection))
	{
		return;
	}
	JS_FreeValue (pContext, pApp->LastRejection);
	pApp->LastRejection = JS_DupValue (pContext, Reason);

	JS_Throw (pContext, JS_DupValue (pContext, Reason));
	((CAppHost *) pParam)->ReportException (pContext, "unhandled promise rejection");
}

// In the simulator, which runs much faster than a Pi Zero: roughly how long
// an amount of JavaScript work would take on the Zero (calibrated with
// QuickJS's test suite, tests/apps/qjstests, on the hardware). Execution
// only: compiling modules and drawing are not counted.
static CString ZeroEstimate (unsigned long long nWork)
{
	CString Text;
#ifdef ZG_SIM
	static const unsigned WorkPerSecondOnZero = ZG_ZERO_WORK_PER_SECOND;
	Text.Format (", about %u ms of JavaScript on a Pi Zero",
		     (unsigned) (nWork * 1000 / WorkPerSecondOnZero));
#else
	(void) nWork;
#endif
	return Text;
}

boolean CAppHost::StartApp (const zg_app_t *pApp)
{
	assert (pApp != 0);
	assert (m_App.pBundle == 0);

	CLogger::Get ()->Write (FromHost, LogNotice, "Starting %s %s", pApp->id, pApp->version);

	memset (&m_App, 0, sizeof m_App);
	m_App.pBundle = pApp;
	m_App.KeyHandler = JS_UNDEFINED;
	m_App.LastRejection = JS_UNDEFINED;
	m_App.nNextTimerID = 1;

	m_App.pRuntime = NewRuntime ();
	if (m_App.pRuntime == 0)
	{
		CLogger::Get ()->Write (FromHost, LogError, "Cannot create JS runtime");
		m_App.pBundle = 0;
		return FALSE;
	}

	JS_SetRuntimeInfo (m_App.pRuntime, pApp->id);
	JS_SetMemoryLimit (m_App.pRuntime, AppMemoryLimit);
	JS_SetMaxStackSize (m_App.pRuntime, AppStackLimit);
	JS_SetInterruptHandler (m_App.pRuntime, InterruptHandler, this);
	JS_SetModuleLoaderFunc (m_App.pRuntime, ModuleNormalize, ModuleLoader, this);
	JS_SetHostPromiseRejectionTracker (m_App.pRuntime, PromiseRejectionTracker, this);

	m_App.pContext = JS_NewContext (m_App.pRuntime);
	assert (m_App.pContext != 0);
	JS_SetContextOpaque (m_App.pContext, &m_App);

	ZgInitGlobals (m_App.pContext);

	// its translations (lang/<language>.json), checked
	unsigned nCatalogUs = CZgI18n::LoadCatalog (&m_App);

	m_App.pScreen = lv_obj_create (0);
	m_App.pGroup = lv_group_create ();
	lv_group_set_focus_cb (m_App.pGroup, ZgGroupFocusCallback);
	lv_group_set_default (m_App.pGroup);
	m_pKeyboard->SetGroup (m_App.pGroup);
	lv_screen_load (m_App.pScreen);

	// Run the entry module. Its evaluation returns a promise (modules may
	// use top-level await); a rejection reaches PromiseRejectionTracker.
	const zg_file_t *pEntry = 0;
	for (unsigned i = 0; i < pApp->file_count; i++)
	{
		if (strcmp (pApp->files[i].path, pApp->entry) == 0)
		{
			pEntry = &pApp->files[i];
		}
	}
	assert (pEntry != 0);		// checked by bundle_apps.py and CAppStore

	m_App.nCallDepth = 1;
	m_App.nCallStartTicks = CTimer::Get ()->GetClockTicks ();
	unsigned nStartTicks = m_App.nCallStartTicks;
	JSValue Result = JS_Eval (m_App.pContext, pEntry->data, pEntry->size, pEntry->path,
				  JS_EVAL_TYPE_MODULE);
	m_App.nCallDepth = 0;

	if (JS_IsException (Result))
	{
		ReportException (m_App.pContext, "loading");
		return FALSE;
	}
	JS_FreeValue (m_App.pContext, Result);
	unsigned nEvalTicks = CTimer::Get ()->GetClockTicks ();

	RunJobs ();

	unsigned nEndTicks = CTimer::Get ()->GetClockTicks ();
	CLogger::Get ()->Write (FromHost, LogNotice, "Started %s: modules %u ms, catalog %u.%u ms, promise jobs %u ms, work %llu%s",
				pApp->id, (nEvalTicks - nStartTicks) / 1000,
				nCatalogUs / 1000, nCatalogUs % 1000 / 100,
				(nEndTicks - nEvalTicks) / 1000, m_App.nWork,
				(const char *) ZeroEstimate (m_App.nWork));

	return TRUE;
}

void CAppHost::StopApp (void)
{
	if (m_App.pBundle == 0)
	{
		return;
	}

	CLogger::Get ()->Write (FromHost, LogNotice, "Stopping %s (work %llu%s)", m_App.pBundle->id,
				m_App.nWork, (const char *) ZeroEstimate (m_App.nWork));

	ClearError ();
	m_pKeyboard->Flush ();
	m_pKeyboard->SetGroup (0);
	lv_group_set_default (0);
	lv_screen_load (m_pIdleScreen);

	// Paint the (empty) idle screen over everything now, so nothing the app
	// showed (seed words, keys) stays in the framebuffer while the next app
	// starts.
	lv_obj_invalidate (m_pIdleScreen);
	lv_refr_now (0);

	ZgUIAppStopping (&m_App);
	ZgTimersFree (&m_App);
	ZgClockFree (&m_App);

	// Deleting the screen deletes every widget of the app; each widget
	// releases its JS event handlers as it goes.
	lv_obj_delete (m_App.pScreen);
	m_App.pScreen = 0;
	ZgUIProcessDeferred (&m_App);
	ZgUIFree (&m_App);

	lv_group_delete (m_App.pGroup);
	m_App.pGroup = 0;

	JS_FreeValue (m_App.pContext, m_App.LastRejection);
	m_App.LastRejection = JS_UNDEFINED;
	CZgI18n::FreeApp (&m_App);

	JS_FreeContext (m_App.pContext);
	JS_FreeRuntime (m_App.pRuntime);	// asserts that nothing leaked

	memset (&m_App, 0, sizeof m_App);

	ZgUIApplyDefaultTheme ();		// the app may have changed it
}

void CAppHost::RunJobs (void)
{
	m_App.nCallDepth++;
	m_App.nCallStartTicks = CTimer::Get ()->GetClockTicks ();

	JSContext *pContext;
	int nResult;
	while ((nResult = JS_ExecutePendingJob (m_App.pRuntime, &pContext)) != 0)
	{
		if (nResult < 0)
		{
			ReportException (pContext, "promise job");
		}
	}

	m_App.nCallDepth--;
}

JSValue CAppHost::Call (JSValueConst Func, JSValueConst This, int argc, JSValueConst *argv)
{
	JSContext *pContext = m_App.pContext;
	assert (pContext != 0);

	if (m_App.nCallDepth++ == 0)
	{
		m_App.nCallStartTicks = CTimer::Get ()->GetClockTicks ();
	}

	// keep the function alive even if the callback drops its last reference
	JSValue Function = JS_DupValue (pContext, Func);
	JSValue Result = JS_Call (pContext, Function, This, argc, argv);
	JS_FreeValue (pContext, Function);

	m_App.nCallDepth--;

	if (JS_IsException (Result))
	{
		ReportException (pContext, "callback");
	}

	return Result;
}

void CAppHost::ReportException (JSContext *pContext, const char *pWhere)
{
	JSValue Exception = JS_GetException (pContext);

	const char *pAppID = m_App.pBundle != 0 ? m_App.pBundle->id : "?";

	if (m_bInterrupted)
	{
		// interrupted by Home or the watchdog: already handled
		m_bInterrupted = FALSE;
		JS_FreeValue (pContext, Exception);
		return;
	}

	const char *pMessage = JS_ToCString (pContext, Exception);
	const char *pStack = 0;
	JSValue Stack = JS_UNDEFINED;
	if (JS_IsError (pContext, Exception))
	{
		Stack = JS_GetPropertyStr (pContext, Exception, "stack");
		if (JS_IsString (Stack))
		{
			pStack = JS_ToCString (pContext, Stack);
		}
	}

	CLogger::Get ()->Write (FromHost, LogError, "%s: uncaught exception (%s): %s",
				pAppID, pWhere, pMessage ? pMessage : "?");
	if (pStack != 0)
	{
		CLogger::Get ()->Write (FromHost, LogError, "%s", pStack);
	}

	CString Text;
	Text.Format ("%s\n%s", pMessage ? pMessage : "?", pStack ? pStack : "");
	CString Title;
	Title.Format (LV_SYMBOL_WARNING "  %s: error (%s)",
		      m_App.pBundle ? m_App.pBundle->name : "?", pWhere);
	ShowError (Title, Text);

	if (pStack != 0)
	{
		JS_FreeCString (pContext, pStack);
	}
	JS_FreeValue (pContext, Stack);
	if (pMessage != 0)
	{
		JS_FreeCString (pContext, pMessage);
	}
	JS_FreeValue (pContext, Exception);
}

void CAppHost::ShowError (const char *pTitle, const char *pText)
{
	ClearError ();

	lv_obj_t *pBanner = lv_obj_create (lv_layer_top ());
	lv_obj_set_size (pBanner, lv_pct (100), LV_SIZE_CONTENT);
	lv_obj_align (pBanner, LV_ALIGN_BOTTOM_MID, 0, 0);
	lv_obj_set_style_bg_color (pBanner, lv_palette_darken (LV_PALETTE_RED, 3), 0);
	lv_obj_set_style_bg_opa (pBanner, LV_OPA_90, 0);
	lv_obj_set_style_radius (pBanner, 0, 0);
	lv_obj_set_style_border_width (pBanner, 0, 0);
	lv_obj_set_style_pad_all (pBanner, 10, 0);
	lv_obj_set_flex_flow (pBanner, LV_FLEX_FLOW_COLUMN);
	lv_obj_set_style_max_height (pBanner, lv_pct (50), 0);
	lv_obj_add_event_cb (pBanner, ErrorBannerEvent, LV_EVENT_CLICKED, this);

	lv_obj_t *pLabel = lv_label_create (pBanner);
	lv_label_set_text (pLabel, pTitle);
	lv_obj_set_style_text_color (pLabel, lv_color_white (), 0);

	pLabel = lv_label_create (pBanner);
	lv_label_set_text (pLabel, pText);
	lv_label_set_long_mode (pLabel, LV_LABEL_LONG_MODE_WRAP);
	lv_obj_set_width (pLabel, lv_pct (100));
	lv_obj_set_style_text_font (pLabel, &lv_font_montserrat_12, 0);
	lv_obj_set_style_text_color (pLabel, lv_color_white (), 0);

	pLabel = lv_label_create (pBanner);
	lv_label_set_text (pLabel, "Click to dismiss. Press the Windows key to return to the launcher.");
	lv_obj_set_style_text_font (pLabel, &lv_font_montserrat_12, 0);
	lv_obj_set_style_text_color (pLabel, lv_palette_lighten (LV_PALETTE_RED, 3), 0);

	m_pErrorBanner = pBanner;
}

void CAppHost::ClearError (void)
{
	if (m_pErrorBanner != 0)
	{
		lv_obj_delete (m_pErrorBanner);
		m_pErrorBanner = 0;
	}
}

void CAppHost::ErrorBannerEvent (lv_event_t *e)
{
	CAppHost *pThis = (CAppHost *) lv_event_get_user_data (e);
	if (pThis->m_pErrorBanner != 0)
	{
		lv_obj_delete_async (pThis->m_pErrorBanner);	// we are inside its event
		pThis->m_pErrorBanner = 0;
	}
}

boolean CAppHost::KeyHook (const TZgKey &rKey, void *pParam)
{
	CAppHost *pThis = (CAppHost *) pParam;
	if (pThis->m_App.pBundle == 0)
	{
		return TRUE;		// no app: swallow
	}

	return ZgUIDispatchKey (&pThis->m_App, rKey);
}

void CAppHost::HomeHandler (void *pParam)		// IRQ context
{
	((CAppHost *) pParam)->m_bHomeRequested = TRUE;
}

int CAppHost::InterruptHandler (JSRuntime *pRuntime, void *pParam)
{
	CAppHost *pThis = (CAppHost *) pParam;
	pThis->m_App.nWork++;

	if (   pThis->m_bHomeRequested
	    && pThis->m_App.pBundle != 0
	    && strcmp (pThis->m_App.pBundle->id, "launcher") != 0)
	{
		pThis->m_bInterrupted = TRUE;
		return 1;
	}

	if (   pThis->m_App.nCallDepth > 0
	    && CTimer::Get ()->GetClockTicks () - pThis->m_App.nCallStartTicks
			> WatchdogSeconds * CLOCKHZ)
	{
		CLogger::Get ()->Write (FromHost, LogError, "%s: script ran for more than %u s, interrupted",
					pThis->m_App.pBundle->id, WatchdogSeconds);
		pThis->ShowError (LV_SYMBOL_WARNING "  Script interrupted",
				  "A script ran for too long and was stopped.");
		pThis->m_bInterrupted = TRUE;
		return 1;
	}

	return 0;
}

// --- modules ----------------------------------------------------------------
//
// "zg:..." names are system modules. Everything else must be a relative path
// ("./util.js", "../lib/x.js") resolved inside the app's own files.

char *CAppHost::ModuleNormalize (JSContext *pContext, const char *pBase, const char *pName, void *pParam)
{
	if (strncmp (pName, "zg:", 3) == 0)
	{
		// zg:i18n's own native half
		if (strcmp (pName, "zg:i18n-native") == 0 && strcmp (pBase, "zg:i18n") != 0)
		{
			JS_ThrowReferenceError (pContext, "no system module '%s'", pName);
			return 0;
		}
		return js_strdup (pContext, pName);
	}

	if (   strncmp (pName, "./", 2) != 0
	    && strncmp (pName, "../", 3) != 0)
	{
		JS_ThrowReferenceError (pContext,
			"cannot import '%s': use a relative path ('./%s') for the app's own files "
			"or 'zg:...' for system modules", pName, pName);
		return 0;
	}

	// start from the directory of the importing module
	char Path[256];
	size_t nLen = 0;
	const char *pSlash = strrchr (pBase, '/');
	if (pSlash != 0)
	{
		nLen = pSlash - pBase;
		if (nLen >= sizeof Path)
		{
			nLen = sizeof Path - 1;
		}
		memcpy (Path, pBase, nLen);
	}
	Path[nLen] = '\0';

	const char *p = pName;
	while (*p != '\0')
	{
		const char *pEnd = strchr (p, '/');
		size_t nSeg = pEnd ? (size_t) (pEnd - p) : strlen (p);

		if (nSeg == 1 && p[0] == '.')
		{
			// stay
		}
		else if (nSeg == 2 && p[0] == '.' && p[1] == '.')
		{
			if (nLen == 0)
			{
				JS_ThrowReferenceError (pContext, "cannot import '%s': outside the app", pName);
				return 0;
			}
			char *pUp = strrchr (Path, '/');
			nLen = pUp ? (size_t) (pUp - Path) : 0;
			Path[nLen] = '\0';
		}
		else if (nSeg > 0)
		{
			if (nLen + 1 + nSeg + 1 > sizeof Path)
			{
				JS_ThrowReferenceError (pContext, "module path too long");
				return 0;
			}
			if (nLen > 0)
			{
				Path[nLen++] = '/';
			}
			memcpy (Path + nLen, p, nSeg);
			nLen += nSeg;
			Path[nLen] = '\0';
		}

		p += nSeg;
		if (*p == '/')
		{
			p++;
		}
	}

	return js_strdup (pContext, Path);
}

JSModuleDef *CAppHost::ModuleLoader (JSContext *pContext, const char *pName, void *pParam)
{
	TZgApp *pApp = GetApp (pContext);
	assert (pApp != 0);

	if (strcmp (pName, "zg:ui") == 0)
	{
		return ZgInitUIModule (pContext, pName);
	}
	if (strcmp (pName, "zg:sys") == 0)
	{
		return ZgInitSysModule (pContext, pName);
	}
	if (strcmp (pName, "zg:crypto") == 0)
	{
		return ZgInitCryptoModule (pContext, pName);
	}
	if (strcmp (pName, "zg:clock") == 0)
	{
		return ZgInitClockModule (pContext, pName);
	}
	if (strcmp (pName, "zg:session") == 0)
	{
		return ZgInitSessionModule (pContext, pName);
	}
	if (strcmp (pName, "zg:i18n") == 0)
	{
		return ZgInitI18nModule (pContext, pName);
	}
	if (strcmp (pName, "zg:i18n-native") == 0)	// only for zg:i18n (ModuleNormalize)
	{
		return ZgInitI18nNativeModule (pContext, pName);
	}
	if (strcmp (pName, "zg:apps") == 0)
	{
		if (!(pApp->pBundle->permissions & ZG_PERM_APPS))
		{
			JS_ThrowReferenceError (pContext,
				"'zg:apps' requires the \"apps\" permission in manifest.json");
			return 0;
		}
		return ZgInitAppsModule (pContext, pName);
	}
	if (strncmp (pName, "zg:", 3) == 0)
	{
		JS_ThrowReferenceError (pContext, "no system module '%s'", pName);
		return 0;
	}

	const zg_app_t *pBundle = pApp->pBundle;
	for (unsigned i = 0; i < pBundle->file_count; i++)
	{
		const zg_file_t *pFile = &pBundle->files[i];
		if (strcmp (pFile->path, pName) == 0)
		{
			JSValue Func = JS_Eval (pContext, pFile->data, pFile->size, pFile->path,
						JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
			if (JS_IsException (Func))
			{
				return 0;
			}

			JSModuleDef *pModule = (JSModuleDef *) JS_VALUE_GET_PTR (Func);
			JS_FreeValue (pContext, Func);

			return pModule;
		}
	}

	JS_ThrowReferenceError (pContext, "module '%s' not found in app '%s'", pName, pBundle->id);
	return 0;
}
