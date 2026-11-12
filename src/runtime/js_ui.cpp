//
// js_ui.cpp
//
// The "gk:ui" module: a small, generic JavaScript widget API on top of LVGL.
// See docs/API.md for the JavaScript-side documentation; keep the two in sync.
//
// Design
// ------
// Every widget is a JS object of class "Widget" whose opaque pointer is a
// TGkNode. The node links the JS object to its LVGL object:
//
//  - While the LVGL object exists, the node holds a strong reference to the
//    JS wrapper (so the same JS object is returned every time, and event
//    handlers stay alive). LVGL's DELETE event drops that reference and the
//    handlers. The wrapper's finalizer frees the node.
//  - JS never deletes LVGL objects directly: widget.delete() queues the
//    widget and the host deletes it outside LVGL event processing. That makes
//    deleting a widget from inside its own event handler safe.
//
// Properties are described by one table (Props[]), used by constructors,
// widget.set() and the per-type property accessors, so every property
// behaves the same however it is set. Unknown property names throw.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "markup.h"
#include "ttfstyles.h"
#include "scanner.h"
#include "epaper.h"
#include "jobs.h"
#include "lv_mem_limit.h"
#include "../crypto/wipe.h"
#include <lvgl/lvgl/src/themes/lv_theme_private.h>
#include <lvgl/lvgl/src/libs/qrcode/qrcodegen.h>
#include <lvgl/lvgl/src/misc/cache/instance/lv_image_cache.h>
#include <circle/logger.h>
#include <circle/util.h>
#include <circle/string.h>
#include <circle/timer.h>
#include <assert.h>

// --- types ------------------------------------------------------------------

enum TWidgetType
{
	WContainer,
	WPanel,
	WLabel,
	WButton,
	WTextArea,
	WCheckbox,
	WSwitch,
	WDropdown,
	WSlider,
	WBar,
	WTable,
	WQRCode,
	WTabView,
	WImage,
	WScanner,
	WTypeCount
};

static const char *TypeNames[WTypeCount] =
{
	"Container", "Panel", "Label", "Button", "TextArea", "Checkbox", "Switch",
	"Dropdown", "Slider", "Bar", "Table", "QRCode", "TabView", "Image", "Scanner"
};

#define T(t)		(1u << (t))
#define ALL		0xFFFFFFFFu

enum TEventSlot
{
	EvClick,
	EvChange,
	EvSubmit,
	EvFocus,
	EvBlur,
	EvLongPress,
	EvKey,
	EvPress,
	EvDrag,
	EvRelease,
	EvDetect,
	EvError,
	EvCount
};

// GapKeep's own events, fired by the widget rather than by LVGL
#define GK_EVENT	LV_EVENT_LAST

static const struct
{
	const char *pName;		// for widget.on()
	const char *pProp;		// constructor / set() property
	lv_event_code_t Code;		// GK_EVENT: not an LVGL event
	u32 nTypes;			// widgets that have it (T (...) bits, see below)
}
Events[EvCount] =
{
	{"click",     "onClick",     LV_EVENT_CLICKED, 0xFFFFFFFFu},
	{"change",    "onChange",    LV_EVENT_VALUE_CHANGED, 0xFFFFFFFFu},
	{"submit",    "onSubmit",    LV_EVENT_READY, 0xFFFFFFFFu},
	{"focus",     "onFocus",     LV_EVENT_FOCUSED, 0xFFFFFFFFu},
	{"blur",      "onBlur",      LV_EVENT_DEFOCUSED, 0xFFFFFFFFu},
	{"longpress", "onLongPress", LV_EVENT_LONG_PRESSED, 0xFFFFFFFFu},
	{"key",       "onKey",       LV_EVENT_KEY, 0xFFFFFFFFu},
	{"press",     "onPress",     LV_EVENT_PRESSED, 0xFFFFFFFFu},
	{"drag",      "onDrag",      LV_EVENT_PRESSING, 0xFFFFFFFFu},
	{"release",   "onRelease",   LV_EVENT_RELEASED, 0xFFFFFFFFu},
	{"detect",    "onDetect",    GK_EVENT, 1u << WScanner},
	{"error",     "onError",     GK_EVENT, 1u << WScanner},
};

struct TGkNode
{
	lv_obj_t *pObj;			// 0 once LVGL deleted the object
	TGkApp *pApp;
	TWidgetType Type;
	JSValue Wrapper;		// strong while pObj != 0
	JSValue Handlers[EvCount];
	u32 nRegistered;		// event slots with an LVGL callback
	boolean bDeleting;		// widget.delete() called
	JSValue DeferredRef;		// keeps the wrapper alive while queued
	TGkNode *pNextDeferred;
	char *pAccepted;		// TextArea accepted chars (LVGL keeps the pointer)
	struct TGkQR *pQR;		// QRCode settings
	lv_image_dsc_t *pImage;		// Image: the picture (pixels follow the descriptor)
	struct TGkScan *pScan;		// Scanner
	lv_point_t LastDrag;		// pointer position of the last "drag" event
	int nFontSize;			// "font", 0 if not set
	boolean bMono;			// "mono"
	boolean bMarkup;		// Label with "markup": an LVGL spangroup
	char *pMarkup;			// its text as set (the markup)
};

// the Images' pixels (Circle's heap, not LVGL's): counted with LVGL's
// memory against the app's limit (CheckUIMemory)
static size_t s_nImageBytes = 0;
static int CheckUIMemory (JSContext *ctx, size_t nMore);
static size_t TextSize (JSContext *ctx, JSValueConst v);

struct TGkQR
{
	u8 *pData;			// content (copy)
	size_t nLength;
	boolean bBinary;		// bytes (Uint8Array) rather than text
	int nECC;			// qrcodegen_Ecc
	int nMinVersion;		// the smallest version to use (1 to 40)
	int32_t nSize;			// px
	lv_color_t Dark, Light;
	int nModules;			// side length of the current symbol, 0: none
};

// Scanner: the scanner (scanner.h), polled by an LVGL timer, and its
// preview, drawn by the widget's draw callback. Freed with the LVGL object.
struct TGkScan
{
	CGkScanner *pScanner;
	boolean bDetectSet;		// "detect" given (it is required)
	lv_timer_t *pTimer;
	boolean bErrorPending;		// Start() failed: report it from the timer
	lv_image_dsc_t Preview;		// RGB565, the widget's content size
	u16 *pPixels;			// 0: no preview yet
};

struct TGkAlert;

struct TGkUIState
{
	JSValue Protos[WTypeCount];
	JSValue BaseProto;
	boolean bStopping;
	TGkAlert *pAlerts;		// open alerts, innermost first
	JSValue EPaperProto;		// ui.epaper's panels: a Container's, and more
	CGkEPaperDisplay *pEPaper;	// the open panel, or 0
	boolean bEPaperClose;		// panel.close() called: deleted in GkUIProcessDeferred
};

struct TGkAlert
{
	TGkAlert *pNext;
	TGkApp *pApp;
	lv_obj_t *pOverlay;
	lv_group_t *pGroup;
	lv_group_t *pPrevGroup;
	JSValue Resolve;
	boolean bClosing;
	int nResult;
};

static JSClassID s_WidgetClass;

static void NodeDeleteCallback (lv_event_t *e);
static void NodeEventCallback (lv_event_t *e);
static void FreeScan (TGkNode *pNode);

// --- helpers ----------------------------------------------------------------

static lv_obj_t *ButtonLabel (lv_obj_t *pButton, boolean bCreate)
{
	for (u32 i = 0; i < lv_obj_get_child_count (pButton); i++)
	{
		lv_obj_t *pChild = lv_obj_get_child (pButton, i);
		if (lv_obj_check_type (pChild, &lv_label_class))
		{
			return pChild;
		}
	}

	if (!bCreate)
	{
		return 0;
	}

	lv_obj_t *pLabel = lv_label_create (pButton);
	lv_obj_center (pLabel);

	return pLabel;
}

// Returns the JS wrapper for an LVGL object (new reference), creating the
// node on first use (e.g. for objects LVGL created internally).
static JSValue Wrap (JSContext *ctx, lv_obj_t *pObj, TWidgetType Type, JSValueConst Proto)
{
	TGkNode *pNode = (TGkNode *) lv_obj_get_user_data (pObj);
	if (pNode != 0)
	{
		return JS_DupValue (ctx, pNode->Wrapper);
	}

	TGkApp *pApp = CAppHost::GetApp (ctx);

	JSValue Obj = JS_NewObjectProtoClass (ctx,
		JS_IsUndefined (Proto) ? pApp->pUI->Protos[Type] : Proto, s_WidgetClass);
	if (JS_IsException (Obj))
	{
		return Obj;
	}

	pNode = new TGkNode;
	memset (pNode, 0, sizeof *pNode);
	pNode->pObj = pObj;
	pNode->pApp = pApp;
	pNode->Type = Type;
	pNode->Wrapper = JS_DupValue (ctx, Obj);
	pNode->DeferredRef = JS_UNDEFINED;
	for (unsigned i = 0; i < EvCount; i++)
	{
		pNode->Handlers[i] = JS_UNDEFINED;
	}

	if (Type == WQRCode)
	{
		pNode->pQR = new TGkQR;
		memset (pNode->pQR, 0, sizeof *pNode->pQR);
		pNode->pQR->nECC = qrcodegen_Ecc_MEDIUM;
		pNode->pQR->nMinVersion = qrcodegen_VERSION_MIN;
		pNode->pQR->nSize = 160;
		pNode->pQR->Dark = lv_color_black ();
		pNode->pQR->Light = lv_color_white ();
	}

	JS_SetOpaque (Obj, pNode);
	lv_obj_set_user_data (pObj, pNode);
	lv_obj_add_event_cb (pObj, NodeDeleteCallback, LV_EVENT_DELETE, pNode);

	return Obj;
}

static TWidgetType GuessType (lv_obj_t *pObj)
{
	static const struct { const lv_obj_class_t *pClass; TWidgetType Type; } Map[] =
	{
		{&lv_label_class, WLabel}, {&lv_spangroup_class, WLabel}, {&lv_button_class, WButton},
		{&lv_textarea_class, WTextArea}, {&lv_checkbox_class, WCheckbox},
		{&lv_switch_class, WSwitch}, {&lv_dropdown_class, WDropdown},
		{&lv_slider_class, WSlider}, {&lv_bar_class, WBar},
		{&lv_table_class, WTable}, {&lv_qrcode_class, WQRCode},
		{&lv_tabview_class, WTabView}, {&lv_image_class, WImage},
	};
	for (unsigned i = 0; i < sizeof Map / sizeof Map[0]; i++)
	{
		if (lv_obj_check_type (pObj, Map[i].pClass))
		{
			return Map[i].Type;
		}
	}

	return WContainer;
}

static TGkNode *GetNode (JSContext *ctx, JSValueConst Val, boolean bMustBeAlive = TRUE)
{
	TGkNode *pNode = (TGkNode *) JS_GetOpaque (Val, s_WidgetClass);
	if (pNode == 0)
	{
		JS_ThrowTypeError (ctx, "not a widget");
		return 0;
	}

	if (bMustBeAlive && (pNode->pObj == 0 || pNode->bDeleting))
	{
		JS_ThrowTypeError (ctx, "%s has been deleted", TypeNames[pNode->Type]);
		return 0;
	}

	return pNode;
}

static void WidgetFinalizer (JSRuntime *rt, JSValue Val)
{
	TGkNode *pNode = (TGkNode *) JS_GetOpaque (Val, s_WidgetClass);
	if (pNode == 0)
	{
		return;
	}

	// only reachable once the LVGL object is gone (it holds a reference)
	assert (pNode->pObj == 0);
	delete [] pNode->pAccepted;
	delete [] pNode->pMarkup;
	if (pNode->pQR != 0)
	{
		delete [] pNode->pQR->pData;
		delete pNode->pQR;
	}
	if (pNode->pImage != 0)
	{
		lv_image_cache_drop (pNode->pImage);
		s_nImageBytes -= pNode->pImage->data_size;
		delete [] (u8 *) pNode->pImage;
	}
	delete pNode;
}

static void NodeDeleteCallback (lv_event_t *e)
{
	TGkNode *pNode = (TGkNode *) lv_event_get_user_data (e);
	JSContext *ctx = pNode->pApp->pContext;

	lv_obj_set_user_data (pNode->pObj, 0);
	pNode->pObj = 0;
	FreeScan (pNode);		// gives the camera back

	for (unsigned i = 0; i < EvCount; i++)
	{
		JS_FreeValue (ctx, pNode->Handlers[i]);
		pNode->Handlers[i] = JS_UNDEFINED;
	}

	// last: this may finalize the wrapper and free the node
	JSValue Wrapper = pNode->Wrapper;
	pNode->Wrapper = JS_UNDEFINED;
	JS_FreeValue (ctx, Wrapper);
}

static const char *KeyName (u32 nKey, char *pBuf)
{
	switch (nKey)
	{
	case LV_KEY_UP:		return "ArrowUp";
	case LV_KEY_DOWN:	return "ArrowDown";
	case LV_KEY_LEFT:	return "ArrowLeft";
	case LV_KEY_RIGHT:	return "ArrowRight";
	case LV_KEY_ESC:	return "Escape";
	case LV_KEY_DEL:	return "Delete";
	case LV_KEY_BACKSPACE:	return "Backspace";
	case LV_KEY_ENTER:	return "Enter";
	case LV_KEY_NEXT:	return "Tab";
	case LV_KEY_PREV:	return "Tab";
	case LV_KEY_HOME:	return "Home";
	case LV_KEY_END:	return "End";
	default:		// a character: its UTF-8 bytes, the first lowest (kbdindev.h)
		for (unsigned i = 0; i < 4; i++)
		{
			pBuf[i] = (char) (nKey >> (8 * i));
		}
		pBuf[4] = '\0';
		return pBuf;
	}
}

static JSValue GetValueProp (JSContext *ctx, TGkNode *pNode);

static void NodeEventCallback (lv_event_t *e)
{
	TGkNode *pNode = (TGkNode *) lv_event_get_user_data (e);
	TGkApp *pApp = pNode->pApp;
	if (pApp->pUI == 0 || pApp->pUI->bStopping || pNode->pObj == 0 || pNode->bDeleting)
	{
		return;
	}

	lv_event_code_t Code = lv_event_get_code (e);

	// LVGL bubbles some events; only handle those aimed at this widget
	if (lv_event_get_target (e) != pNode->pObj)
	{
		return;
	}

	// LVGL repeats PRESSING as long as the button is held. A "drag" is a
	// press that moved: only pointer positions that changed get through.
	if (Code == LV_EVENT_PRESSED || Code == LV_EVENT_PRESSING)
	{
		lv_indev_t *pIndev = lv_indev_active ();
		boolean bPointer = pIndev != 0 && lv_indev_get_type (pIndev) == LV_INDEV_TYPE_POINTER;
		lv_point_t Point = {0, 0};
		if (bPointer)
		{
			lv_indev_get_point (pIndev, &Point);
		}
		if (Code == LV_EVENT_PRESSING)
		{
			if (   !bPointer
			    || (Point.x == pNode->LastDrag.x && Point.y == pNode->LastDrag.y))
			{
				return;
			}
		}
		pNode->LastDrag = Point;
	}

	for (unsigned i = 0; i < EvCount; i++)
	{
		if (Events[i].Code != Code || JS_IsUndefined (pNode->Handlers[i]))
		{
			continue;
		}

		JSContext *ctx = pApp->pContext;
		JSValue Wrapper = JS_DupValue (ctx, pNode->Wrapper);

		JSValue Ev = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, Ev, "type", JS_NewString (ctx, Events[i].pName));
		JS_SetPropertyStr (ctx, Ev, "target", JS_DupValue (ctx, Wrapper));
		if (Code == LV_EVENT_KEY)
		{
			char Buf[5];
			JS_SetPropertyStr (ctx, Ev, "key", JS_NewString (ctx, KeyName (lv_event_get_key (e), Buf)));
		}
		else if (   Code == LV_EVENT_PRESSED || Code == LV_EVENT_PRESSING
			 || Code == LV_EVENT_RELEASED)
		{
			// press/drag/release: from the mouse, or from Enter/Space on the
			// focused widget (no position then)
			lv_indev_t *pIndev = lv_indev_active ();
			boolean bPointer = pIndev != 0 && lv_indev_get_type (pIndev) == LV_INDEV_TYPE_POINTER;
			unsigned nSec, nUsec;
			CTimer::Get ()->GetUptime (&nSec, &nUsec);
			JS_SetPropertyStr (ctx, Ev, "pointer", JS_NewBool (ctx, bPointer));
			JS_SetPropertyStr (ctx, Ev, "time", JS_NewFloat64 (ctx, nSec * 1000.0 + nUsec / 1000.0));
			if (bPointer)
			{
				lv_point_t Point;
				lv_indev_get_point (pIndev, &Point);
				lv_area_t Coords;
				lv_obj_get_coords (pNode->pObj, &Coords);
				JS_SetPropertyStr (ctx, Ev, "x", JS_NewInt32 (ctx, Point.x - Coords.x1));
				JS_SetPropertyStr (ctx, Ev, "y", JS_NewInt32 (ctx, Point.y - Coords.y1));
			}
		}
		JSValue Value = GetValueProp (ctx, pNode);
		if (!JS_IsUndefined (Value))
		{
			JS_SetPropertyStr (ctx, Ev, "value", Value);
		}

		JSValue Result = CAppHost::Get ()->Call (pNode->Handlers[i], Wrapper, 1, &Ev);
		JS_FreeValue (ctx, Result);
		JS_FreeValue (ctx, Ev);
		JS_FreeValue (ctx, Wrapper);

		return;
	}
}

static int SetHandler (JSContext *ctx, TGkNode *pNode, unsigned nSlot, JSValueConst Func)
{
	if (!JS_IsFunction (ctx, Func) && !JS_IsNull (Func) && !JS_IsUndefined (Func))
	{
		JS_ThrowTypeError (ctx, "%s: function or null expected", Events[nSlot].pProp);
		return -1;
	}

	JS_FreeValue (ctx, pNode->Handlers[nSlot]);
	pNode->Handlers[nSlot] = JS_IsFunction (ctx, Func) ? JS_DupValue (ctx, Func) : JS_UNDEFINED;

	if (   JS_IsFunction (ctx, Func)
	    && Events[nSlot].Code != GK_EVENT
	    && !(pNode->nRegistered & (1u << nSlot)))
	{
		lv_obj_add_event_cb (pNode->pObj, NodeEventCallback, Events[nSlot].Code, pNode);
		pNode->nRegistered |= 1u << nSlot;
	}

	if (nSlot == EvDrag && JS_IsFunction (ctx, Func))
	{
		// dragging on this widget must not scroll its parents instead
		lv_obj_remove_flag (pNode->pObj, LV_OBJ_FLAG_SCROLL_CHAIN);
	}

	return 0;
}

// --- value parsing ----------------------------------------------------------

static int ToInt (JSContext *ctx, JSValueConst v, const char *pProp, int32_t *pOut)
{
	if (!JS_IsNumber (v))
	{
		JS_ThrowTypeError (ctx, "%s: number expected", pProp);
		return -1;
	}

	double d;
	JS_ToFloat64 (ctx, &d, v);
	*pOut = (int32_t) d;

	return 0;
}

static int ToBool (JSContext *ctx, JSValueConst v, const char *pProp, boolean *pOut)
{
	if (!JS_IsBool (v))
	{
		JS_ThrowTypeError (ctx, "%s: true or false expected", pProp);
		return -1;
	}

	*pOut = JS_ToBool (ctx, v) ? TRUE : FALSE;

	return 0;
}

// Returns a C string to be freed with JS_FreeCString, or 0 (exception).
static const char *ToString (JSContext *ctx, JSValueConst v, const char *pProp)
{
	if (!JS_IsString (v) && !JS_IsNumber (v))
	{
		JS_ThrowTypeError (ctx, "%s: string expected", pProp);
		return 0;
	}

	return JS_ToCString (ctx, v);
}

// number (px), "N%" or "content"
static int ToSize (JSContext *ctx, JSValueConst v, const char *pProp, int32_t *pOut)
{
	if (JS_IsNumber (v))
	{
		return ToInt (ctx, v, pProp, pOut);
	}

	const char *s = JS_IsString (v) ? JS_ToCString (ctx, v) : 0;
	if (s != 0)
	{
		int nRes = 0;
		size_t n = strlen (s);
		if (strcmp (s, "content") == 0)
		{
			*pOut = LV_SIZE_CONTENT;
		}
		else if (n >= 2 && s[n-1] == '%')
		{
			int nPct = 0;
			size_t i;
			for (i = 0; i < n-1 && s[i] >= '0' && s[i] <= '9'; i++)
			{
				nPct = nPct * 10 + (s[i] - '0');
			}
			if (i != n-1 || nPct > 1000)
			{
				nRes = -1;
			}
			*pOut = lv_pct (nPct);
		}
		else
		{
			nRes = -1;
		}
		JS_FreeCString (ctx, s);
		if (nRes == 0)
		{
			return 0;
		}
	}

	JS_ThrowTypeError (ctx, "%s: pixels (number), \"N%%\" or \"content\" expected", pProp);
	return -1;
}

// 0xRRGGBB, "#RRGGBB" or "#RGB"
static int ToColor (JSContext *ctx, JSValueConst v, const char *pProp, lv_color_t *pOut)
{
	if (JS_IsNumber (v))
	{
		uint32_t n;
		JS_ToUint32 (ctx, &n, v);
		*pOut = lv_color_hex (n & 0xFFFFFF);
		return 0;
	}

	const char *s = JS_IsString (v) ? JS_ToCString (ctx, v) : 0;
	if (s != 0)
	{
		size_t n = strlen (s);
		uint32_t nVal = 0;
		boolean bOK = s[0] == '#' && (n == 4 || n == 7);
		for (size_t i = 1; bOK && i < n; i++)
		{
			char c = s[i];
			int d = c >= '0' && c <= '9' ? c - '0'
			      : c >= 'a' && c <= 'f' ? c - 'a' + 10
			      : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
			if (d < 0)
			{
				bOK = FALSE;
			}
			nVal = nVal * 16 + d;
			if (n == 4)
			{
				nVal = nVal * 16 + d;	// #abc -> #aabbcc
			}
		}
		JS_FreeCString (ctx, s);
		if (bOK)
		{
			*pOut = lv_color_hex (nVal);
			return 0;
		}
	}

	JS_ThrowTypeError (ctx, "%s: color expected (0xRRGGBB, \"#RRGGBB\" or \"#RGB\")", pProp);
	return -1;
}

static int ToEnum (JSContext *ctx, JSValueConst v, const char *pProp,
		   const char *const *ppNames, const int *pValues, unsigned nCount, int *pOut)
{
	const char *s = JS_IsString (v) ? JS_ToCString (ctx, v) : 0;
	if (s != 0)
	{
		for (unsigned i = 0; i < nCount; i++)
		{
			if (strcmp (s, ppNames[i]) == 0)
			{
				*pOut = pValues[i];
				JS_FreeCString (ctx, s);
				return 0;
			}
		}
		JS_FreeCString (ctx, s);
	}

	CString List;
	for (unsigned i = 0; i < nCount; i++)
	{
		List.Append (i ? ", \"" : "\"");
		List.Append (ppNames[i]);
		List.Append ("\"");
	}
	JS_ThrowTypeError (ctx, "%s: one of %s expected", pProp, (const char *) List);
	return -1;
}

static const int FontSizes[] = {12, 14, 16, 18, 20, 22, 24, 28, 32, 40};
static const lv_font_t *Fonts[] =
{
	&gk_montserrat_12, &gk_montserrat_14, &gk_montserrat_16,
	&gk_montserrat_18, &gk_montserrat_20, &gk_montserrat_22,
	&gk_montserrat_24, &gk_montserrat_28, &gk_montserrat_32,
	&gk_montserrat_40
};
static const unsigned FontCount = sizeof FontSizes / sizeof FontSizes[0];

// "mono": JetBrains Mono, with Montserrat's line at the same size
// (tools/make_fonts.py), falling back to it for icons and the rest
static const int MonoSizes[] = {12, 14, 16, 18, 20, 24, 28};
static const lv_font_t *MonoFonts[] =
{
	&gk_mono_12, &gk_mono_14, &gk_mono_16, &gk_mono_18, &gk_mono_20,
	&gk_mono_24, &gk_mono_28
};
static const unsigned MonoCount = sizeof MonoSizes / sizeof MonoSizes[0];

// The monospaced font of a size, or the next smaller one there is
static const lv_font_t *MonoFont (int nSize)
{
	unsigned nChosen = 0;
	for (unsigned i = 0; i < MonoCount; i++)
	{
		if (MonoSizes[i] <= nSize)
		{
			nChosen = i;
		}
	}
	return MonoFonts[nChosen];
}

static const lv_font_t *NormalFont (int nSize)
{
	for (unsigned i = 0; i < FontCount; i++)
	{
		if (FontSizes[i] == nSize)
		{
			return Fonts[i];
		}
	}
	return Fonts[2];
}

// The size and kind of a font of ours (16, not mono, if it isn't one)
static void FontInfo (const lv_font_t *pFont, int *pSize, boolean *pMono)
{
	*pSize = 16;
	*pMono = FALSE;
	for (unsigned i = 0; i < FontCount; i++)
	{
		if (Fonts[i] == pFont)
		{
			*pSize = FontSizes[i];
		}
	}
	for (unsigned i = 0; i < MonoCount; i++)
	{
		if (MonoFonts[i] == pFont)
		{
			*pSize = MonoSizes[i];
			*pMono = TRUE;
		}
	}
}

// --- properties -------------------------------------------------------------

typedef int TSetter (JSContext *ctx, TGkNode *pNode, JSValueConst v, const char *pProp);
typedef JSValue TGetter (JSContext *ctx, TGkNode *pNode);

#define SETTER(name)	static int name (JSContext *ctx, TGkNode *pNode, JSValueConst v, const char *pProp)
#define GETTER(name)	static JSValue name (JSContext *ctx, TGkNode *pNode)
#define OBJ		(pNode->pObj)

SETTER (SetX)      { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_x (OBJ, n); return 0; }
SETTER (SetY)      { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_y (OBJ, n); return 0; }
SETTER (SetWidth)  { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_width (OBJ, n); return 0; }
SETTER (SetHeight) { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_height (OBJ, n); return 0; }
SETTER (SetMinWidth)  { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_style_min_width (OBJ, n, 0); return 0; }
SETTER (SetMaxWidth)  { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_style_max_width (OBJ, n, 0); return 0; }
SETTER (SetMinHeight) { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_style_min_height (OBJ, n, 0); return 0; }
SETTER (SetMaxHeight) { int32_t n; if (ToSize (ctx, v, pProp, &n)) return -1; lv_obj_set_style_max_height (OBJ, n, 0); return 0; }
SETTER (SetGrow)   { int32_t n; if (ToInt (ctx, v, pProp, &n)) return -1; lv_obj_set_flex_grow (OBJ, n); return 0; }

GETTER (GetWidth)  { lv_obj_update_layout (OBJ); return JS_NewInt32 (ctx, lv_obj_get_width (OBJ)); }
GETTER (GetHeight) { lv_obj_update_layout (OBJ); return JS_NewInt32 (ctx, lv_obj_get_height (OBJ)); }

SETTER (SetAlign)
{
	static const char *const Names[] = {"default", "top-left", "top-mid", "top-right", "bottom-left",
		"bottom-mid", "bottom-right", "left-mid", "right-mid", "center"};
	static const int Values[] = {LV_ALIGN_DEFAULT, LV_ALIGN_TOP_LEFT, LV_ALIGN_TOP_MID, LV_ALIGN_TOP_RIGHT,
		LV_ALIGN_BOTTOM_LEFT, LV_ALIGN_BOTTOM_MID, LV_ALIGN_BOTTOM_RIGHT, LV_ALIGN_LEFT_MID,
		LV_ALIGN_RIGHT_MID, LV_ALIGN_CENTER};
	int n;
	if (ToEnum (ctx, v, pProp, Names, Values, 10, &n)) return -1;
	lv_obj_set_align (OBJ, (lv_align_t) n);
	return 0;
}

SETTER (SetLayout)
{
	static const char *const Names[] = {"none", "row", "column", "row-wrap", "column-wrap"};
	static const int Values[] = {-1, LV_FLEX_FLOW_ROW, LV_FLEX_FLOW_COLUMN, LV_FLEX_FLOW_ROW_WRAP,
		LV_FLEX_FLOW_COLUMN_WRAP};
	int n;
	if (ToEnum (ctx, v, pProp, Names, Values, 5, &n)) return -1;
	if (n < 0)
	{
		lv_obj_set_layout (OBJ, LV_LAYOUT_NONE);
	}
	else
	{
		lv_obj_set_flex_flow (OBJ, (lv_flex_flow_t) n);
	}
	return 0;
}

static const char *const FlexNames[] = {"start", "center", "end", "space-between", "space-around", "space-evenly"};
static const int FlexValues[] = {LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END,
	LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_SPACE_AROUND, LV_FLEX_ALIGN_SPACE_EVENLY};

SETTER (SetJustify)
{
	int n;
	if (ToEnum (ctx, v, pProp, FlexNames, FlexValues, 6, &n)) return -1;
	lv_obj_set_style_flex_main_place (OBJ, (lv_flex_align_t) n, 0);
	return 0;
}

SETTER (SetAlignItems)
{
	int n;
	if (ToEnum (ctx, v, pProp, FlexNames, FlexValues, 3, &n)) return -1;
	lv_obj_set_style_flex_cross_place (OBJ, (lv_flex_align_t) n, 0);
	lv_obj_set_style_flex_track_place (OBJ, (lv_flex_align_t) n, 0);
	return 0;
}

SETTER (SetGap)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	lv_obj_set_style_pad_row (OBJ, n, 0);
	lv_obj_set_style_pad_column (OBJ, n, 0);
	return 0;
}

// number, [vertical, horizontal] or [top, right, bottom, left]
SETTER (SetPadding)
{
	int32_t p[4];
	if (JS_IsNumber (v))
	{
		if (ToInt (ctx, v, pProp, &p[0])) return -1;
		p[1] = p[2] = p[3] = p[0];
	}
	else if (JS_IsArray (ctx, v))
	{
		uint32_t nLen = 0;
		JSValue Len = JS_GetPropertyStr (ctx, v, "length");
		JS_ToUint32 (ctx, &nLen, Len);
		JS_FreeValue (ctx, Len);
		if (nLen != 2 && nLen != 4)
		{
			JS_ThrowTypeError (ctx, "%s: number, [v, h] or [top, right, bottom, left] expected", pProp);
			return -1;
		}
		for (uint32_t i = 0; i < nLen; i++)
		{
			JSValue e = JS_GetPropertyUint32 (ctx, v, i);
			int nRes = ToInt (ctx, e, pProp, &p[i]);
			JS_FreeValue (ctx, e);
			if (nRes) return -1;
		}
		if (nLen == 2)
		{
			p[2] = p[0];
			p[3] = p[1];
		}
	}
	else
	{
		JS_ThrowTypeError (ctx, "%s: number, [v, h] or [top, right, bottom, left] expected", pProp);
		return -1;
	}
	lv_obj_set_style_pad_top (OBJ, p[0], 0);
	lv_obj_set_style_pad_right (OBJ, p[1], 0);
	lv_obj_set_style_pad_bottom (OBJ, p[2], 0);
	lv_obj_set_style_pad_left (OBJ, p[3], 0);
	return 0;
}

SETTER (SetBg)
{
	lv_color_t c;
	if (ToColor (ctx, v, pProp, &c)) return -1;
	lv_obj_set_style_bg_color (OBJ, c, 0);
	lv_obj_set_style_bg_opa (OBJ, LV_OPA_COVER, 0);
	return 0;
}

SETTER (SetColor)
{
	lv_color_t c;
	if (ToColor (ctx, v, pProp, &c)) return -1;
	lv_obj_set_style_text_color (OBJ, c, 0);
	return 0;
}

SETTER (SetBorderColor)
{
	lv_color_t c;
	if (ToColor (ctx, v, pProp, &c)) return -1;
	lv_obj_set_style_border_color (OBJ, c, 0);
	return 0;
}

SETTER (SetBorderWidth) { int32_t n; if (ToInt (ctx, v, pProp, &n)) return -1; lv_obj_set_style_border_width (OBJ, n, 0); return 0; }
SETTER (SetRadius)      { int32_t n; if (ToInt (ctx, v, pProp, &n)) return -1; lv_obj_set_style_radius (OBJ, n, 0); return 0; }

SETTER (SetOpacity)
{
	double d;
	if (!JS_IsNumber (v) || JS_ToFloat64 (ctx, &d, v) || d < 0 || d > 1)
	{
		JS_ThrowTypeError (ctx, "%s: number from 0 to 1 expected", pProp);
		return -1;
	}
	lv_obj_set_style_opa (OBJ, (lv_opa_t) (d * 255 + 0.5), 0);
	return 0;
}

// --- markup (markup.h) ----------------------------------------------------------
//
// A Label with "markup" is an LVGL spangroup: one span for each run of
// text in one style. The runs are worked out again whenever the text or
// the label's font changes (<big>, <tt> are relative to it).

static int RenderMarkup (JSContext *ctx, TGkNode *pNode, const char *pSource, size_t nLength, const char *pProp)
{
	int nSize;
	boolean bMono;
	FontInfo (lv_obj_get_style_text_font (OBJ, LV_PART_MAIN), &nSize, &bMono);

	static TGkMarkup Markup;	// big for the stack (one at a time)
	char Error[200];
	if (!GkMarkupParse (pSource, nLength, FontSizes, FontCount, nSize, bMono, &Markup, Error, sizeof Error))
	{
		GkMarkupFree (&Markup);
		JS_ThrowTypeError (ctx, "%s: %s", pProp, Error);
		return -1;
	}

	while (lv_spangroup_get_span_count (OBJ) > 0)
	{
		lv_spangroup_delete_span (OBJ, lv_spangroup_get_child (OBJ, 0));
	}
	for (unsigned i = 0; i < Markup.nRuns; i++)
	{
		const TGkMarkupRun &Run = Markup.Runs[i];
		lv_span_t *pSpan = lv_spangroup_add_span (OBJ);
		char *pEnd = Markup.pText + Run.nStart + Run.nLength;
		char cSaved = *pEnd;
		*pEnd = '\0';
		lv_span_set_text (pSpan, Markup.pText + Run.nStart);
		*pEnd = cSaved;

		lv_style_t *pStyle = lv_span_get_style (pSpan);
		if (Run.Style.bBold || Run.Style.bItalic)	// never mono (markup.h)
		{
			lv_style_set_text_font (pStyle, GkStyledFont (NormalFont (Run.Style.nSize), Run.Style.nSize,
								      Run.Style.bBold, Run.Style.bItalic));
		}
		else if (Run.Style.nSize != nSize || Run.Style.bMono != bMono)
		{
			lv_style_set_text_font (pStyle, Run.Style.bMono ? MonoFont (Run.Style.nSize)
									: NormalFont (Run.Style.nSize));
		}
		if (Run.Style.bColor)
		{
			lv_style_set_text_color (pStyle, lv_color_hex (Run.Style.nColor));
		}
		if (Run.Style.nDecor != 0)
		{
			lv_style_set_text_decor (pStyle, (lv_text_decor_t)
				(  (Run.Style.nDecor & GK_MARKUP_UNDERLINE ? LV_TEXT_DECOR_UNDERLINE : 0)
				 | (Run.Style.nDecor & GK_MARKUP_STRIKE ? LV_TEXT_DECOR_STRIKETHROUGH : 0)));
		}
	}
	GkMarkupFree (&Markup);
	lv_spangroup_refresh (OBJ);

	if (pSource != pNode->pMarkup)
	{
		char *pCopy = new char[nLength + 1];
		memcpy (pCopy, pSource, nLength);
		pCopy[nLength] = '\0';
		delete [] pNode->pMarkup;
		pNode->pMarkup = pCopy;
	}
	return 0;
}

// The font from "font" and "mono", whichever came first: the size is
// "font", else the one the widget has (inherited); mono takes the mono
// font of that size, or, for an inherited size it lacks, the next smaller.
static int ApplyFontOnly (JSContext *ctx, TGkNode *pNode, const char *pProp)
{
	if (!pNode->bMono)
	{
		for (unsigned i = 0; i < FontCount; i++)
		{
			if (FontSizes[i] == pNode->nFontSize)
			{
				lv_obj_set_style_text_font (OBJ, Fonts[i], 0);
				return 0;
			}
		}
		// mono: false: the inherited font, or the normal one of its size if
		// that is mono (inside a mono container)
		lv_obj_remove_local_style_prop (OBJ, LV_STYLE_TEXT_FONT, LV_PART_MAIN);
		const lv_font_t *pFont = lv_obj_get_style_text_font (OBJ, LV_PART_MAIN);
		for (unsigned i = 0; i < MonoCount; i++)
		{
			if (MonoFonts[i] == pFont)
			{
				lv_obj_set_style_text_font (OBJ, pFont->fallback, 0);
			}
		}
		return 0;
	}

	int nSize = pNode->nFontSize;
	if (nSize == 0)
	{
		lv_obj_remove_local_style_prop (OBJ, LV_STYLE_TEXT_FONT, LV_PART_MAIN);
		const lv_font_t *pFont = lv_obj_get_style_text_font (OBJ, LV_PART_MAIN);
		nSize = 16;			// the theme's
		for (unsigned i = 0; i < FontCount; i++)
		{
			if (Fonts[i] == pFont)
			{
				nSize = FontSizes[i];
			}
		}
		for (unsigned i = 0; i < MonoCount; i++)	// inside a mono container
		{
			if (MonoFonts[i] == pFont)
			{
				nSize = MonoSizes[i];
			}
		}
	}
	int nChosen = -1;
	for (unsigned i = 0; i < MonoCount; i++)
	{
		if (   MonoSizes[i] == nSize
		    || (pNode->nFontSize == 0 && MonoSizes[i] < nSize))
		{
			nChosen = (int) i;
		}
	}
	if (nChosen < 0 && pNode->nFontSize == 0)
	{
		nChosen = 0;
	}
	if (nChosen < 0)
	{
		JS_ThrowRangeError (ctx, "%s: no monospaced font of size %d: one of ui.monoFonts (12 14 16 18 20 24 28)",
				    pProp, nSize);
		return -1;
	}
	lv_obj_set_style_text_font (OBJ, MonoFonts[nChosen], 0);
	return 0;
}

static int ApplyFont (JSContext *ctx, TGkNode *pNode, const char *pProp)
{
	if (ApplyFontOnly (ctx, pNode, pProp))
	{
		return -1;
	}
	return pNode->bMarkup && pNode->pMarkup != 0
		? RenderMarkup (ctx, pNode, pNode->pMarkup, strlen (pNode->pMarkup), pProp) : 0;
}

SETTER (SetFont)
{
	int32_t n;
	if (JS_IsNumber (v) && ToInt (ctx, v, pProp, &n) == 0)
	{
		for (unsigned i = 0; i < FontCount; i++)
		{
			if (FontSizes[i] == n)
			{
				pNode->nFontSize = n;
				return ApplyFont (ctx, pNode, pProp);
			}
		}
	}
	JS_ThrowTypeError (ctx, "%s: one of the sizes in ui.fonts expected (12 14 16 18 20 22 24 28 32 40)", pProp);
	return -1;
}

SETTER (SetMono)
{
	if (!JS_IsBool (v))
	{
		JS_ThrowTypeError (ctx, "%s: boolean expected", pProp);
		return -1;
	}
	pNode->bMono = JS_ToBool (ctx, v);
	return ApplyFont (ctx, pNode, pProp);
}
GETTER (GetMono)	{ return JS_NewBool (ctx, pNode->bMono); }

SETTER (SetTextAlign)
{
	static const char *const Names[] = {"left", "center", "right"};
	static const int Values[] = {LV_TEXT_ALIGN_LEFT, LV_TEXT_ALIGN_CENTER, LV_TEXT_ALIGN_RIGHT};
	int n;
	if (ToEnum (ctx, v, pProp, Names, Values, 3, &n)) return -1;
	lv_obj_set_style_text_align (OBJ, (lv_text_align_t) n, 0);
	return 0;
}

static int SetFlag (JSContext *ctx, TGkNode *pNode, JSValueConst v, const char *pProp, lv_obj_flag_t Flag, boolean bInvert)
{
	boolean b;
	if (ToBool (ctx, v, pProp, &b)) return -1;
	if (b != bInvert)
	{
		lv_obj_add_flag (OBJ, Flag);
	}
	else
	{
		lv_obj_remove_flag (OBJ, Flag);
	}
	return 0;
}

SETTER (SetHidden)     { return SetFlag (ctx, pNode, v, pProp, LV_OBJ_FLAG_HIDDEN, FALSE); }
SETTER (SetClickable)  { return SetFlag (ctx, pNode, v, pProp, LV_OBJ_FLAG_CLICKABLE, FALSE); }
GETTER (GetHidden)     { return JS_NewBool (ctx, lv_obj_has_flag (OBJ, LV_OBJ_FLAG_HIDDEN)); }

// Scanner "detect": a list of detector names (scanner.h), e.g. ["qr"]
SETTER (SetDetect)
{
	CString Known;
	for (unsigned i = 0; CGkScanner::GetDetectorName (i) != 0; i++)
	{
		Known.Append (i ? ", \"" : "\"");
		Known.Append (CGkScanner::GetDetectorName (i));
		Known.Append ("\"");
	}

	uint32_t nLength = 0;
	if (JS_IsArray (ctx, v))
	{
		JSValue Length = JS_GetPropertyStr (ctx, v, "length");
		JS_ToUint32 (ctx, &nLength, Length);
		JS_FreeValue (ctx, Length);
	}
	if (!JS_IsArray (ctx, v) || nLength > 16)
	{
		JS_ThrowTypeError (ctx, "%s: a list of detectors expected, from %s", pProp, (const char *) Known);
		return -1;
	}

	unsigned nDetectors = 0;
	for (uint32_t i = 0; i < nLength; i++)
	{
		JSValue Item = JS_GetPropertyUint32 (ctx, v, i);
		const char *pName = JS_IsString (Item) ? JS_ToCString (ctx, Item) : 0;
		unsigned nBit = pName != 0 ? CGkScanner::GetDetector (pName) : 0;
		if (nBit == 0)
		{
			JS_ThrowTypeError (ctx, "%s: unknown detector \"%s\" (this system has %s)",
					   pProp, pName ? pName : "?", (const char *) Known);
		}
		JS_FreeCString (ctx, pName);
		JS_FreeValue (ctx, Item);
		if (nBit == 0)
		{
			return -1;
		}
		nDetectors |= nBit;
	}

	pNode->pScan->pScanner->SetDetectors (nDetectors);
	pNode->pScan->bDetectSet = TRUE;
	return 0;
}

static void StartScan (TGkNode *pNode);

// Scanner "field": "center" (the middle of the camera's view, at full
// detail) or "full" (all of it, less detailed). A running scanner restarts
// with the new field.
SETTER (SetField)
{
	const char *p = JS_IsString (v) ? JS_ToCString (ctx, v) : 0;
	TGkCameraField Field = GkFieldCenter;
	boolean bOK = p != 0 && (strcmp (p, "center") == 0 || strcmp (p, "full") == 0);
	if (bOK && strcmp (p, "full") == 0)
	{
		Field = GkFieldFull;
	}
	JS_FreeCString (ctx, p);
	if (!bOK)
	{
		JS_ThrowTypeError (ctx, "%s: \"center\" or \"full\" expected", pProp);
		return -1;
	}

	CGkScanner *pScanner = pNode->pScan->pScanner;
	if (Field != pScanner->GetField ())
	{
		pScanner->SetField (Field);
		if (pScanner->IsScanning ())
		{
			pScanner->Stop ();
			StartScan (pNode);
		}
	}
	return 0;
}

GETTER (GetField)
{
	return JS_NewString (ctx, pNode->pScan->pScanner->GetField () == GkFieldFull ? "full" : "center");
}

GETTER (GetDetect)
{
	unsigned nDetectors = pNode->pScan->pScanner->GetDetectors ();
	JSValue List = JS_NewArray (ctx);
	unsigned nBit, n = 0;
	for (unsigned i = 0; CGkScanner::GetDetectorName (i, &nBit) != 0; i++)
	{
		if (nDetectors & nBit)
		{
			JS_SetPropertyUint32 (ctx, List, n++, JS_NewString (ctx, CGkScanner::GetDetectorName (i)));
		}
	}
	return List;
}

static lv_style_t s_FocusStyle;		// the focus ring (see ApplyTheme)

// The focus ring is drawn outside the widget: RingWidth px wide, RingGap px
// away from it. Layouts must leave RingReach px around anything focusable.
static const int32_t RingWidth = 3;
static const int32_t RingGap = 2;
static const int32_t RingReach = RingWidth + RingGap;

static void RingRoomCallback (lv_event_t *e)
{
	lv_event_set_ext_draw_size (e, RingReach);
}

// For boxes that let their children draw outside them (plain Containers).
// LVGL repaints a child only within its parents' area plus each parent's
// "extra draw size", which is 0 for a box without styles: the part of a
// child's focus ring outside a tight box would never be repainted (rings
// that look like brackets). Reserve the ring's reach as extra draw size.
static void AllowRingOverflow (lv_obj_t *pObj)
{
	lv_obj_add_flag (pObj, LV_OBJ_FLAG_OVERFLOW_VISIBLE);
	lv_obj_add_event_cb (pObj, RingRoomCallback, LV_EVENT_REFR_EXT_DRAW_SIZE, 0);
	lv_obj_refresh_ext_draw_size (pObj);
}

// A Container draws its children's focus rings outside its box, which is
// fine while it holds still. One that scrolls must clip its content (or
// rows scrolled out of view would draw over the rest of the screen), so it
// keeps room for the rings inside: RingReach of padding unless the app set
// its own.
SETTER (SetScrollable)
{
	if (SetFlag (ctx, pNode, v, pProp, LV_OBJ_FLAG_SCROLLABLE, FALSE))
	{
		return -1;
	}
	if (pNode->Type != WContainer || lv_obj_get_parent (OBJ) == 0)	// not the screen
	{
		return 0;
	}

	if (lv_obj_has_flag (OBJ, LV_OBJ_FLAG_SCROLLABLE))
	{
		lv_obj_remove_flag (OBJ, LV_OBJ_FLAG_OVERFLOW_VISIBLE);
		lv_style_value_t Value;
		if (lv_obj_get_local_style_prop (OBJ, LV_STYLE_PAD_TOP, &Value, 0) != LV_STYLE_RES_FOUND)
		{
			lv_obj_set_style_pad_all (OBJ, RingReach, 0);
		}
	}
	else
	{
		lv_obj_add_flag (OBJ, LV_OBJ_FLAG_OVERFLOW_VISIBLE);
	}
	return 0;
}

// Buttons, text areas and the like are focusable from birth; this makes any
// widget a stop in the Tab order (or takes one out of it).
SETTER (SetFocusable)
{
	boolean b;
	if (ToBool (ctx, v, pProp, &b)) return -1;
	lv_group_t *pGroup = (lv_group_t *) lv_obj_get_group (OBJ);
	if (b && pGroup == 0)
	{
		lv_group_add_obj (pNode->pApp->pGroup, OBJ);
		lv_obj_add_flag (OBJ, LV_OBJ_FLAG_SCROLL_ON_FOCUS);	// as buttons do
		// plain Containers have no theme styles, so no focus ring either
		lv_obj_add_style (OBJ, &s_FocusStyle, LV_STATE_FOCUS_KEY);
	}
	else if (!b && pGroup != 0)
	{
		lv_group_remove_obj (OBJ);
	}
	return 0;
}
GETTER (GetFocusable) { return JS_NewBool (ctx, lv_obj_get_group (OBJ) != 0); }

SETTER (SetDisabled)
{
	boolean b;
	if (ToBool (ctx, v, pProp, &b)) return -1;
	lv_obj_set_state (OBJ, LV_STATE_DISABLED, b);
	return 0;
}
GETTER (GetDisabled) { return JS_NewBool (ctx, lv_obj_has_state (OBJ, LV_STATE_DISABLED)); }

// text: Label, Button, TextArea, Checkbox
SETTER (SetText)
{
	if (pNode->bMarkup)
	{
		size_t n;
		const char *s = JS_IsString (v) ? JS_ToCStringLen (ctx, &n, v) : 0;
		if (s == 0)
		{
			JS_ThrowTypeError (ctx, "%s: string expected", pProp);
			return -1;
		}
		int nResult = RenderMarkup (ctx, pNode, s, n, pProp);
		JS_FreeCString (ctx, s);
		return nResult;
	}
	const char *s = ToString (ctx, v, pProp);
	if (s == 0) return -1;
	switch (pNode->Type)
	{
	case WLabel:	lv_label_set_text (OBJ, s);			break;
	case WButton:	lv_label_set_text (ButtonLabel (OBJ, TRUE), s);	break;
	case WTextArea:	lv_textarea_set_text (OBJ, s);			break;
	case WCheckbox:	lv_checkbox_set_text (OBJ, s);			break;
	default:	break;
	}
	JS_FreeCString (ctx, s);
	return 0;
}

GETTER (GetText)
{
	const char *s = "";
	switch (pNode->Type)
	{
	case WLabel:	s = pNode->bMarkup ? pNode->pMarkup : lv_label_get_text (OBJ);	break;
	case WButton:	{ lv_obj_t *l = ButtonLabel (OBJ, FALSE); s = l ? lv_label_get_text (l) : ""; } break;
	case WTextArea:	s = lv_textarea_get_text (OBJ);		break;
	case WCheckbox:	s = lv_checkbox_get_text (OBJ);		break;
	default:	break;
	}
	return JS_NewString (ctx, s ? s : "");
}

SETTER (SetOverflow)
{
	static const char *const Names[] = {"wrap", "clip", "dots", "scroll", "scroll-circular"};
	static const int Values[] = {LV_LABEL_LONG_MODE_WRAP, LV_LABEL_LONG_MODE_CLIP, LV_LABEL_LONG_MODE_DOTS,
		LV_LABEL_LONG_MODE_SCROLL, LV_LABEL_LONG_MODE_SCROLL_CIRCULAR};
	int n;
	if (ToEnum (ctx, v, pProp, Names, Values, 5, &n)) return -1;
	if (pNode->bMarkup)
	{
		// a spangroup wraps at its width; "clip" keeps the first line
		if (n == LV_LABEL_LONG_MODE_SCROLL || n == LV_LABEL_LONG_MODE_SCROLL_CIRCULAR)
		{
			JS_ThrowTypeError (ctx, "%s: \"wrap\", \"clip\" or \"dots\" with markup", pProp);
			return -1;
		}
		lv_spangroup_set_overflow (OBJ, n == LV_LABEL_LONG_MODE_DOTS ? LV_SPAN_OVERFLOW_ELLIPSIS
									      : LV_SPAN_OVERFLOW_CLIP);
		lv_spangroup_set_max_lines (OBJ, n == LV_LABEL_LONG_MODE_CLIP ? 1 : -1);
		return 0;
	}
	lv_label_set_long_mode (OBJ, (lv_label_long_mode_t) n);
	return 0;
}

// fixed when the Label is created (it is another kind of LVGL object)
SETTER (SetMarkup)
{
	boolean b;
	if (ToBool (ctx, v, pProp, &b)) return -1;
	if (b != pNode->bMarkup)
	{
		JS_ThrowTypeError (ctx, "%s: set it when the Label is created: new ui.Label({ markup: true, ... })", pProp);
		return -1;
	}
	return 0;
}
GETTER (GetMarkup) { return JS_NewBool (ctx, pNode->bMarkup); }

SETTER (SetPlaceholder)
{
	const char *s = ToString (ctx, v, pProp);
	if (s == 0) return -1;
	lv_textarea_set_placeholder_text (OBJ, s);
	JS_FreeCString (ctx, s);
	return 0;
}

SETTER (SetOneLine)  { boolean b; if (ToBool (ctx, v, pProp, &b)) return -1; lv_textarea_set_one_line (OBJ, b); return 0; }
SETTER (SetPassword) { boolean b; if (ToBool (ctx, v, pProp, &b)) return -1; lv_textarea_set_password_mode (OBJ, b); return 0; }
SETTER (SetMaxLength)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	lv_textarea_set_max_length (OBJ, n > 0 ? n : 0);
	return 0;
}

SETTER (SetAccept)
{
	if (JS_IsNull (v) || JS_IsUndefined (v))
	{
		lv_textarea_set_accepted_chars (OBJ, 0);
		delete [] pNode->pAccepted;
		pNode->pAccepted = 0;
		return 0;
	}
	const char *s = ToString (ctx, v, pProp);
	if (s == 0) return -1;
	char *pCopy = new char[strlen (s) + 1];		// LVGL keeps the pointer
	strcpy (pCopy, s);
	JS_FreeCString (ctx, s);
	lv_textarea_set_accepted_chars (OBJ, pCopy);
	delete [] pNode->pAccepted;
	pNode->pAccepted = pCopy;
	return 0;
}

// checked: Checkbox, Switch
SETTER (SetChecked)
{
	boolean b;
	if (ToBool (ctx, v, pProp, &b)) return -1;
	lv_obj_set_state (OBJ, LV_STATE_CHECKED, b);
	return 0;
}
GETTER (GetChecked) { return JS_NewBool (ctx, lv_obj_has_state (OBJ, LV_STATE_CHECKED)); }

// Dropdown
SETTER (SetOptions)
{
	if (!JS_IsArray (ctx, v))
	{
		JS_ThrowTypeError (ctx, "%s: array of strings expected", pProp);
		return -1;
	}
	uint32_t nLen = 0;
	JSValue Len = JS_GetPropertyStr (ctx, v, "length");
	JS_ToUint32 (ctx, &nLen, Len);
	JS_FreeValue (ctx, Len);

	CString Options;
	for (uint32_t i = 0; i < nLen; i++)
	{
		JSValue e = JS_GetPropertyUint32 (ctx, v, i);
		const char *s = ToString (ctx, e, pProp);
		JS_FreeValue (ctx, e);
		if (s == 0) return -1;
		if (i > 0)
		{
			Options.Append ("\n");
		}
		Options.Append (s);
		JS_FreeCString (ctx, s);
	}
	lv_dropdown_set_options (OBJ, Options);
	return 0;
}

// selected: Dropdown; active: TabView
SETTER (SetSelected)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (n < 0) n = 0;
	if (pNode->Type == WTabView)
	{
		if ((uint32_t) n < lv_tabview_get_tab_count (OBJ))
		{
			lv_tabview_set_active (OBJ, n, LV_ANIM_OFF);
		}
	}
	else
	{
		lv_dropdown_set_selected (OBJ, n);
	}
	return 0;
}
GETTER (GetSelected)
{
	return JS_NewUint32 (ctx, pNode->Type == WTabView ? lv_tabview_get_tab_active (OBJ)
							  : lv_dropdown_get_selected (OBJ));
}

// Slider, Bar
SETTER (SetMin)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (pNode->Type == WSlider) lv_slider_set_range (OBJ, n, lv_slider_get_max_value (OBJ));
	else lv_bar_set_range (OBJ, n, lv_bar_get_max_value (OBJ));
	return 0;
}
SETTER (SetMax)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (pNode->Type == WSlider) lv_slider_set_range (OBJ, lv_slider_get_min_value (OBJ), n);
	else lv_bar_set_range (OBJ, lv_bar_get_min_value (OBJ), n);
	return 0;
}
SETTER (SetValue)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (pNode->Type == WSlider) lv_slider_set_value (OBJ, n, LV_ANIM_OFF);
	else lv_bar_set_value (OBJ, n, LV_ANIM_OFF);
	return 0;
}
GETTER (GetMin)   { return JS_NewInt32 (ctx, pNode->Type == WSlider ? lv_slider_get_min_value (OBJ) : lv_bar_get_min_value (OBJ)); }
GETTER (GetMax)   { return JS_NewInt32 (ctx, pNode->Type == WSlider ? lv_slider_get_max_value (OBJ) : lv_bar_get_max_value (OBJ)); }
GETTER (GetValue) { return JS_NewInt32 (ctx, pNode->Type == WSlider ? lv_slider_get_value (OBJ) : lv_bar_get_value (OBJ)); }

// Table
//
// Its size is capped: LVGL keeps a pointer for every cell (rows x columns,
// in 32 bits), and grows the table to reach any cell set.
static const uint32_t MaxTableRows = 10000;
static const uint32_t MaxTableCols = 100;
static const uint32_t MaxTableCells = 100000;

static int CheckTableSize (JSContext *ctx, uint32_t nRows, uint32_t nCols, const char *pWhat)
{
	if (nRows > MaxTableRows || nCols > MaxTableCols || nRows * nCols > MaxTableCells)
	{
		JS_ThrowRangeError (ctx, "%s: a Table has at most %u rows, %u columns and %u cells",
				    pWhat, (unsigned) MaxTableRows, (unsigned) MaxTableCols,
				    (unsigned) MaxTableCells);
		return -1;
	}
	return 0;
}

SETTER (SetRows)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (n < 0) n = 0;
	if (CheckTableSize (ctx, n, lv_table_get_column_count (OBJ), pProp)) return -1;
	lv_table_set_row_count (OBJ, n);
	return 0;
}
SETTER (SetCols)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (n < 0) n = 0;
	if (CheckTableSize (ctx, lv_table_get_row_count (OBJ), n, pProp)) return -1;
	lv_table_set_column_count (OBJ, n);
	return 0;
}
GETTER (GetRows) { return JS_NewUint32 (ctx, lv_table_get_row_count (OBJ)); }
GETTER (GetCols) { return JS_NewUint32 (ctx, lv_table_get_column_count (OBJ)); }

// array of rows, each an array of cell strings
SETTER (SetData)
{
	if (!JS_IsArray (ctx, v))
	{
		JS_ThrowTypeError (ctx, "%s: array of rows expected", pProp);
		return -1;
	}
	uint32_t nRows = 0, nCols = 0;
	JSValue Len = JS_GetPropertyStr (ctx, v, "length");
	JS_ToUint32 (ctx, &nRows, Len);
	JS_FreeValue (ctx, Len);
	if (CheckTableSize (ctx, nRows, 0, pProp)) return -1;

	for (uint32_t r = 0; r < nRows; r++)
	{
		JSValue Row = JS_GetPropertyUint32 (ctx, v, r);
		if (!JS_IsArray (ctx, Row))
		{
			JS_FreeValue (ctx, Row);
			JS_ThrowTypeError (ctx, "%s: row %u is not an array", pProp, (unsigned) r);
			return -1;
		}
		uint32_t n = 0;
		Len = JS_GetPropertyStr (ctx, Row, "length");
		JS_ToUint32 (ctx, &n, Len);
		JS_FreeValue (ctx, Len);
		JS_FreeValue (ctx, Row);
		if (n > nCols) nCols = n;
		if (CheckTableSize (ctx, nRows, nCols, pProp)) return -1;
	}

	lv_table_set_row_count (OBJ, nRows);
	lv_table_set_column_count (OBJ, nCols);

	for (uint32_t r = 0; r < nRows; r++)
	{
		JSValue Row = JS_GetPropertyUint32 (ctx, v, r);
		for (uint32_t c = 0; c < nCols; c++)
		{
			JSValue Cell = JS_GetPropertyUint32 (ctx, Row, c);
			if (CheckUIMemory (ctx, TextSize (ctx, Cell)))
			{
				JS_FreeValue (ctx, Cell);
				JS_FreeValue (ctx, Row);
				return -1;
			}
			const char *s = JS_IsUndefined (Cell) ? 0 : ToString (ctx, Cell, pProp);
			JS_FreeValue (ctx, Cell);
			if (s == 0 && JS_HasException (ctx))
			{
				JS_FreeValue (ctx, Row);
				return -1;
			}
			lv_table_set_cell_value (OBJ, r, c, s ? s : "");
			if (s) JS_FreeCString (ctx, s);
		}
		JS_FreeValue (ctx, Row);
	}
	return 0;
}

// QRCode
//
// Encoded here rather than by lv_qrcode_update(), so apps control the error
// correction level and can encode raw bytes: text is encoded in the most
// compact single mode (numeric, alphanumeric or byte), bytes in byte mode,
// with no automatic ECC boost - what SeedQR and codex32 QR codes expect.
// Drawn into lv_qrcode's 1-bit canvas with a 4-module quiet zone.

static int QRRender (JSContext *ctx, TGkNode *pNode)
{
	TGkQR *pQR = pNode->pQR;
	lv_obj_t *pObj = pNode->pObj;

	lv_draw_buf_t *pBuf = lv_canvas_get_draw_buf (pObj);
	if (pBuf == 0)
	{
		JS_ThrowInternalError (ctx, "QRCode: no canvas buffer");
		return -1;
	}

	lv_draw_buf_clear (pBuf, 0);
	lv_canvas_set_palette (pObj, 0, lv_color_to_32 (pQR->Light, LV_OPA_COVER));
	lv_canvas_set_palette (pObj, 1, lv_color_to_32 (pQR->Dark, LV_OPA_COVER));
	lv_image_cache_drop (pBuf);
	lv_obj_invalidate (pObj);
	pQR->nModules = 0;

	if (pQR->pData == 0)
	{
		return 0;
	}

	u8 *pCode = new u8[qrcodegen_BUFFER_LEN_MAX];
	u8 *pTemp = new u8[qrcodegen_BUFFER_LEN_MAX];
	bool bOK;
	if (pQR->bBinary)
	{
		if (pQR->nLength > qrcodegen_BUFFER_LEN_MAX)
		{
			bOK = false;
		}
		else
		{
			memcpy (pTemp, pQR->pData, pQR->nLength);
			bOK = qrcodegen_encodeBinary (pTemp, pQR->nLength, pCode, (qrcodegen_Ecc) pQR->nECC,
						      pQR->nMinVersion, qrcodegen_VERSION_MAX,
						      qrcodegen_Mask_AUTO, false);
		}
	}
	else
	{
		bOK = qrcodegen_encodeText ((const char *) pQR->pData, pTemp, pCode, (qrcodegen_Ecc) pQR->nECC,
					    pQR->nMinVersion, qrcodegen_VERSION_MAX,
					    qrcodegen_Mask_AUTO, false);
	}
	delete [] pTemp;

	if (!bOK)
	{
		delete [] pCode;
		JS_ThrowRangeError (ctx, "QRCode: too much data for a QR code");
		return -1;
	}

	int n = qrcodegen_getSize (pCode);
	int32_t w = pBuf->header.w;
	int32_t nScale = w / (n + 8);
	if (nScale < 1)
	{
		delete [] pCode;
		JS_ThrowRangeError (ctx, "QRCode: size %d px is too small for %d modules", (int) w, n);
		return -1;
	}
	int32_t nMargin = (w - nScale * n) / 2;

	// I1 format: 8-byte palette, then rows of 1 bit per pixel, MSB first
	u8 *pPixels = pBuf->data + 8;
	u32 nStride = pBuf->header.stride;
	for (int my = 0; my < n; my++)
	{
		for (int mx = 0; mx < n; mx++)
		{
			if (!qrcodegen_getModule (pCode, mx, my))
			{
				continue;
			}
			for (int32_t dy = 0; dy < nScale; dy++)
			{
				u8 *pRow = pPixels + nStride * (nMargin + my * nScale + dy);
				for (int32_t dx = 0; dx < nScale; dx++)
				{
					int32_t x = nMargin + mx * nScale + dx;
					pRow[x >> 3] |= 0x80 >> (x & 7);
				}
			}
		}
	}
	delete [] pCode;

	pQR->nModules = n;
	lv_image_cache_drop (pBuf);
	lv_obj_invalidate (pObj);

	return 0;
}

// Image src: { width, height, data } with data width * height * 4 bytes of
// RGBA (straight alpha, rows top to bottom) in a Uint8Array or ArrayBuffer,
// like canvas ImageData. Copied: the app may reuse its buffer.
static const int32_t ImageMaxSide = 1024;

static int GetImageSide (JSContext *ctx, JSValueConst v, const char *pKey, int32_t *pOut)
{
	JSValue Side = JS_GetPropertyStr (ctx, v, pKey);
	int nResult = JS_ToInt32 (ctx, pOut, Side);
	JS_FreeValue (ctx, Side);
	if (nResult == 0 && (*pOut < 1 || *pOut > ImageMaxSide))
	{
		JS_ThrowRangeError (ctx, "Image src: %s must be 1 to %d", pKey, (int) ImageMaxSide);
		return -1;
	}
	return nResult;
}

SETTER (SetImageSrc)
{
	if (!JS_IsObject (v))
	{
		JS_ThrowTypeError (ctx, "Image src must be { width, height, data }");
		return -1;
	}

	int32_t nWidth, nHeight;
	if (   GetImageSide (ctx, v, "width", &nWidth)
	    || GetImageSide (ctx, v, "height", &nHeight))
	{
		return -1;
	}
	size_t nPixelBytes = (size_t) nWidth * nHeight * 4;

	JSValue Data = JS_GetPropertyStr (ctx, v, "data");
	size_t nOffset = 0, nLength = 0, nElement;
	JSValue Buffer = JS_GetTypedArrayBuffer (ctx, Data, &nOffset, &nLength, &nElement);
	if (JS_IsException (Buffer))
	{
		JS_FreeValue (ctx, JS_GetException (ctx));
		Buffer = JS_DupValue (ctx, Data);		// maybe a plain ArrayBuffer
		nLength = (size_t) -1;
	}
	JS_FreeValue (ctx, Data);

	size_t nSize;
	const u8 *pData = JS_GetArrayBuffer (ctx, &nSize, Buffer);
	if (pData == 0)
	{
		JS_FreeValue (ctx, Buffer);
		JS_FreeValue (ctx, JS_GetException (ctx));
		JS_ThrowTypeError (ctx, "Image src: data must be a Uint8Array or an ArrayBuffer");
		return -1;
	}
	if (nLength == (size_t) -1)
	{
		nLength = nSize;
	}
	if (nLength != nPixelBytes)
	{
		JS_FreeValue (ctx, Buffer);
		JS_ThrowRangeError (ctx, "Image src: data must be width * height * 4 = %u bytes (RGBA), not %u",
				    (unsigned) nPixelBytes, (unsigned) nLength);
		return -1;
	}

	if (CheckUIMemory (ctx, nPixelBytes))
	{
		JS_FreeValue (ctx, Buffer);
		return -1;
	}

	// descriptor and pixels in one block; LVGL's ARGB8888 is B, G, R, A in memory
	u8 *pBlock = new u8[sizeof (lv_image_dsc_t) + nPixelBytes];
	s_nImageBytes += nPixelBytes;
	lv_image_dsc_t *pDesc = (lv_image_dsc_t *) pBlock;
	memset (pDesc, 0, sizeof *pDesc);
	u8 *pPixels = pBlock + sizeof (lv_image_dsc_t);
	const u8 *pIn = pData + nOffset;
	for (size_t i = 0; i < nPixelBytes; i += 4)
	{
		pPixels[i + 0] = pIn[i + 2];
		pPixels[i + 1] = pIn[i + 1];
		pPixels[i + 2] = pIn[i + 0];
		pPixels[i + 3] = pIn[i + 3];
	}
	JS_FreeValue (ctx, Buffer);

	pDesc->header.magic = LV_IMAGE_HEADER_MAGIC;
	pDesc->header.cf = LV_COLOR_FORMAT_ARGB8888;
	pDesc->header.w = nWidth;
	pDesc->header.h = nHeight;
	pDesc->header.stride = nWidth * 4;
	pDesc->data_size = nPixelBytes;
	pDesc->data = pPixels;

	lv_image_set_src (OBJ, pDesc);
	if (pNode->pImage != 0)
	{
		lv_image_cache_drop (pNode->pImage);
		s_nImageBytes -= pNode->pImage->data_size;
		delete [] (u8 *) pNode->pImage;
	}
	pNode->pImage = pDesc;

	return 0;
}

SETTER (SetQRData)
{
	TGkQR *pQR = pNode->pQR;
	u8 *pCopy;
	size_t nLength;
	boolean bBinary = FALSE;

	JSValue Hold = JS_UNDEFINED;
	size_t nOffset, nElement;
	JSValue Buffer = JS_IsObject (v) ? JS_GetTypedArrayBuffer (ctx, v, &nOffset, &nLength, &nElement)
					 : JS_EXCEPTION;
	if (JS_IsObject (v) && !JS_IsException (Buffer))
	{
		size_t nSize;
		u8 *p = JS_GetArrayBuffer (ctx, &nSize, Buffer);
		if (p == 0)
		{
			JS_FreeValue (ctx, Buffer);
			return -1;
		}
		pCopy = new u8[nLength + 1];
		memcpy (pCopy, p + nOffset, nLength);
		pCopy[nLength] = 0;
		bBinary = TRUE;
		Hold = Buffer;
	}
	else
	{
		if (JS_IsObject (v))
		{
			JS_FreeValue (ctx, JS_GetException (ctx));
		}
		const char *s = ToString (ctx, v, pProp);
		if (s == 0) return -1;
		nLength = strlen (s);
		pCopy = new u8[nLength + 1];
		memcpy (pCopy, s, nLength + 1);
		JS_FreeCString (ctx, s);
	}
	JS_FreeValue (ctx, Hold);

	// commit only if it encodes: a rejected value leaves the widget as it was
	TGkQR Old = *pQR;
	pQR->pData = pCopy;
	pQR->nLength = nLength;
	pQR->bBinary = bBinary;
	if (QRRender (ctx, pNode))
	{
		delete [] pCopy;
		*pQR = Old;
		JSValue Err = JS_GetException (ctx);
		QRRender (ctx, pNode);
		JS_Throw (ctx, Err);
		return -1;
	}
	delete [] Old.pData;

	return 0;
}

// Applies a change to the QR settings; reverts it if the result does not encode.
static int QRChange (JSContext *ctx, TGkNode *pNode, const TGkQR &rOld)
{
	if (QRRender (ctx, pNode) == 0)
	{
		return 0;
	}

	JSValue Err = JS_GetException (ctx);
	boolean bResize = pNode->pQR->nSize != rOld.nSize;
	*pNode->pQR = rOld;
	if (bResize)
	{
		lv_qrcode_set_size (pNode->pObj, rOld.nSize);
	}
	QRRender (ctx, pNode);
	JS_Throw (ctx, Err);

	return -1;
}

SETTER (SetQRSize)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (n < 21 || n > 1024)
	{
		JS_ThrowRangeError (ctx, "%s: 21 to 1024 px expected", pProp);
		return -1;
	}
	TGkQR Old = *pNode->pQR;
	pNode->pQR->nSize = n;
	lv_qrcode_set_size (OBJ, n);
	return QRChange (ctx, pNode, Old);
}

SETTER (SetQRDark)  { lv_color_t c; if (ToColor (ctx, v, pProp, &c)) return -1; pNode->pQR->Dark = c; return QRRender (ctx, pNode); }
SETTER (SetQRLight) { lv_color_t c; if (ToColor (ctx, v, pProp, &c)) return -1; pNode->pQR->Light = c; return QRRender (ctx, pNode); }

SETTER (SetQRECC)
{
	static const char *const Names[] = {"L", "M", "Q", "H"};
	static const int Values[] = {qrcodegen_Ecc_LOW, qrcodegen_Ecc_MEDIUM, qrcodegen_Ecc_QUARTILE, qrcodegen_Ecc_HIGH};
	int n;
	if (ToEnum (ctx, v, pProp, Names, Values, 4, &n)) return -1;
	TGkQR Old = *pNode->pQR;
	pNode->pQR->nECC = n;
	return QRChange (ctx, pNode, Old);
}

// the smallest version: a series of codes (BBQr) shows all its codes at one
// version, the last one too, though it holds less
SETTER (SetQRVersion)
{
	int32_t n;
	if (ToInt (ctx, v, pProp, &n)) return -1;
	if (n < qrcodegen_VERSION_MIN || n > qrcodegen_VERSION_MAX)
	{
		JS_ThrowRangeError (ctx, "%s: 1 to 40 expected", pProp);
		return -1;
	}
	TGkQR Old = *pNode->pQR;
	pNode->pQR->nMinVersion = n;
	return QRChange (ctx, pNode, Old);
}

GETTER (GetQRModules) { return JS_NewInt32 (ctx, pNode->pQR->nModules); }

struct TProp
{
	const char *pName;
	u32 nTypes;
	TSetter *pSet;
	TGetter *pGet;
};

#define TEXTUAL	(T (WLabel) | T (WButton) | T (WTextArea) | T (WCheckbox))
#define RANGED	(T (WSlider) | T (WBar))

static const TProp Props[] =
{
	// layout and geometry
	{"x",           ALL, SetX, 0},
	{"y",           ALL, SetY, 0},
	{"width",       ALL, SetWidth, GetWidth},
	{"height",      ALL, SetHeight, GetHeight},
	{"minWidth",    ALL, SetMinWidth, 0},
	{"maxWidth",    ALL, SetMaxWidth, 0},
	{"minHeight",   ALL, SetMinHeight, 0},
	{"maxHeight",   ALL, SetMaxHeight, 0},
	{"grow",        ALL, SetGrow, 0},
	{"align",       ALL, SetAlign, 0},
	{"layout",      ALL, SetLayout, 0},
	{"justify",     ALL, SetJustify, 0},
	{"alignItems",  ALL, SetAlignItems, 0},
	{"gap",         ALL, SetGap, 0},
	{"padding",     ALL, SetPadding, 0},
	// appearance
	{"bg",          ALL, SetBg, 0},
	{"color",       ALL, SetColor, 0},
	{"font",        ALL, SetFont, 0},
	{"mono",        ALL, SetMono, GetMono},
	{"textAlign",   ALL, SetTextAlign, 0},
	{"radius",      ALL, SetRadius, 0},
	{"borderWidth", ALL, SetBorderWidth, 0},
	{"borderColor", ALL, SetBorderColor, 0},
	{"opacity",     ALL, SetOpacity, 0},
	// state
	{"hidden",      ALL, SetHidden, GetHidden},
	{"disabled",    ALL, SetDisabled, GetDisabled},
	{"scrollable",  ALL, SetScrollable, 0},
	{"clickable",   ALL, SetClickable, 0},
	{"focusable",   ALL, SetFocusable, GetFocusable},
	// widget specific
	{"text",        TEXTUAL, SetText, GetText},
	{"overflow",    T (WLabel), SetOverflow, 0},
	{"markup",      T (WLabel), SetMarkup, GetMarkup},
	{"placeholder", T (WTextArea), SetPlaceholder, 0},
	{"oneLine",     T (WTextArea), SetOneLine, 0},
	{"password",    T (WTextArea), SetPassword, 0},
	{"maxLength",   T (WTextArea), SetMaxLength, 0},
	{"accept",      T (WTextArea), SetAccept, 0},
	{"checked",     T (WCheckbox) | T (WSwitch), SetChecked, GetChecked},
	{"options",     T (WDropdown), SetOptions, 0},
	{"selected",    T (WDropdown), SetSelected, GetSelected},
	{"active",      T (WTabView), SetSelected, GetSelected},
	{"min",         RANGED, SetMin, GetMin},
	{"max",         RANGED, SetMax, GetMax},
	{"value",       RANGED, SetValue, GetValue},
	{"rows",        T (WTable), SetRows, GetRows},
	{"cols",        T (WTable), SetCols, GetCols},
	{"data",        T (WTable) | T (WQRCode), 0, 0},	// dispatched in ApplyProp
	{"size",        T (WQRCode), SetQRSize, 0},
	{"dark",        T (WQRCode), SetQRDark, 0},
	{"light",       T (WQRCode), SetQRLight, 0},
	{"ecc",         T (WQRCode), SetQRECC, 0},
	{"version",     T (WQRCode), SetQRVersion, 0},
	{"modules",     T (WQRCode), 0, GetQRModules},
	{"src",         T (WImage), SetImageSrc, 0},
	{"detect",      T (WScanner), SetDetect, GetDetect},
	{"field",       T (WScanner), SetField, GetField},
};
static const unsigned PropCount = sizeof Props / sizeof Props[0];

// the "value" carried by change events
static JSValue GetValueProp (JSContext *ctx, TGkNode *pNode)
{
	switch (pNode->Type)
	{
	case WTextArea:	return GetText (ctx, pNode);
	case WCheckbox:
	case WSwitch:	return GetChecked (ctx, pNode);
	case WSlider:
	case WBar:	return GetValue (ctx, pNode);
	case WDropdown:
	case WTabView:	return GetSelected (ctx, pNode);
	default:	return JS_UNDEFINED;
	}
}

// LVGL's memory is capped (lv_mem_limit.h): an app may not grow its screen
// past the soft limit. nMore: what is about to be added, if known (a
// string's UTF-8 bytes at most). A RangeError the app sees, not a failed
// allocation inside LVGL.
static int CheckUIMemory (JSContext *ctx, size_t nMore)
{
	size_t nUsed = gk_lv_mem_used () + s_nImageBytes;
	if (nUsed > GK_LV_MEM_SOFT_LIMIT || nMore > GK_LV_MEM_SOFT_LIMIT - nUsed)
	{
		JS_ThrowRangeError (ctx, "the app's widgets would use more than "
				    GK_LV_MEM_SOFT_LIMIT_TEXT " of memory");
		return -1;
	}
	return 0;
}

// The most bytes v takes as UTF-8 text, if it is a string; else 0
static size_t TextSize (JSContext *ctx, JSValueConst v)
{
	if (!JS_IsString (v))
	{
		return 0;
	}
	uint32_t nLength = 0;
	JSValue Length = JS_GetPropertyStr (ctx, v, "length");
	JS_ToUint32 (ctx, &nLength, Length);
	JS_FreeValue (ctx, Length);
	return (size_t) nLength * 3;		// UTF-16 units: at most 3 bytes each
}

static int ApplyProp (JSContext *ctx, TGkNode *pNode, const char *pName, JSValueConst v)
{
	if (CheckUIMemory (ctx, TextSize (ctx, v)))
	{
		return -1;
	}

	for (unsigned i = 0; i < EvCount; i++)
	{
		if (strcmp (pName, Events[i].pProp) == 0 && (Events[i].nTypes & T (pNode->Type)))
		{
			return SetHandler (ctx, pNode, i, v);
		}
	}

	for (unsigned i = 0; i < PropCount; i++)
	{
		const TProp *p = &Props[i];
		if (strcmp (pName, p->pName) != 0 || !(p->nTypes & T (pNode->Type)))
		{
			continue;
		}

		if (strcmp (pName, "data") == 0)
		{
			return pNode->Type == WTable ? SetData (ctx, pNode, v, pName)
						     : SetQRData (ctx, pNode, v, pName);
		}

		return p->pSet (ctx, pNode, v, pName);
	}

	JS_ThrowTypeError (ctx, "%s has no property '%s'", TypeNames[pNode->Type], pName);
	return -1;
}

static int ApplyProps (JSContext *ctx, TGkNode *pNode, JSValueConst Obj)
{
	if (JS_IsUndefined (Obj) || JS_IsNull (Obj))
	{
		return 0;
	}
	if (!JS_IsObject (Obj) || JS_IsArray (ctx, Obj) || JS_IsFunction (ctx, Obj))
	{
		JS_ThrowTypeError (ctx, "properties object expected");
		return -1;
	}

	JSPropertyEnum *pTab;
	uint32_t nLen;
	if (JS_GetOwnPropertyNames (ctx, &pTab, &nLen, Obj, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY))
	{
		return -1;
	}

	int nRes = 0;
	for (uint32_t i = 0; i < nLen && nRes == 0; i++)
	{
		const char *pName = JS_AtomToCString (ctx, pTab[i].atom);
		JSValue v = JS_GetProperty (ctx, Obj, pTab[i].atom);
		if (pName == 0 || JS_IsException (v))
		{
			nRes = -1;
		}
		else if (pNode->pObj == 0 || pNode->bDeleting)
		{
			JS_ThrowTypeError (ctx, "%s has been deleted", TypeNames[pNode->Type]);
			nRes = -1;
		}
		else
		{
			nRes = ApplyProp (ctx, pNode, pName, v);
		}
		JS_FreeValue (ctx, v);
		if (pName) JS_FreeCString (ctx, pName);
	}

	JS_FreePropertyEnum (ctx, pTab, nLen);

	return nRes;
}

// --- widget methods ---------------------------------------------------------

static JSValue js_widget_set (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	if (ApplyProps (ctx, pNode, argc > 0 ? argv[0] : JS_UNDEFINED))
	{
		return JS_EXCEPTION;
	}

	return JS_DupValue (ctx, this_val);	// chainable
}

static int EventSlot (JSContext *ctx, TGkNode *pNode, JSValueConst Name)
{
	const char *s = JS_ToCString (ctx, Name);
	if (s != 0)
	{
		for (unsigned i = 0; i < EvCount; i++)
		{
			if (strcmp (s, Events[i].pName) == 0 && (Events[i].nTypes & T (pNode->Type)))
			{
				JS_FreeCString (ctx, s);
				return i;
			}
		}
		JS_FreeCString (ctx, s);
	}

	JS_ThrowTypeError (ctx, "%s has no such event (see docs/API.md)", TypeNames[pNode->Type]);
	return -1;
}

static JSValue js_widget_on (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	int nSlot = EventSlot (ctx, pNode, argc > 0 ? argv[0] : JS_UNDEFINED);
	if (nSlot < 0) return JS_EXCEPTION;

	if (argc < 2 || !JS_IsFunction (ctx, argv[1]))
	{
		return JS_ThrowTypeError (ctx, "on: handler function expected");
	}

	if (SetHandler (ctx, pNode, nSlot, argv[1])) return JS_EXCEPTION;

	return JS_DupValue (ctx, this_val);
}

static JSValue js_widget_off (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	int nSlot = EventSlot (ctx, pNode, argc > 0 ? argv[0] : JS_UNDEFINED);
	if (nSlot < 0) return JS_EXCEPTION;

	SetHandler (ctx, pNode, nSlot, JS_NULL);

	return JS_DupValue (ctx, this_val);
}

static JSValue js_widget_focus (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	lv_group_t *pGroup = (lv_group_t *) lv_obj_get_group (pNode->pObj);
	if (pGroup != 0)
	{
		lv_group_focus_obj (pNode->pObj);
	}

	return JS_UNDEFINED;
}

static void DeferDelete (JSContext *ctx, TGkNode *pNode)
{
	if (pNode->bDeleting)
	{
		return;
	}

	pNode->bDeleting = TRUE;
	pNode->DeferredRef = JS_DupValue (ctx, pNode->Wrapper);
	pNode->pNextDeferred = pNode->pApp->pDeferredDelete;
	pNode->pApp->pDeferredDelete = pNode;

	// take it out of view and out of the focus order right away
	lv_obj_add_flag (pNode->pObj, LV_OBJ_FLAG_HIDDEN);
	lv_group_remove_obj (pNode->pObj);
}

static JSValue js_widget_delete (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val, FALSE);
	if (pNode == 0) return JS_EXCEPTION;

	if (pNode->pObj == 0 || pNode->bDeleting)
	{
		return JS_UNDEFINED;		// deleting twice is harmless
	}

	if (pNode->pObj == pNode->pApp->pScreen)
	{
		return JS_ThrowTypeError (ctx, "the app screen cannot be deleted (use clear())");
	}

	DeferDelete (ctx, pNode);

	return JS_UNDEFINED;
}

static JSValue js_widget_clear (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	for (u32 i = 0; i < lv_obj_get_child_count (pNode->pObj); i++)
	{
		lv_obj_t *pChild = lv_obj_get_child (pNode->pObj, i);
		JSValue Child = Wrap (ctx, pChild, GuessType (pChild), JS_UNDEFINED);
		if (JS_IsException (Child)) return Child;
		DeferDelete (ctx, (TGkNode *) JS_GetOpaque (Child, s_WidgetClass));
		JS_FreeValue (ctx, Child);
	}

	return JS_DupValue (ctx, this_val);
}

static JSValue js_widget_scroll_into_view (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	lv_obj_scroll_to_view_recursive (pNode->pObj, LV_ANIM_ON);

	return JS_UNDEFINED;
}

static JSValue js_widget_get_parent (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	lv_obj_t *pParent = lv_obj_get_parent (pNode->pObj);
	if (pParent == 0)
	{
		return JS_NULL;
	}

	return Wrap (ctx, pParent, GuessType (pParent), JS_UNDEFINED);
}

static JSValue js_widget_get_children (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	JSValue Array = JS_NewArray (ctx);
	uint32_t n = 0;
	for (u32 i = 0; i < lv_obj_get_child_count (pNode->pObj); i++)
	{
		lv_obj_t *pChild = lv_obj_get_child (pNode->pObj, i);
		TGkNode *pChildNode = (TGkNode *) lv_obj_get_user_data (pChild);
		if (pChildNode != 0 && pChildNode->bDeleting)
		{
			continue;
		}
		JS_SetPropertyUint32 (ctx, Array, n++, Wrap (ctx, pChild, GuessType (pChild), JS_UNDEFINED));
	}

	return Array;
}

static JSValue js_widget_get_alive (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val, FALSE);
	if (pNode == 0) return JS_EXCEPTION;

	return JS_NewBool (ctx, pNode->pObj != 0 && !pNode->bDeleting);
}

static JSValue js_widget_get_type (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val, FALSE);
	if (pNode == 0) return JS_EXCEPTION;

	return JS_NewString (ctx, TypeNames[pNode->Type]);
}

// Table methods

static int CellArgs (JSContext *ctx, TGkNode *pNode, int argc, JSValueConst *argv, uint32_t *pRow, uint32_t *pCol)
{
	if (pNode->Type != WTable)
	{
		JS_ThrowTypeError (ctx, "not a Table");
		return -1;
	}
	if (argc < 2 || JS_ToUint32 (ctx, pRow, argv[0]) || JS_ToUint32 (ctx, pCol, argv[1]))
	{
		JS_ThrowTypeError (ctx, "row and column expected");
		return -1;
	}
	return 0;
}

// Whether the table may grow to have row nRow and column nCol (LVGL grows
// it to reach a cell set beyond it)
static int CheckTableReach (JSContext *ctx, lv_obj_t *pTable, uint32_t nRow, uint32_t nCol, const char *pWhat)
{
	if (nRow >= MaxTableRows || nCol >= MaxTableCols)
	{
		return CheckTableSize (ctx, MaxTableRows + 1, 0, pWhat);	// throws
	}
	uint32_t nRows = lv_table_get_row_count (pTable), nCols = lv_table_get_column_count (pTable);
	return CheckTableSize (ctx, nRow >= nRows ? nRow + 1 : nRows, nCol >= nCols ? nCol + 1 : nCols, pWhat);
}

static JSValue js_table_set_cell (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	uint32_t r, c;
	if (pNode == 0 || CellArgs (ctx, pNode, argc, argv, &r, &c)) return JS_EXCEPTION;
	if (CheckTableReach (ctx, pNode->pObj, r, c, "setCell")) return JS_EXCEPTION;
	if (CheckUIMemory (ctx, TextSize (ctx, argc > 2 ? argv[2] : JS_UNDEFINED))) return JS_EXCEPTION;

	const char *s = ToString (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "setCell");
	if (s == 0) return JS_EXCEPTION;
	lv_table_set_cell_value (pNode->pObj, r, c, s);
	JS_FreeCString (ctx, s);

	return JS_UNDEFINED;
}

static JSValue js_table_get_cell (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	uint32_t r, c;
	if (pNode == 0 || CellArgs (ctx, pNode, argc, argv, &r, &c)) return JS_EXCEPTION;

	if (r >= lv_table_get_row_count (pNode->pObj) || c >= lv_table_get_column_count (pNode->pObj))
	{
		return JS_UNDEFINED;
	}

	const char *s = lv_table_get_cell_value (pNode->pObj, r, c);
	return JS_NewString (ctx, s ? s : "");
}

static JSValue js_table_set_column_width (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	uint32_t c;
	int32_t w;
	if (pNode->Type != WTable || argc < 2 || JS_ToUint32 (ctx, &c, argv[0]) || ToInt (ctx, argv[1], "width", &w))
	{
		return JS_ThrowTypeError (ctx, "setColumnWidth(column, width) expected");
	}
	if (CheckTableReach (ctx, pNode->pObj, 0, c, "setColumnWidth"))
	{
		return JS_EXCEPTION;
	}
	lv_table_set_column_width (pNode->pObj, c, w);

	return JS_UNDEFINED;
}

// TabView method: addTab(title) -> Container (the tab's page)
static JSValue js_tabview_add_tab (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;
	if (pNode->Type != WTabView) return JS_ThrowTypeError (ctx, "not a TabView");

	const char *s = ToString (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "addTab");
	if (s == 0) return JS_EXCEPTION;
	lv_obj_t *pPage = lv_tabview_add_tab (pNode->pObj, s);
	JS_FreeCString (ctx, s);

	return Wrap (ctx, pPage, WContainer, JS_UNDEFINED);
}

// --- property accessors -----------------------------------------------------

static JSValue js_prop_get (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	if (magic >= 1000)
	{
		return JS_DupValue (ctx, pNode->Handlers[magic - 1000]);
	}

	return Props[magic].pGet (ctx, pNode);
}

static JSValue js_prop_set (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	JSValueConst v = argc > 0 ? argv[0] : JS_UNDEFINED;
	const char *pName = magic >= 1000 ? Events[magic - 1000].pProp : Props[magic].pName;
	if (ApplyProp (ctx, pNode, pName, v))
	{
		return JS_EXCEPTION;
	}

	return JS_UNDEFINED;
}

static void DefineAccessor (JSContext *ctx, JSValueConst Proto, const char *pName, int nMagic, boolean bGetter)
{
	JSAtom Atom = JS_NewAtom (ctx, pName);
	JSValue Get = bGetter ? JS_NewCFunctionMagic (ctx, js_prop_get, pName, 0, JS_CFUNC_generic_magic, nMagic)
			      : JS_UNDEFINED;
	JSValue Set = JS_NewCFunctionMagic (ctx, js_prop_set, pName, 1, JS_CFUNC_generic_magic, nMagic);
	JS_DefinePropertyGetSet (ctx, Proto, Atom, Get, Set, JS_PROP_CONFIGURABLE);
	JS_FreeAtom (ctx, Atom);
}

static void DefineMethod (JSContext *ctx, JSValueConst Obj, const char *pName, JSCFunction *pFunc, int nArgs)
{
	JS_DefinePropertyValueStr (ctx, Obj, pName, JS_NewCFunction (ctx, pFunc, pName, nArgs),
				   JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
}

static void DefineGetter (JSContext *ctx, JSValueConst Obj, const char *pName, JSCFunction *pFunc)
{
	JSAtom Atom = JS_NewAtom (ctx, pName);
	JS_DefinePropertyGetSet (ctx, Obj, Atom, JS_NewCFunction (ctx, pFunc, pName, 0), JS_UNDEFINED,
				 JS_PROP_CONFIGURABLE);
	JS_FreeAtom (ctx, Atom);
}

// --- QR scanner -------------------------------------------------------------

// Calls the handler of a GapKeep event (EvCode, EvError) with an event
// object; Ev is consumed.
static void FireEvent (TGkNode *pNode, unsigned nSlot, JSValue Ev)
{
	TGkApp *pApp = pNode->pApp;
	JSContext *ctx = pApp->pContext;
	if (   JS_IsUndefined (pNode->Handlers[nSlot]) || pApp->pUI == 0 || pApp->pUI->bStopping
	    || pNode->pObj == 0 || pNode->bDeleting)
	{
		JS_FreeValue (ctx, Ev);
		return;
	}

	JSValue Wrapper = JS_DupValue (ctx, pNode->Wrapper);
	JSValue Handler = JS_DupValue (ctx, pNode->Handlers[nSlot]);	// it may replace itself
	JS_SetPropertyStr (ctx, Ev, "type", JS_NewString (ctx, Events[nSlot].pName));
	JS_SetPropertyStr (ctx, Ev, "target", JS_DupValue (ctx, Wrapper));
	JSValue Result = CAppHost::Get ()->Call (Handler, Wrapper, 1, &Ev);
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Handler);
	JS_FreeValue (ctx, Ev);
	JS_FreeValue (ctx, Wrapper);
}

// The bytes as a string if they are valid UTF-8 (no overlongs, surrogates
// or NUL), else null.
static JSValue Utf8OrNull (JSContext *ctx, const u8 *p, unsigned n)
{
	static const u32 Min[] = {0, 0x80, 0x800, 0x10000};
	for (unsigned i = 0; i < n; )
	{
		u8 c = p[i];
		unsigned nMore = c < 0x80 ? 0 : (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2
			       : (c & 0xF8) == 0xF0 ? 3 : 4;
		if (c == 0 || nMore == 4 || nMore >= n - i)
		{
			return JS_NULL;
		}
		u32 nCode = nMore == 0 ? c : nMore == 1 ? c & 0x1F : nMore == 2 ? c & 0x0F : c & 0x07;
		for (unsigned k = 1; k <= nMore; k++)
		{
			if ((p[i + k] & 0xC0) != 0x80)
			{
				return JS_NULL;
			}
			nCode = (nCode << 6) | (p[i + k] & 0x3F);
		}
		if (nCode < Min[nMore] || nCode > 0x10FFFF || (nCode >= 0xD800 && nCode <= 0xDFFF))
		{
			return JS_NULL;
		}
		i += 1 + nMore;
	}

	return JS_NewStringLen (ctx, (const char *) p, n);
}

static JSValue NewBytes (JSContext *ctx, const u8 *pData, unsigned nLength)
{
	JSValue Buffer = JS_NewArrayBufferCopy (ctx, pData, nLength);
	JSValue Args[3] = {Buffer, JS_NewInt32 (ctx, 0), JS_NewInt32 (ctx, (int32_t) nLength)};
	JSValue Bytes = JS_NewTypedArray (ctx, 3, Args, JS_TYPED_ARRAY_UINT8);
	JS_FreeValue (ctx, Buffer);
	return Bytes;
}

static void ScanTimerCallback (lv_timer_t *pTimer)
{
	TGkNode *pNode = (TGkNode *) lv_timer_get_user_data (pTimer);
	TGkScan *pScan = pNode->pScan;
	JSContext *ctx = pNode->pApp->pContext;

	if (pScan->bErrorPending)
	{
		pScan->bErrorPending = FALSE;
		JSValue Ev = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, Ev, "reason", JS_NewString (ctx, pScan->pScanner->GetError ()));
		FireEvent (pNode, EvError, Ev);
		return;
	}

	unsigned nPoll = pScan->pScanner->Poll ();
	if (pNode->pObj == 0)
	{
		return;
	}
	if (nPoll & (CGkScanner::PollFrame | CGkScanner::PollError))
	{
		lv_obj_invalidate (pNode->pObj);
	}
	// one event per detection: a QR code, and (experimental) its colour
	// layer; a handler may stop or delete the scanner
	unsigned nKind;
	unsigned nLength;
	const u8 *pData;
	while (   (nPoll & CGkScanner::PollDetect) && pNode->pObj != 0 && pNode->pScan == pScan
	       && (nKind = pScan->pScanner->GetDetection (&pData, &nLength)) != 0)
	{
		JSValue Ev = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, Ev, "kind", JS_NewString (ctx, nKind == GK_DETECT_QR ? "qr" : "qr-color"));
		JS_SetPropertyStr (ctx, Ev, "bytes", NewBytes (ctx, pData, nLength));
		JS_SetPropertyStr (ctx, Ev, "text", Utf8OrNull (ctx, pData, nLength));
		if (nKind == GK_DETECT_QR_COLOR)
		{
			const u8 *pColour;
			unsigned nColour;
			TGkColourStatus Status = pScan->pScanner->GetColour (&pColour, &nColour);
			JS_SetPropertyStr (ctx, Ev, "status", JS_NewString (ctx,
				Status == GkColourOK ? "ok" : Status == GkColourPlain ? "plain" : "unreadable"));
			JS_SetPropertyStr (ctx, Ev, "colour", pColour != 0 ? NewBytes (ctx, pColour, nColour) : JS_NULL);
		}
		FireEvent (pNode, EvDetect, Ev);
	}
	if ((nPoll & CGkScanner::PollError) && pNode->pScan != 0)
	{
		JSValue Ev = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, Ev, "reason", JS_NewString (ctx, pScan->pScanner->GetError ()));
		FireEvent (pNode, EvError, Ev);
	}
}

static void CreateScan (TGkNode *pNode)
{
	TGkScan *pScan = new TGkScan;
	memset (pScan, 0, sizeof *pScan);
	pScan->pScanner = new CGkScanner;
	pScan->pTimer = lv_timer_create (ScanTimerCallback, 30, pNode);
	pNode->pScan = pScan;
}

static void StartScan (TGkNode *pNode)
{
	TGkScan *pScan = pNode->pScan;
	if (!pScan->pScanner->Start ())
	{
		pScan->bErrorPending = TRUE;	// reported from the timer, not from inside new/start()
	}
	lv_obj_invalidate (pNode->pObj);
}

static void FreeScan (TGkNode *pNode)
{
	TGkScan *pScan = pNode->pScan;
	if (pScan == 0)
	{
		return;
	}

	lv_timer_delete (pScan->pTimer);
	delete pScan->pScanner;
	if (pScan->pPixels != 0)
	{
		lv_image_cache_drop (&pScan->Preview);
		gk_wipe (pScan->pPixels, pScan->Preview.data_size);	// a picture of a code
		delete [] pScan->pPixels;
	}
	delete pScan;
	pNode->pScan = 0;
}

// Draws the preview, or what the scanner is doing when there is none.
static void ScanDrawCallback (lv_event_t *e)
{
	lv_obj_t *pObj = (lv_obj_t *) lv_event_get_current_target (e);
	TGkNode *pNode = (TGkNode *) lv_obj_get_user_data (pObj);
	if (pNode == 0 || pNode->pScan == 0)
	{
		return;
	}
	TGkScan *pScan = pNode->pScan;
	lv_layer_t *pLayer = lv_event_get_layer (e);

	lv_area_t Area;
	lv_obj_get_content_coords (pObj, &Area);
	int32_t nWidth = lv_area_get_width (&Area), nHeight = lv_area_get_height (&Area);
	if (nWidth <= 0 || nHeight <= 0)
	{
		return;
	}

	CGkScanner *pScanner = pScan->pScanner;
	const char *pText = 0;
	CString Status;
	if (!pScanner->IsScanning ())
	{
		const char *pError = pScanner->GetError ();
		if (pError != 0)
		{
			Status.Format ("%s %s", LV_SYMBOL_WARNING, pError);
			pText = Status;
		}
		else
		{
			pText = "Stopped";
		}
	}
	else
	{
		// (re)size the preview to the content area
		if (   pScan->pPixels == 0
		    || pScan->Preview.header.w != (uint32_t) nWidth
		    || pScan->Preview.header.h != (uint32_t) nHeight)
		{
			if (pScan->pPixels != 0)
			{
				lv_image_cache_drop (&pScan->Preview);
				gk_wipe (pScan->pPixels, pScan->Preview.data_size);
				delete [] pScan->pPixels;
			}
			pScan->pPixels = new u16[nWidth * nHeight];
			memset (&pScan->Preview, 0, sizeof pScan->Preview);
			pScan->Preview.header.magic = LV_IMAGE_HEADER_MAGIC;
			pScan->Preview.header.cf = LV_COLOR_FORMAT_RGB565;
			pScan->Preview.header.w = nWidth;
			pScan->Preview.header.h = nHeight;
			pScan->Preview.header.stride = nWidth * 2;
			pScan->Preview.data = (const u8 *) pScan->pPixels;
			pScan->Preview.data_size = nWidth * nHeight * 2;
		}
		if (pScanner->DrawPreview (pScan->pPixels, nWidth, nHeight))
		{
			lv_image_cache_drop (&pScan->Preview);
			lv_draw_image_dsc_t Dsc;
			lv_draw_image_dsc_init (&Dsc);
			Dsc.src = &pScan->Preview;
			lv_draw_image (pLayer, &Dsc, &Area);
			return;
		}
		pText = "Starting the camera...";
	}

	lv_draw_label_dsc_t Label;
	lv_draw_label_dsc_init (&Label);
	lv_obj_init_draw_label_dsc (pObj, LV_PART_MAIN, &Label);
	Label.text = pText;
	Label.text_local = 1;
	Label.align = LV_TEXT_ALIGN_CENTER;
	lv_area_t TextArea = Area;
	int32_t nLine = lv_font_get_line_height (Label.font);
	TextArea.y1 = Area.y1 + (nHeight - nLine) / 2;
	TextArea.y2 = TextArea.y1 + 2 * nLine;
	lv_draw_label (pLayer, &Label, &TextArea);
}

static TGkNode *GetScanner (JSContext *ctx, JSValueConst this_val)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode != 0 && pNode->pScan == 0)
	{
		JS_ThrowTypeError (ctx, "not a Scanner");
		return 0;
	}
	return pNode;
}

static JSValue js_scanner_start (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetScanner (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;
	if (!pNode->pScan->pScanner->IsScanning ())
	{
		StartScan (pNode);
	}
	return JS_UNDEFINED;
}

static JSValue js_scanner_stop (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetScanner (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;
	pNode->pScan->bErrorPending = FALSE;
	pNode->pScan->pScanner->Stop ();
	if (pNode->pScan->pPixels != 0)
	{
		// not drawn while stopped: the last picture goes now
		gk_wipe (pNode->pScan->pPixels, pNode->pScan->Preview.data_size);
	}
	lv_obj_invalidate (pNode->pObj);
	return JS_UNDEFINED;
}

static JSValue js_scanner_get_scanning (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetScanner (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;
	return JS_NewBool (ctx, pNode->pScan->pScanner->IsScanning ());
}

// --- constructors -----------------------------------------------------------

static lv_obj_t *CreateObject (TWidgetType Type, lv_obj_t *pParent, boolean bMarkup)
{
	lv_obj_t *p = 0;
	switch (Type)
	{
	case WContainer:
		p = lv_obj_create (pParent);
		lv_obj_remove_style_all (p);		// plain: no background, border or padding
		lv_obj_set_size (p, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
		lv_obj_remove_flag (p, LV_OBJ_FLAG_SCROLLABLE);	// unless asked (SetScrollable)
		AllowRingOverflow (p);				// don't clip focus rings
		break;
	case WPanel:	p = lv_obj_create (pParent);
			lv_obj_set_size (p, LV_SIZE_CONTENT, LV_SIZE_CONTENT);	break;
	case WLabel:
		if (bMarkup)
		{
			p = lv_spangroup_create (pParent);
			lv_spangroup_set_overflow (p, LV_SPAN_OVERFLOW_CLIP);
			break;
		}
		p = lv_label_create (pParent);
		lv_label_set_text (p, "");
		break;
	case WButton:	p = lv_button_create (pParent);			break;
	case WTextArea:	p = lv_textarea_create (pParent);		break;
	case WCheckbox:	p = lv_checkbox_create (pParent); lv_checkbox_set_text (p, "");	break;
	case WSwitch:	p = lv_switch_create (pParent);			break;
	case WDropdown:	p = lv_dropdown_create (pParent); lv_dropdown_set_options (p, "");	break;
	case WSlider:	p = lv_slider_create (pParent);			break;
	case WBar:	p = lv_bar_create (pParent);			break;
	case WTable:	p = lv_table_create (pParent);			break;
	case WQRCode:
		p = lv_qrcode_create (pParent);
		lv_qrcode_set_size (p, 160);	// see QRRender: we draw ourselves
		break;
	case WTabView:	p = lv_tabview_create (pParent);		break;
	case WImage:
		p = lv_image_create (pParent);
		// natural size, or scaled down/up to fit a width and height set by the app
		lv_image_set_inner_align (p, LV_IMAGE_ALIGN_CONTAIN);
		break;
	case WScanner:
		p = lv_obj_create (pParent);
		lv_obj_remove_style_all (p);
		lv_obj_set_size (p, 320, 240);
		lv_obj_set_style_bg_color (p, lv_color_black (), 0);
		lv_obj_set_style_bg_opa (p, LV_OPA_COVER, 0);
		lv_obj_set_style_text_color (p, lv_color_white (), 0);
		lv_obj_remove_flag (p, LV_OBJ_FLAG_SCROLLABLE);
		lv_obj_remove_flag (p, LV_OBJ_FLAG_CLICKABLE);
		lv_obj_add_event_cb (p, ScanDrawCallback, LV_EVENT_DRAW_MAIN, 0);
		break;
	default:	assert (0);
	}

	return p;
}

// new ui.Label([parent], [props])
static JSValue js_widget_ctor (JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv, int magic)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	TWidgetType Type = (TWidgetType) magic;

	if (JS_IsUndefined (new_target))
	{
		return JS_ThrowTypeError (ctx, "use 'new ui.%s(...)'", TypeNames[Type]);
	}

	lv_obj_t *pParent = pApp->pScreen;
	JSValueConst Props = JS_UNDEFINED;
	int nArg = 0;

	if (argc > 0 && JS_GetOpaque (argv[0], s_WidgetClass) != 0)
	{
		TGkNode *pParentNode = GetNode (ctx, argv[0]);
		if (pParentNode == 0) return JS_EXCEPTION;
		pParent = pParentNode->pObj;
		nArg = 1;
	}
	else if (argc > 0 && (JS_IsNull (argv[0]) || JS_IsUndefined (argv[0])))
	{
		nArg = 1;
	}
	if (argc > nArg)
	{
		Props = argv[nArg];
	}

	if (Type == WScanner && !(pApp->pBundle->permissions & GK_PERM_CAMERA))
	{
		return JS_ThrowTypeError (ctx, "ui.Scanner needs \"permissions\": [\"camera\"] in manifest.json");
	}
	if (CheckUIMemory (ctx, 0))
	{
		return JS_EXCEPTION;
	}

	// support subclasses: class MyButton extends ui.Button { ... }
	JSValue Proto = JS_GetPropertyStr (ctx, new_target, "prototype");
	if (JS_IsException (Proto)) return Proto;

	// a Label with markup: true is a spangroup (markup.h)
	boolean bMarkup = FALSE;
	if (Type == WLabel && JS_IsObject (Props))
	{
		JSValue Markup = JS_GetPropertyStr (ctx, Props, "markup");
		bMarkup = JS_IsBool (Markup) && JS_ToBool (ctx, Markup);
		JS_FreeValue (ctx, Markup);
	}

	lv_obj_t *pObj = CreateObject (Type, pParent, bMarkup);
	if (pApp->pUI->pEPaper != 0 && lv_obj_get_screen (pObj) == pApp->pUI->pEPaper->GetScreen ())
	{
		lv_group_remove_obj (pObj);	// on the e-paper panel: not a keyboard target
	}
	JSValue Obj = Wrap (ctx, pObj, Type, JS_IsObject (Proto) ? (JSValueConst) Proto : JS_UNDEFINED);
	JS_FreeValue (ctx, Proto);
	if (JS_IsException (Obj))
	{
		lv_obj_delete (pObj);
		return Obj;
	}

	TGkNode *pNode = (TGkNode *) JS_GetOpaque (Obj, s_WidgetClass);
	pNode->bMarkup = bMarkup;
	if (Type == WScanner)
	{
		CreateScan (pNode);
	}
	if (ApplyProps (ctx, pNode, Props))
	{
		DeferDelete (ctx, pNode);
		JS_FreeValue (ctx, Obj);
		return JS_EXCEPTION;
	}
	if (Type == WScanner)
	{
		if (!pNode->pScan->bDetectSet)
		{
			DeferDelete (ctx, pNode);
			JS_FreeValue (ctx, Obj);
			return JS_ThrowTypeError (ctx, "ui.Scanner: \"detect\" is required: what to look for, e.g. [\"qr\"]");
		}
		StartScan (pNode);	// after the props: onError may be among them
	}

	return Obj;
}

static JSValue js_widget_base_ctor (JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv)
{
	return JS_ThrowTypeError (ctx, "ui.Widget is abstract: use ui.Container, ui.Label, ...");
}

// --- alerts -----------------------------------------------------------------

static void AlertClose (TGkAlert *pAlert, int nResult)
{
	if (pAlert->bClosing)
	{
		return;
	}

	pAlert->bClosing = TRUE;
	pAlert->nResult = nResult;
	lv_obj_add_flag (pAlert->pOverlay, LV_OBJ_FLAG_HIDDEN);
	// resolved and deleted in GkUIProcessDeferred, outside LVGL event processing
}

static void AlertButtonEvent (lv_event_t *e)
{
	TGkAlert *pAlert = (TGkAlert *) lv_event_get_user_data (e);
	lv_obj_t *pButton = (lv_obj_t *) lv_event_get_target (e);

	if (lv_event_get_code (e) == LV_EVENT_KEY)
	{
		if (lv_event_get_key (e) == LV_KEY_ESC)
		{
			AlertClose (pAlert, -1);
		}
		return;
	}

	AlertClose (pAlert, (int) lv_obj_get_index (pButton));
}

// ui.alert(message, {title, buttons}) -> Promise<index> (-1: Escape)
static JSValue js_ui_alert (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	TGkUIState *pUI = pApp->pUI;

	const char *pMessage = ToString (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "alert");
	if (pMessage == 0) return JS_EXCEPTION;

	JSValueConst Options = argc > 1 ? argv[1] : JS_UNDEFINED;
	JSValue Title = JS_IsObject (Options) ? JS_GetPropertyStr (ctx, Options, "title") : JS_UNDEFINED;
	JSValue Buttons = JS_IsObject (Options) ? JS_GetPropertyStr (ctx, Options, "buttons") : JS_UNDEFINED;

	TGkAlert *pAlert = new TGkAlert;
	memset (pAlert, 0, sizeof *pAlert);
	pAlert->pApp = pApp;

	JSValue Funcs[2];
	JSValue Promise = JS_NewPromiseCapability (ctx, Funcs);
	pAlert->Resolve = Funcs[0];
	JS_FreeValue (ctx, Funcs[1]);

	// full-screen overlay that swallows clicks
	lv_obj_t *pOverlay = lv_obj_create (pApp->pScreen);
	lv_obj_remove_style_all (pOverlay);
	lv_obj_set_size (pOverlay, lv_pct (100), lv_pct (100));
	lv_obj_set_style_bg_color (pOverlay, lv_color_black (), 0);
	lv_obj_set_style_bg_opa (pOverlay, LV_OPA_60, 0);
	lv_obj_add_flag (pOverlay, LV_OBJ_FLAG_CLICKABLE);
	lv_obj_add_flag (pOverlay, LV_OBJ_FLAG_IGNORE_LAYOUT);
	lv_obj_remove_flag (pOverlay, LV_OBJ_FLAG_SCROLLABLE);
	pAlert->pOverlay = pOverlay;

	lv_obj_t *pPanel = lv_obj_create (pOverlay);
	lv_obj_set_width (pPanel, lv_pct (70));
	lv_obj_set_height (pPanel, LV_SIZE_CONTENT);
	lv_obj_center (pPanel);
	lv_obj_set_flex_flow (pPanel, LV_FLEX_FLOW_COLUMN);
	lv_obj_set_style_pad_row (pPanel, 12, 0);

	if (JS_IsString (Title))
	{
		const char *s = JS_ToCString (ctx, Title);
		lv_obj_t *pLabel = lv_label_create (pPanel);
		lv_label_set_text (pLabel, s ? s : "");
		lv_obj_set_style_text_font (pLabel, &gk_montserrat_20, 0);
		if (s) JS_FreeCString (ctx, s);
	}

	lv_obj_t *pText = lv_label_create (pPanel);
	lv_label_set_text (pText, pMessage);
	lv_label_set_long_mode (pText, LV_LABEL_LONG_MODE_WRAP);
	lv_obj_set_width (pText, lv_pct (100));
	JS_FreeCString (ctx, pMessage);

	lv_obj_t *pRow = lv_obj_create (pPanel);
	lv_obj_remove_style_all (pRow);
	lv_obj_set_size (pRow, lv_pct (100), LV_SIZE_CONTENT);
	lv_obj_set_flex_flow (pRow, LV_FLEX_FLOW_ROW);
	lv_obj_set_flex_align (pRow, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
	lv_obj_set_style_pad_column (pRow, 8, 0);
	AllowRingOverflow (pRow);

	// own focus group, so Tab stays inside the alert
	pAlert->pGroup = lv_group_create ();
	lv_group_set_focus_cb (pAlert->pGroup, GkGroupFocusCallback);
	pAlert->pPrevGroup = CAppHost::Get ()->GetKeyboard ()->GetGroup ();
	lv_group_set_default (0);

	uint32_t nButtons = 0;
	if (JS_IsArray (ctx, Buttons))
	{
		JSValue Len = JS_GetPropertyStr (ctx, Buttons, "length");
		JS_ToUint32 (ctx, &nButtons, Len);
		JS_FreeValue (ctx, Len);
	}
	for (uint32_t i = 0; i < (nButtons ? nButtons : 1); i++)
	{
		const char *s = 0;
		if (nButtons)
		{
			JSValue b = JS_GetPropertyUint32 (ctx, Buttons, i);
			s = JS_ToCString (ctx, b);
			JS_FreeValue (ctx, b);
		}
		lv_obj_t *pButton = lv_button_create (pRow);
		lv_obj_t *pLabel = lv_label_create (pButton);
		lv_label_set_text (pLabel, s ? s : "OK");
		if (s) JS_FreeCString (ctx, s);
		lv_obj_add_event_cb (pButton, AlertButtonEvent, LV_EVENT_CLICKED, pAlert);
		lv_obj_add_event_cb (pButton, AlertButtonEvent, LV_EVENT_KEY, pAlert);
		lv_group_add_obj (pAlert->pGroup, pButton);
	}

	lv_group_set_default (pApp->pGroup);
	CAppHost::Get ()->GetKeyboard ()->SetGroup (pAlert->pGroup);

	pAlert->pNext = pUI->pAlerts;
	pUI->pAlerts = pAlert;

	JS_FreeValue (ctx, Title);
	JS_FreeValue (ctx, Buttons);

	return Promise;
}

static void AlertFree (TGkAlert *pAlert, boolean bResolve)
{
	TGkApp *pApp = pAlert->pApp;
	JSContext *ctx = pApp->pContext;

	if (pApp->pScreen != 0)
	{
		lv_obj_delete (pAlert->pOverlay);
	}
	lv_group_delete (pAlert->pGroup);

	if (bResolve)
	{
		JSValue Result = JS_NewInt32 (ctx, pAlert->nResult);
		JSValue r = JS_Call (ctx, pAlert->Resolve, JS_UNDEFINED, 1, &Result);
		JS_FreeValue (ctx, r);
	}
	JS_FreeValue (ctx, pAlert->Resolve);

	delete pAlert;
}

// --- module -----------------------------------------------------------------

// Text as markup that shows it as it is: & < > " ' as entities
static JSValue js_ui_escape_markup (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	size_t n;
	const char *s = JS_ToCStringLen (ctx, &n, argv[0]);	// any value, as String() would
	if (s == 0)
	{
		return JS_EXCEPTION;
	}
	CString Out;
	for (size_t i = 0; i < n; i++)
	{
		switch (s[i])
		{
		case '&':	Out.Append ("&amp;");	break;
		case '<':	Out.Append ("&lt;");	break;
		case '>':	Out.Append ("&gt;");	break;
		case '"':	Out.Append ("&quot;");	break;
		case '\'':	Out.Append ("&apos;");	break;
		default:	Out.Append (s[i]);	break;
		}
	}
	JS_FreeCString (ctx, s);
	return JS_NewStringLen (ctx, Out, Out.GetLength ());
}

static JSValue js_ui_on_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	JSValueConst Func = argc > 0 ? argv[0] : JS_UNDEFINED;

	if (!JS_IsFunction (ctx, Func) && !JS_IsNull (Func) && !JS_IsUndefined (Func))
	{
		return JS_ThrowTypeError (ctx, "onKey: function or null expected");
	}

	JS_FreeValue (ctx, pApp->KeyHandler);
	pApp->KeyHandler = JS_IsFunction (ctx, Func) ? JS_DupValue (ctx, Func) : JS_UNDEFINED;

	return JS_UNDEFINED;
}

// GapKeep's theme = LVGL's default theme plus a clearly visible focus ring
// in the secondary color, applied on top as a child theme.
static lv_theme_t s_FocusTheme;

static void FocusThemeApply (lv_theme_t *pTheme, lv_obj_t *pObj)
{
	lv_obj_add_style (pObj, &s_FocusStyle, LV_STATE_FOCUS_KEY);
}

static void ApplyTheme (boolean bDark, lv_color_t Primary, lv_color_t Secondary)
{
	lv_display_t *pDisplay = lv_display_get_default ();
	lv_theme_t *pBase = lv_theme_default_init (pDisplay, Primary, Secondary, bDark, &gk_montserrat_16);

	static boolean bStyleInit = FALSE;
	if (!bStyleInit)
	{
		lv_style_init (&s_FocusStyle);
		bStyleInit = TRUE;
	}
	lv_style_set_outline_color (&s_FocusStyle, Secondary);
	lv_style_set_outline_width (&s_FocusStyle, RingWidth);
	lv_style_set_outline_pad (&s_FocusStyle, RingGap);
	lv_style_set_outline_opa (&s_FocusStyle, LV_OPA_COVER);

	s_FocusTheme = *pBase;
	lv_theme_set_parent (&s_FocusTheme, pBase);
	lv_theme_set_apply_cb (&s_FocusTheme, FocusThemeApply);

	lv_display_set_theme (pDisplay, &s_FocusTheme);
}

void GkGroupFocusCallback (lv_group_t *pGroup)
{
	lv_obj_t *pObj = lv_group_get_focused (pGroup);
	if (pObj != 0)
	{
		lv_obj_add_state (pObj, LV_STATE_FOCUS_KEY);
	}
}

void GkUIApplyDefaultTheme (void)
{
	ApplyTheme (TRUE, lv_palette_main (LV_PALETTE_TEAL), lv_palette_main (LV_PALETTE_AMBER));
}

// ui.theme({dark, primary, secondary})
static JSValue js_ui_theme (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValueConst Opt = argc > 0 ? argv[0] : JS_UNDEFINED;
	if (!JS_IsObject (Opt))
	{
		return JS_ThrowTypeError (ctx, "theme: options object expected");
	}

	boolean bDark = TRUE;
	lv_color_t Primary = lv_palette_main (LV_PALETTE_TEAL);
	lv_color_t Secondary = lv_palette_main (LV_PALETTE_AMBER);

	JSValue v = JS_GetPropertyStr (ctx, Opt, "dark");
	int nRes = JS_IsUndefined (v) ? 0 : ToBool (ctx, v, "dark", &bDark);
	JS_FreeValue (ctx, v);
	if (nRes == 0)
	{
		v = JS_GetPropertyStr (ctx, Opt, "primary");
		nRes = JS_IsUndefined (v) ? 0 : ToColor (ctx, v, "primary", &Primary);
		JS_FreeValue (ctx, v);
	}
	if (nRes == 0)
	{
		v = JS_GetPropertyStr (ctx, Opt, "secondary");
		nRes = JS_IsUndefined (v) ? 0 : ToColor (ctx, v, "secondary", &Secondary);
		JS_FreeValue (ctx, v);
	}
	if (nRes)
	{
		return JS_EXCEPTION;
	}

	ApplyTheme (bDark, Primary, Secondary);

	return JS_UNDEFINED;
}

static const struct { const char *pName; const char *pSymbol; } Symbols[] =
{
	// keep in sync with SYMBOLS in tools/bundle_apps.py
	{"audio", LV_SYMBOL_AUDIO}, {"video", LV_SYMBOL_VIDEO}, {"list", LV_SYMBOL_LIST},
	{"ok", LV_SYMBOL_OK}, {"close", LV_SYMBOL_CLOSE}, {"power", LV_SYMBOL_POWER},
	{"settings", LV_SYMBOL_SETTINGS}, {"home", LV_SYMBOL_HOME}, {"download", LV_SYMBOL_DOWNLOAD},
	{"drive", LV_SYMBOL_DRIVE}, {"refresh", LV_SYMBOL_REFRESH}, {"mute", LV_SYMBOL_MUTE},
	{"volume-mid", LV_SYMBOL_VOLUME_MID}, {"volume-max", LV_SYMBOL_VOLUME_MAX},
	{"image", LV_SYMBOL_IMAGE}, {"tint", LV_SYMBOL_TINT}, {"prev", LV_SYMBOL_PREV},
	{"play", LV_SYMBOL_PLAY}, {"pause", LV_SYMBOL_PAUSE}, {"stop", LV_SYMBOL_STOP},
	{"next", LV_SYMBOL_NEXT}, {"eject", LV_SYMBOL_EJECT}, {"left", LV_SYMBOL_LEFT},
	{"right", LV_SYMBOL_RIGHT}, {"plus", LV_SYMBOL_PLUS}, {"minus", LV_SYMBOL_MINUS},
	{"eye-open", LV_SYMBOL_EYE_OPEN}, {"eye-close", LV_SYMBOL_EYE_CLOSE},
	{"warning", LV_SYMBOL_WARNING}, {"shuffle", LV_SYMBOL_SHUFFLE}, {"up", LV_SYMBOL_UP},
	{"down", LV_SYMBOL_DOWN}, {"loop", LV_SYMBOL_LOOP}, {"directory", LV_SYMBOL_DIRECTORY},
	{"upload", LV_SYMBOL_UPLOAD}, {"call", LV_SYMBOL_CALL}, {"cut", LV_SYMBOL_CUT},
	{"copy", LV_SYMBOL_COPY}, {"save", LV_SYMBOL_SAVE}, {"bars", LV_SYMBOL_BARS},
	{"envelope", LV_SYMBOL_ENVELOPE}, {"charge", LV_SYMBOL_CHARGE}, {"paste", LV_SYMBOL_PASTE},
	{"bell", LV_SYMBOL_BELL}, {"keyboard", LV_SYMBOL_KEYBOARD}, {"gps", LV_SYMBOL_GPS},
	{"file", LV_SYMBOL_FILE}, {"wifi", LV_SYMBOL_WIFI}, {"battery-full", LV_SYMBOL_BATTERY_FULL},
	{"battery-3", LV_SYMBOL_BATTERY_3}, {"battery-2", LV_SYMBOL_BATTERY_2},
	{"battery-1", LV_SYMBOL_BATTERY_1}, {"battery-empty", LV_SYMBOL_BATTERY_EMPTY},
	{"usb", LV_SYMBOL_USB}, {"bluetooth", LV_SYMBOL_BLUETOOTH}, {"trash", LV_SYMBOL_TRASH},
	{"edit", LV_SYMBOL_EDIT}, {"backspace", LV_SYMBOL_BACKSPACE}, {"sd-card", LV_SYMBOL_SD_CARD},
	{"new-line", LV_SYMBOL_NEW_LINE},
};

const char *GkSymbolByName (const char *pName)
{
	for (unsigned i = 0; i < sizeof Symbols / sizeof Symbols[0]; i++)
	{
		if (strcmp (Symbols[i].pName, pName) == 0)
		{
			return Symbols[i].pSymbol;
		}
	}

	return 0;
}

// --- ui.epaper -----------------------------------------------------------------
//
// The e-paper panel gapkeep.txt configures, as a second display, off screen
// (epaper.h): ui.epaper.open() gives its screen, a Container with
// refresh(), close(), colors and model; widgets go on it as on any other.

static boolean EPaperAllowed (JSContext *ctx, const char *pFunction)
{
	if (!(CAppHost::GetApp (ctx)->pBundle->permissions & GK_PERM_EPAPER))
	{
		JS_ThrowTypeError (ctx, "ui.epaper.%s needs \"permissions\": [\"epaper\"] in manifest.json", pFunction);
		return FALSE;
	}
	return TRUE;
}

static JSValue EPaperColors (JSContext *ctx, const TGkEPDModel *pModel)
{
	JSValue Colors = JS_NewArray (ctx);
	JS_SetPropertyUint32 (ctx, Colors, 0, JS_NewString (ctx, "black"));
	JS_SetPropertyUint32 (ctx, Colors, 1, JS_NewString (ctx, "white"));
	if (pModel->bRed)
	{
		JS_SetPropertyUint32 (ctx, Colors, 2, JS_NewString (ctx, "red"));
	}
	return Colors;
}

static JSValue ThrowError (JSContext *ctx, const char *pMessage)
{
	JSValue Error = JS_NewError (ctx);
	JS_DefinePropertyValueStr (ctx, Error, "message", JS_NewString (ctx, pMessage),
				   JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	return JS_Throw (ctx, Error);
}

// ui.epaper.info(): the configured panel, as open() would give it, or null
static JSValue js_epaper_info (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!EPaperAllowed (ctx, "info"))
	{
		return JS_EXCEPTION;
	}
	const TGkSPIDevice *pPanel = CGkEPD::GetPanel ();
	if (pPanel == 0 || !GkSPIControllerPresent ())
	{
		return JS_NULL;
	}
	const TGkEPDModel *pModel = pPanel->pModel;
	boolean bTurned = pModel->nLandscape & 1;
	JSValue Info = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Info, "model", JS_NewString (ctx, pModel->pModule));
	JS_SetPropertyStr (ctx, Info, "width", JS_NewInt32 (ctx, bTurned ? pModel->nHeight : pModel->nWidth));
	JS_SetPropertyStr (ctx, Info, "height", JS_NewInt32 (ctx, bTurned ? pModel->nWidth : pModel->nHeight));
	JS_SetPropertyStr (ctx, Info, "colors", EPaperColors (ctx, pModel));
	return Info;
}

// ui.epaper.open({ orientation, flip })
static JSValue js_epaper_open (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!EPaperAllowed (ctx, "open"))
	{
		return JS_EXCEPTION;
	}
	TGkApp *pApp = CAppHost::GetApp (ctx);
	TGkUIState *pUI = pApp->pUI;

	boolean bPortrait = FALSE, bFlip = FALSE;
	JSValueConst Options = argc > 0 ? argv[0] : JS_UNDEFINED;
	if (!JS_IsUndefined (Options))
	{
		if (!JS_IsObject (Options))
		{
			return JS_ThrowTypeError (ctx, "ui.epaper.open: options must be an object ({ orientation, flip })");
		}
		JSPropertyEnum *pProps;
		uint32_t nProps;
		if (JS_GetOwnPropertyNames (ctx, &pProps, &nProps, Options, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
		{
			return JS_EXCEPTION;
		}
		int nError = 0;
		for (uint32_t i = 0; i < nProps && nError == 0; i++)
		{
			const char *pName = JS_AtomToCString (ctx, pProps[i].atom);
			JSValue v = JS_GetProperty (ctx, Options, pProps[i].atom);
			if (pName == 0 || JS_IsException (v))
			{
				nError = -1;
			}
			else if (strcmp (pName, "orientation") == 0)
			{
				const char *p = JS_IsString (v) ? JS_ToCString (ctx, v) : 0;
				if (p != 0 && (strcmp (p, "landscape") == 0 || strcmp (p, "portrait") == 0))
				{
					bPortrait = p[0] == 'p';
				}
				else
				{
					JS_ThrowTypeError (ctx, "ui.epaper.open: orientation: \"landscape\" or \"portrait\" expected");
					nError = -1;
				}
				JS_FreeCString (ctx, p);
			}
			else if (strcmp (pName, "flip") == 0)
			{
				nError = ToBool (ctx, v, "flip", &bFlip);
			}
			else
			{
				JS_ThrowTypeError (ctx, "ui.epaper.open: unknown option \"%s\"", pName);
				nError = -1;
			}
			JS_FreeCString (ctx, pName);
			JS_FreeValue (ctx, v);
		}
		for (uint32_t i = 0; i < nProps; i++)
		{
			JS_FreeAtom (ctx, pProps[i].atom);
		}
		js_free (ctx, pProps);
		if (nError)
		{
			return JS_EXCEPTION;
		}
	}

	if (pUI->pEPaper != 0 && !pUI->bEPaperClose)
	{
		return JS_ThrowTypeError (ctx, "ui.epaper.open: the panel is open already (close() it first)");
	}
	if (CheckUIMemory (ctx, 0))
	{
		return JS_EXCEPTION;
	}
	if (pUI->pEPaper != 0)
	{
		delete pUI->pEPaper;		// closed, not yet deleted: now
		pUI->pEPaper = 0;
		pUI->bEPaperClose = FALSE;
	}

	// landscape: the model's own rotation for it; portrait: a quarter turn
	// from that (0 or 1); flip: a half turn more
	unsigned nRotation = ((CGkEPaperDisplay::Landscape () ^ (bPortrait ? 1 : 0)) + (bFlip ? 2 : 0)) & 3;
	const char *pError = 0;
	CGkEPaperDisplay *pEPaper = CGkEPaperDisplay::Open (nRotation, &pError);
	if (pEPaper == 0)
	{
		return ThrowError (ctx, pError);
	}
	pUI->pEPaper = pEPaper;

	lv_obj_t *pScreen = pEPaper->GetScreen ();
	lv_obj_set_flex_flow (pScreen, LV_FLEX_FLOW_COLUMN);
	lv_obj_set_style_pad_all (pScreen, 4, 0);
	lv_obj_set_style_pad_row (pScreen, 4, 0);
	lv_obj_set_style_pad_column (pScreen, 4, 0);
	return Wrap (ctx, pScreen, WContainer, pUI->EPaperProto);
}

// this: the open panel's screen; 0 (TypeError thrown) if not
static CGkEPaperDisplay *GetEPaper (JSContext *ctx, JSValueConst this_val)
{
	TGkNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0)
	{
		return 0;
	}
	TGkUIState *pUI = pNode->pApp->pUI;
	if (pUI->pEPaper == 0 || pUI->bEPaperClose || pNode->pObj != pUI->pEPaper->GetScreen ())
	{
		JS_ThrowTypeError (ctx, "not an open e-paper panel");
		return 0;
	}
	return pUI->pEPaper;
}

// panel.refresh({ onProgress })
static JSValue js_epaper_refresh (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CGkEPaperDisplay *pEPaper = GetEPaper (ctx, this_val);
	if (pEPaper == 0)
	{
		return JS_EXCEPTION;
	}
	JSValue OnProgress;
	if (!GkJobOnProgress (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "refresh", &OnProgress))
	{
		return JS_EXCEPTION;
	}
	JSValue Promise = pEPaper->Refresh (ctx, OnProgress);
	JS_FreeValue (ctx, OnProgress);
	return Promise;
}

// panel.close(), panel.delete(): the display goes, with its widgets, after
// the handler that called it (GkUIProcessDeferred). A refresh already asked
// for goes on: it has its picture.
static JSValue js_epaper_close (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkNode *pNode = GetNode (ctx, this_val, FALSE);
	if (pNode == 0)
	{
		return JS_EXCEPTION;
	}
	TGkUIState *pUI = pNode->pApp->pUI;
	if (   pNode->pObj == 0 || pNode->bDeleting || pUI->pEPaper == 0
	    || pNode->pObj != pUI->pEPaper->GetScreen ())
	{
		return JS_UNDEFINED;		// closed already
	}
	pNode->bDeleting = TRUE;		// (any use throws from now on)
	pUI->bEPaperClose = TRUE;
	return JS_UNDEFINED;
}

static JSValue js_epaper_get_colors (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CGkEPaperDisplay *pEPaper = GetEPaper (ctx, this_val);
	return pEPaper != 0 ? EPaperColors (ctx, pEPaper->GetModel ()) : JS_EXCEPTION;
}

static JSValue js_epaper_get_model (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CGkEPaperDisplay *pEPaper = GetEPaper (ctx, this_val);
	return pEPaper != 0 ? JS_NewString (ctx, pEPaper->GetModel ()->pModule) : JS_EXCEPTION;
}

static void EPaperFree (TGkUIState *pUI)
{
	if (pUI->pEPaper != 0)
	{
		delete pUI->pEPaper;		// its widgets release their JS as they go
		pUI->pEPaper = 0;
	}
	pUI->bEPaperClose = FALSE;
}

static const char *ModuleExports[] =
{
	"Widget", "Container", "Panel", "Label", "Button", "TextArea", "Checkbox", "Switch",
	"Dropdown", "Slider", "Bar", "Table", "QRCode", "TabView", "Image", "Scanner",
	"screen", "width", "height", "fonts", "monoFonts", "symbols", "alert", "onKey", "theme",
	"escapeMarkup", "epaper"
};

static int UIModuleInit (JSContext *ctx, JSModuleDef *m)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	JSRuntime *rt = JS_GetRuntime (ctx);

	if (s_WidgetClass == 0)
	{
		JS_NewClassID (&s_WidgetClass);
	}
	if (!JS_IsRegisteredClass (rt, s_WidgetClass))
	{
		JSClassDef Def;
		memset (&Def, 0, sizeof Def);
		Def.class_name = "Widget";
		Def.finalizer = WidgetFinalizer;
		JS_NewClass (rt, s_WidgetClass, &Def);
	}

	TGkUIState *pUI = new TGkUIState;
	memset (pUI, 0, sizeof *pUI);
	pApp->pUI = pUI;

	// Widget.prototype: methods and properties common to all widgets
	JSValue Base = JS_NewObject (ctx);
	DefineMethod (ctx, Base, "set", js_widget_set, 1);
	DefineMethod (ctx, Base, "on", js_widget_on, 2);
	DefineMethod (ctx, Base, "off", js_widget_off, 1);
	DefineMethod (ctx, Base, "focus", js_widget_focus, 0);
	DefineMethod (ctx, Base, "delete", js_widget_delete, 0);
	DefineMethod (ctx, Base, "clear", js_widget_clear, 0);
	DefineMethod (ctx, Base, "scrollIntoView", js_widget_scroll_into_view, 0);
	DefineGetter (ctx, Base, "parent", js_widget_get_parent);
	DefineGetter (ctx, Base, "children", js_widget_get_children);
	DefineGetter (ctx, Base, "alive", js_widget_get_alive);
	DefineGetter (ctx, Base, "type", js_widget_get_type);
	for (unsigned i = 0; i < PropCount; i++)
	{
		if (Props[i].nTypes == ALL)
		{
			DefineAccessor (ctx, Base, Props[i].pName, i, Props[i].pGet != 0);
		}
	}
	for (unsigned i = 0; i < EvCount; i++)
	{
		if (Events[i].nTypes == ALL)
		{
			DefineAccessor (ctx, Base, Events[i].pProp, 1000 + i, TRUE);
		}
	}
	JS_SetClassProto (ctx, s_WidgetClass, JS_DupValue (ctx, Base));
	pUI->BaseProto = Base;

	JSValue BaseCtor = JS_NewCFunction2 (ctx, js_widget_base_ctor, "Widget", 0, JS_CFUNC_constructor, 0);
	JS_SetConstructor (ctx, BaseCtor, Base);
	JS_SetModuleExport (ctx, m, "Widget", BaseCtor);

	for (unsigned t = 0; t < WTypeCount; t++)
	{
		JSValue Proto = JS_NewObjectProto (ctx, Base);
		for (unsigned i = 0; i < PropCount; i++)
		{
			if (Props[i].nTypes != ALL && (Props[i].nTypes & T (t)))
			{
				DefineAccessor (ctx, Proto, Props[i].pName, i, Props[i].pGet != 0);
			}
		}
		if (t == WTable)
		{
			DefineMethod (ctx, Proto, "setCell", js_table_set_cell, 3);
			DefineMethod (ctx, Proto, "getCell", js_table_get_cell, 2);
			DefineMethod (ctx, Proto, "setColumnWidth", js_table_set_column_width, 2);
		}
		if (t == WTabView)
		{
			DefineMethod (ctx, Proto, "addTab", js_tabview_add_tab, 1);
		}
		if (t == WScanner)
		{
			DefineMethod (ctx, Proto, "start", js_scanner_start, 0);
			DefineMethod (ctx, Proto, "stop", js_scanner_stop, 0);
			DefineGetter (ctx, Proto, "scanning", js_scanner_get_scanning);
		}
		for (unsigned i = 0; i < EvCount; i++)
		{
			if (Events[i].nTypes != ALL && (Events[i].nTypes & T (t)))
			{
				DefineAccessor (ctx, Proto, Events[i].pProp, 1000 + i, TRUE);
			}
		}

		JSValue Ctor = JS_NewCFunction2 (ctx, (JSCFunction *) js_widget_ctor, TypeNames[t], 2,
						 JS_CFUNC_constructor_magic, t);
		JS_SetConstructor (ctx, Ctor, Proto);
		pUI->Protos[t] = Proto;
		JS_SetModuleExport (ctx, m, TypeNames[t], Ctor);
	}

	// the app's screen, laid out as a column by default
	lv_obj_set_flex_flow (pApp->pScreen, LV_FLEX_FLOW_COLUMN);
	lv_obj_set_style_pad_all (pApp->pScreen, 16, 0);
	lv_obj_set_style_pad_row (pApp->pScreen, 12, 0);
	JS_SetModuleExport (ctx, m, "screen", Wrap (ctx, pApp->pScreen, WContainer, Base));

	lv_display_t *pDisplay = lv_display_get_default ();
	JS_SetModuleExport (ctx, m, "width", JS_NewInt32 (ctx, lv_display_get_horizontal_resolution (pDisplay)));
	JS_SetModuleExport (ctx, m, "height", JS_NewInt32 (ctx, lv_display_get_vertical_resolution (pDisplay)));

	JSValue FontList = JS_NewArray (ctx);
	for (unsigned i = 0; i < FontCount; i++)
	{
		JS_SetPropertyUint32 (ctx, FontList, i, JS_NewInt32 (ctx, FontSizes[i]));
	}
	JS_SetModuleExport (ctx, m, "fonts", FontList);
	JSValue MonoList = JS_NewArray (ctx);
	for (unsigned i = 0; i < MonoCount; i++)
	{
		JS_SetPropertyUint32 (ctx, MonoList, i, JS_NewInt32 (ctx, MonoSizes[i]));
	}
	JS_SetModuleExport (ctx, m, "monoFonts", MonoList);

	JSValue SymbolObj = JS_NewObject (ctx);
	for (unsigned i = 0; i < sizeof Symbols / sizeof Symbols[0]; i++)
	{
		JS_SetPropertyStr (ctx, SymbolObj, Symbols[i].pName, JS_NewString (ctx, Symbols[i].pSymbol));
	}
	JS_SetModuleExport (ctx, m, "symbols", SymbolObj);

	JS_SetModuleExport (ctx, m, "alert", JS_NewCFunction (ctx, js_ui_alert, "alert", 2));
	JS_SetModuleExport (ctx, m, "onKey", JS_NewCFunction (ctx, js_ui_on_key, "onKey", 1));
	JS_SetModuleExport (ctx, m, "escapeMarkup", JS_NewCFunction (ctx, js_ui_escape_markup, "escapeMarkup", 1));
	JS_SetModuleExport (ctx, m, "theme", JS_NewCFunction (ctx, js_ui_theme, "theme", 1));

	// ui.epaper, and its panels' prototype: a Container's, and more
	JSValue EPaper = JS_NewObject (ctx);
	DefineMethod (ctx, EPaper, "open", js_epaper_open, 1);
	DefineMethod (ctx, EPaper, "info", js_epaper_info, 0);
	JS_SetModuleExport (ctx, m, "epaper", EPaper);
	pUI->EPaperProto = JS_NewObjectProto (ctx, pUI->Protos[WContainer]);
	DefineMethod (ctx, pUI->EPaperProto, "refresh", js_epaper_refresh, 1);
	DefineMethod (ctx, pUI->EPaperProto, "close", js_epaper_close, 0);
	DefineMethod (ctx, pUI->EPaperProto, "delete", js_epaper_close, 0);
	DefineGetter (ctx, pUI->EPaperProto, "colors", js_epaper_get_colors);
	DefineGetter (ctx, pUI->EPaperProto, "model", js_epaper_get_model);

	return 0;
}

JSModuleDef *GkInitUIModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, UIModuleInit);
	if (m == 0)
	{
		return 0;
	}

	for (unsigned i = 0; i < sizeof ModuleExports / sizeof ModuleExports[0]; i++)
	{
		JS_AddModuleExport (ctx, m, ModuleExports[i]);
	}

	return m;
}

// --- host hooks -------------------------------------------------------------

boolean GkUIDispatchKey (TGkApp *pApp, const TGkKey &rKey)
{
	if (   JS_IsUndefined (pApp->KeyHandler)
	    || (pApp->pUI != 0 && pApp->pUI->pAlerts != 0))	// alerts get keys first
	{
		return FALSE;
	}

	JSContext *ctx = pApp->pContext;
	JSValue Ev = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Ev, "key", JS_NewString (ctx, rKey.Name));
	JS_SetPropertyStr (ctx, Ev, "shift", JS_NewBool (ctx, rKey.nMods & GK_MOD_SHIFT));
	JS_SetPropertyStr (ctx, Ev, "ctrl", JS_NewBool (ctx, rKey.nMods & GK_MOD_CTRL));
	JS_SetPropertyStr (ctx, Ev, "alt", JS_NewBool (ctx, rKey.nMods & GK_MOD_ALT));
	JS_SetPropertyStr (ctx, Ev, "repeat", JS_NewBool (ctx, rKey.bRepeat));

	JSValue Result = CAppHost::Get ()->Call (pApp->KeyHandler, JS_UNDEFINED, 1, &Ev);
	boolean bConsumed = !JS_IsException (Result) && JS_ToBool (ctx, Result) > 0;
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Ev);

	return bConsumed;
}

void GkUIProcessDeferred (TGkApp *pApp)
{
	JSContext *ctx = pApp->pContext;

	while (pApp->pDeferredDelete != 0)
	{
		TGkNode *pNode = pApp->pDeferredDelete;
		pApp->pDeferredDelete = pNode->pNextDeferred;

		if (pNode->pObj != 0)
		{
			lv_obj_delete (pNode->pObj);	// may delete other queued nodes' objects too
		}

		JSValue Ref = pNode->DeferredRef;
		pNode->DeferredRef = JS_UNDEFINED;
		JS_FreeValue (ctx, Ref);		// may free the node
	}

	TGkUIState *pUI = pApp->pUI;
	if (pUI == 0)
	{
		return;
	}

	if (pUI->bEPaperClose)
	{
		EPaperFree (pUI);	// panel.close()
	}

	// close alerts that were answered, innermost first
	for (TGkAlert **pp = &pUI->pAlerts; *pp != 0; )
	{
		TGkAlert *pAlert = *pp;
		if (!pAlert->bClosing)
		{
			pp = &pAlert->pNext;
			continue;
		}

		*pp = pAlert->pNext;
		CAppHost::Get ()->GetKeyboard ()->SetGroup (
			pUI->pAlerts != 0 ? pUI->pAlerts->pGroup : pAlert->pPrevGroup);
		AlertFree (pAlert, TRUE);
	}
}

void GkUIAppStopping (TGkApp *pApp)
{
	JSContext *ctx = pApp->pContext;

	JS_FreeValue (ctx, pApp->KeyHandler);
	pApp->KeyHandler = JS_UNDEFINED;

	TGkUIState *pUI = pApp->pUI;
	if (pUI == 0)
	{
		return;
	}

	pUI->bStopping = TRUE;

	while (pUI->pAlerts != 0)
	{
		TGkAlert *pAlert = pUI->pAlerts;
		pUI->pAlerts = pAlert->pNext;
		AlertFree (pAlert, FALSE);
	}

	EPaperFree (pUI);		// while its widgets' JS can be released

	for (unsigned t = 0; t < WTypeCount; t++)
	{
		JS_FreeValue (ctx, pUI->Protos[t]);
	}
	JS_FreeValue (ctx, pUI->BaseProto);
	JS_FreeValue (ctx, pUI->EPaperProto);

	// pUI itself stays until the screen is deleted (NodeEventCallback checks
	// bStopping); the host frees it after the screen with GkUIFree().
}

void GkUIFree (TGkApp *pApp)
{
	delete pApp->pUI;
	pApp->pUI = 0;
}
