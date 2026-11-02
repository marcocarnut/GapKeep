//
// js_ui.cpp
//
// The "zg:ui" module: a small, generic JavaScript widget API on top of LVGL.
// See docs/API.md for the JavaScript-side documentation; keep the two in sync.
//
// Design
// ------
// Every widget is a JS object of class "Widget" whose opaque pointer is a
// TZgNode. The node links the JS object to its LVGL object:
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
#include <lvgl/lvgl/src/themes/lv_theme_private.h>
#include <lvgl/lvgl/src/libs/qrcode/qrcodegen.h>
#include <lvgl/lvgl/src/misc/cache/instance/lv_image_cache.h>
#include <circle/logger.h>
#include <circle/util.h>
#include <circle/string.h>
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
	WTypeCount
};

static const char *TypeNames[WTypeCount] =
{
	"Container", "Panel", "Label", "Button", "TextArea", "Checkbox", "Switch",
	"Dropdown", "Slider", "Bar", "Table", "QRCode", "TabView"
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
	EvCount
};

static const struct
{
	const char *pName;		// for widget.on()
	const char *pProp;		// constructor / set() property
	lv_event_code_t Code;
}
Events[EvCount] =
{
	{"click",     "onClick",     LV_EVENT_CLICKED},
	{"change",    "onChange",    LV_EVENT_VALUE_CHANGED},
	{"submit",    "onSubmit",    LV_EVENT_READY},
	{"focus",     "onFocus",     LV_EVENT_FOCUSED},
	{"blur",      "onBlur",      LV_EVENT_DEFOCUSED},
	{"longpress", "onLongPress", LV_EVENT_LONG_PRESSED},
	{"key",       "onKey",       LV_EVENT_KEY},
};

struct TZgNode
{
	lv_obj_t *pObj;			// 0 once LVGL deleted the object
	TZgApp *pApp;
	TWidgetType Type;
	JSValue Wrapper;		// strong while pObj != 0
	JSValue Handlers[EvCount];
	u32 nRegistered;		// event slots with an LVGL callback
	boolean bDeleting;		// widget.delete() called
	JSValue DeferredRef;		// keeps the wrapper alive while queued
	TZgNode *pNextDeferred;
	char *pAccepted;		// TextArea accepted chars (LVGL keeps the pointer)
	struct TZgQR *pQR;		// QRCode settings
};

struct TZgQR
{
	u8 *pData;			// content (copy)
	size_t nLength;
	boolean bBinary;		// bytes (Uint8Array) rather than text
	int nECC;			// qrcodegen_Ecc
	int32_t nSize;			// px
	lv_color_t Dark, Light;
	int nModules;			// side length of the current symbol, 0: none
};

struct TZgAlert;

struct TZgUIState
{
	JSValue Protos[WTypeCount];
	JSValue BaseProto;
	boolean bStopping;
	TZgAlert *pAlerts;		// open alerts, innermost first
};

struct TZgAlert
{
	TZgAlert *pNext;
	TZgApp *pApp;
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
	TZgNode *pNode = (TZgNode *) lv_obj_get_user_data (pObj);
	if (pNode != 0)
	{
		return JS_DupValue (ctx, pNode->Wrapper);
	}

	TZgApp *pApp = CAppHost::GetApp (ctx);

	JSValue Obj = JS_NewObjectProtoClass (ctx,
		JS_IsUndefined (Proto) ? pApp->pUI->Protos[Type] : Proto, s_WidgetClass);
	if (JS_IsException (Obj))
	{
		return Obj;
	}

	pNode = new TZgNode;
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
		pNode->pQR = new TZgQR;
		memset (pNode->pQR, 0, sizeof *pNode->pQR);
		pNode->pQR->nECC = qrcodegen_Ecc_MEDIUM;
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
		{&lv_label_class, WLabel}, {&lv_button_class, WButton},
		{&lv_textarea_class, WTextArea}, {&lv_checkbox_class, WCheckbox},
		{&lv_switch_class, WSwitch}, {&lv_dropdown_class, WDropdown},
		{&lv_slider_class, WSlider}, {&lv_bar_class, WBar},
		{&lv_table_class, WTable}, {&lv_qrcode_class, WQRCode},
		{&lv_tabview_class, WTabView},
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

static TZgNode *GetNode (JSContext *ctx, JSValueConst Val, boolean bMustBeAlive = TRUE)
{
	TZgNode *pNode = (TZgNode *) JS_GetOpaque (Val, s_WidgetClass);
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
	TZgNode *pNode = (TZgNode *) JS_GetOpaque (Val, s_WidgetClass);
	if (pNode == 0)
	{
		return;
	}

	// only reachable once the LVGL object is gone (it holds a reference)
	assert (pNode->pObj == 0);
	delete [] pNode->pAccepted;
	if (pNode->pQR != 0)
	{
		delete [] pNode->pQR->pData;
		delete pNode->pQR;
	}
	delete pNode;
}

static void NodeDeleteCallback (lv_event_t *e)
{
	TZgNode *pNode = (TZgNode *) lv_event_get_user_data (e);
	JSContext *ctx = pNode->pApp->pContext;

	lv_obj_set_user_data (pNode->pObj, 0);
	pNode->pObj = 0;

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
	default:
		pBuf[0] = (char) nKey;
		pBuf[1] = '\0';
		return pBuf;
	}
}

static JSValue GetValueProp (JSContext *ctx, TZgNode *pNode);

static void NodeEventCallback (lv_event_t *e)
{
	TZgNode *pNode = (TZgNode *) lv_event_get_user_data (e);
	TZgApp *pApp = pNode->pApp;
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
			char Buf[2];
			JS_SetPropertyStr (ctx, Ev, "key", JS_NewString (ctx, KeyName (lv_event_get_key (e), Buf)));
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

static int SetHandler (JSContext *ctx, TZgNode *pNode, unsigned nSlot, JSValueConst Func)
{
	if (!JS_IsFunction (ctx, Func) && !JS_IsNull (Func) && !JS_IsUndefined (Func))
	{
		JS_ThrowTypeError (ctx, "%s: function or null expected", Events[nSlot].pProp);
		return -1;
	}

	JS_FreeValue (ctx, pNode->Handlers[nSlot]);
	pNode->Handlers[nSlot] = JS_IsFunction (ctx, Func) ? JS_DupValue (ctx, Func) : JS_UNDEFINED;

	if (   JS_IsFunction (ctx, Func)
	    && !(pNode->nRegistered & (1u << nSlot)))
	{
		lv_obj_add_event_cb (pNode->pObj, NodeEventCallback, Events[nSlot].Code, pNode);
		pNode->nRegistered |= 1u << nSlot;
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
	&lv_font_montserrat_12, &lv_font_montserrat_14, &lv_font_montserrat_16,
	&lv_font_montserrat_18, &lv_font_montserrat_20, &lv_font_montserrat_22,
	&lv_font_montserrat_24, &lv_font_montserrat_28, &lv_font_montserrat_32,
	&lv_font_montserrat_40
};
static const unsigned FontCount = sizeof FontSizes / sizeof FontSizes[0];

// --- properties -------------------------------------------------------------

typedef int TSetter (JSContext *ctx, TZgNode *pNode, JSValueConst v, const char *pProp);
typedef JSValue TGetter (JSContext *ctx, TZgNode *pNode);

#define SETTER(name)	static int name (JSContext *ctx, TZgNode *pNode, JSValueConst v, const char *pProp)
#define GETTER(name)	static JSValue name (JSContext *ctx, TZgNode *pNode)
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

SETTER (SetFont)
{
	int32_t n;
	if (JS_IsNumber (v) && ToInt (ctx, v, pProp, &n) == 0)
	{
		for (unsigned i = 0; i < FontCount; i++)
		{
			if (FontSizes[i] == n)
			{
				lv_obj_set_style_text_font (OBJ, Fonts[i], 0);
				return 0;
			}
		}
	}
	JS_ThrowTypeError (ctx, "%s: one of the sizes in ui.fonts expected (12 14 16 18 20 22 24 28 32 40)", pProp);
	return -1;
}

SETTER (SetTextAlign)
{
	static const char *const Names[] = {"left", "center", "right"};
	static const int Values[] = {LV_TEXT_ALIGN_LEFT, LV_TEXT_ALIGN_CENTER, LV_TEXT_ALIGN_RIGHT};
	int n;
	if (ToEnum (ctx, v, pProp, Names, Values, 3, &n)) return -1;
	lv_obj_set_style_text_align (OBJ, (lv_text_align_t) n, 0);
	return 0;
}

static int SetFlag (JSContext *ctx, TZgNode *pNode, JSValueConst v, const char *pProp, lv_obj_flag_t Flag, boolean bInvert)
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
SETTER (SetScrollable) { return SetFlag (ctx, pNode, v, pProp, LV_OBJ_FLAG_SCROLLABLE, FALSE); }
SETTER (SetClickable)  { return SetFlag (ctx, pNode, v, pProp, LV_OBJ_FLAG_CLICKABLE, FALSE); }
GETTER (GetHidden)     { return JS_NewBool (ctx, lv_obj_has_flag (OBJ, LV_OBJ_FLAG_HIDDEN)); }

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
	case WLabel:	s = lv_label_get_text (OBJ);		break;
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
	lv_label_set_long_mode (OBJ, (lv_label_long_mode_t) n);
	return 0;
}

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
SETTER (SetRows) { int32_t n; if (ToInt (ctx, v, pProp, &n)) return -1; lv_table_set_row_count (OBJ, n > 0 ? n : 0); return 0; }
SETTER (SetCols) { int32_t n; if (ToInt (ctx, v, pProp, &n)) return -1; lv_table_set_column_count (OBJ, n > 0 ? n : 0); return 0; }
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
	}

	lv_table_set_row_count (OBJ, nRows);
	lv_table_set_column_count (OBJ, nCols);

	for (uint32_t r = 0; r < nRows; r++)
	{
		JSValue Row = JS_GetPropertyUint32 (ctx, v, r);
		for (uint32_t c = 0; c < nCols; c++)
		{
			JSValue Cell = JS_GetPropertyUint32 (ctx, Row, c);
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

static int QRRender (JSContext *ctx, TZgNode *pNode)
{
	TZgQR *pQR = pNode->pQR;
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
						      qrcodegen_VERSION_MIN, qrcodegen_VERSION_MAX,
						      qrcodegen_Mask_AUTO, false);
		}
	}
	else
	{
		bOK = qrcodegen_encodeText ((const char *) pQR->pData, pTemp, pCode, (qrcodegen_Ecc) pQR->nECC,
					    qrcodegen_VERSION_MIN, qrcodegen_VERSION_MAX,
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

SETTER (SetQRData)
{
	TZgQR *pQR = pNode->pQR;
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
	TZgQR Old = *pQR;
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
static int QRChange (JSContext *ctx, TZgNode *pNode, const TZgQR &rOld)
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
	TZgQR Old = *pNode->pQR;
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
	TZgQR Old = *pNode->pQR;
	pNode->pQR->nECC = n;
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
	// widget specific
	{"text",        TEXTUAL, SetText, GetText},
	{"overflow",    T (WLabel), SetOverflow, 0},
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
	{"modules",     T (WQRCode), 0, GetQRModules},
};
static const unsigned PropCount = sizeof Props / sizeof Props[0];

// the "value" carried by change events
static JSValue GetValueProp (JSContext *ctx, TZgNode *pNode)
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

static int ApplyProp (JSContext *ctx, TZgNode *pNode, const char *pName, JSValueConst v)
{
	for (unsigned i = 0; i < EvCount; i++)
	{
		if (strcmp (pName, Events[i].pProp) == 0)
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

static int ApplyProps (JSContext *ctx, TZgNode *pNode, JSValueConst Obj)
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
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	if (ApplyProps (ctx, pNode, argc > 0 ? argv[0] : JS_UNDEFINED))
	{
		return JS_EXCEPTION;
	}

	return JS_DupValue (ctx, this_val);	// chainable
}

static int EventSlot (JSContext *ctx, JSValueConst Name)
{
	const char *s = JS_ToCString (ctx, Name);
	if (s != 0)
	{
		for (unsigned i = 0; i < EvCount; i++)
		{
			if (strcmp (s, Events[i].pName) == 0)
			{
				JS_FreeCString (ctx, s);
				return i;
			}
		}
		JS_FreeCString (ctx, s);
	}

	JS_ThrowTypeError (ctx, "unknown event (click, change, submit, focus, blur, longpress, key)");
	return -1;
}

static JSValue js_widget_on (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	int nSlot = EventSlot (ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
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
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	int nSlot = EventSlot (ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
	if (nSlot < 0) return JS_EXCEPTION;

	SetHandler (ctx, pNode, nSlot, JS_NULL);

	return JS_DupValue (ctx, this_val);
}

static JSValue js_widget_focus (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	lv_group_t *pGroup = (lv_group_t *) lv_obj_get_group (pNode->pObj);
	if (pGroup != 0)
	{
		lv_group_focus_obj (pNode->pObj);
	}

	return JS_UNDEFINED;
}

static void DeferDelete (JSContext *ctx, TZgNode *pNode)
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
	TZgNode *pNode = GetNode (ctx, this_val, FALSE);
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
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	for (u32 i = 0; i < lv_obj_get_child_count (pNode->pObj); i++)
	{
		lv_obj_t *pChild = lv_obj_get_child (pNode->pObj, i);
		JSValue Child = Wrap (ctx, pChild, GuessType (pChild), JS_UNDEFINED);
		if (JS_IsException (Child)) return Child;
		DeferDelete (ctx, (TZgNode *) JS_GetOpaque (Child, s_WidgetClass));
		JS_FreeValue (ctx, Child);
	}

	return JS_DupValue (ctx, this_val);
}

static JSValue js_widget_scroll_into_view (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	lv_obj_scroll_to_view_recursive (pNode->pObj, LV_ANIM_ON);

	return JS_UNDEFINED;
}

static JSValue js_widget_get_parent (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
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
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	JSValue Array = JS_NewArray (ctx);
	uint32_t n = 0;
	for (u32 i = 0; i < lv_obj_get_child_count (pNode->pObj); i++)
	{
		lv_obj_t *pChild = lv_obj_get_child (pNode->pObj, i);
		TZgNode *pChildNode = (TZgNode *) lv_obj_get_user_data (pChild);
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
	TZgNode *pNode = GetNode (ctx, this_val, FALSE);
	if (pNode == 0) return JS_EXCEPTION;

	return JS_NewBool (ctx, pNode->pObj != 0 && !pNode->bDeleting);
}

static JSValue js_widget_get_type (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val, FALSE);
	if (pNode == 0) return JS_EXCEPTION;

	return JS_NewString (ctx, TypeNames[pNode->Type]);
}

// Table methods

static int CellArgs (JSContext *ctx, TZgNode *pNode, int argc, JSValueConst *argv, uint32_t *pRow, uint32_t *pCol)
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

static JSValue js_table_set_cell (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
	uint32_t r, c;
	if (pNode == 0 || CellArgs (ctx, pNode, argc, argv, &r, &c)) return JS_EXCEPTION;

	const char *s = ToString (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "setCell");
	if (s == 0) return JS_EXCEPTION;
	lv_table_set_cell_value (pNode->pObj, r, c, s);
	JS_FreeCString (ctx, s);

	return JS_UNDEFINED;
}

static JSValue js_table_get_cell (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
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
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	uint32_t c;
	int32_t w;
	if (pNode->Type != WTable || argc < 2 || JS_ToUint32 (ctx, &c, argv[0]) || ToInt (ctx, argv[1], "width", &w))
	{
		return JS_ThrowTypeError (ctx, "setColumnWidth(column, width) expected");
	}
	lv_table_set_column_width (pNode->pObj, c, w);

	return JS_UNDEFINED;
}

// TabView method: addTab(title) -> Container (the tab's page)
static JSValue js_tabview_add_tab (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgNode *pNode = GetNode (ctx, this_val);
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
	TZgNode *pNode = GetNode (ctx, this_val);
	if (pNode == 0) return JS_EXCEPTION;

	if (magic >= 1000)
	{
		return JS_DupValue (ctx, pNode->Handlers[magic - 1000]);
	}

	return Props[magic].pGet (ctx, pNode);
}

static JSValue js_prop_set (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic)
{
	TZgNode *pNode = GetNode (ctx, this_val);
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

// --- constructors -----------------------------------------------------------

static lv_obj_t *CreateObject (TWidgetType Type, lv_obj_t *pParent)
{
	lv_obj_t *p = 0;
	switch (Type)
	{
	case WContainer:
		p = lv_obj_create (pParent);
		lv_obj_remove_style_all (p);		// plain: no background, border or padding
		lv_obj_set_size (p, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
		lv_obj_add_flag (p, LV_OBJ_FLAG_OVERFLOW_VISIBLE);	// don't clip focus rings
		break;
	case WPanel:	p = lv_obj_create (pParent);
			lv_obj_set_size (p, LV_SIZE_CONTENT, LV_SIZE_CONTENT);	break;
	case WLabel:	p = lv_label_create (pParent); lv_label_set_text (p, "");	break;
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
	default:	assert (0);
	}

	return p;
}

// new ui.Label([parent], [props])
static JSValue js_widget_ctor (JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv, int magic)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);
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
		TZgNode *pParentNode = GetNode (ctx, argv[0]);
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

	// support subclasses: class MyButton extends ui.Button { ... }
	JSValue Proto = JS_GetPropertyStr (ctx, new_target, "prototype");
	if (JS_IsException (Proto)) return Proto;

	lv_obj_t *pObj = CreateObject (Type, pParent);
	JSValue Obj = Wrap (ctx, pObj, Type, JS_IsObject (Proto) ? (JSValueConst) Proto : JS_UNDEFINED);
	JS_FreeValue (ctx, Proto);
	if (JS_IsException (Obj))
	{
		lv_obj_delete (pObj);
		return Obj;
	}

	TZgNode *pNode = (TZgNode *) JS_GetOpaque (Obj, s_WidgetClass);
	if (ApplyProps (ctx, pNode, Props))
	{
		DeferDelete (ctx, pNode);
		JS_FreeValue (ctx, Obj);
		return JS_EXCEPTION;
	}

	return Obj;
}

static JSValue js_widget_base_ctor (JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv)
{
	return JS_ThrowTypeError (ctx, "ui.Widget is abstract: use ui.Container, ui.Label, ...");
}

// --- alerts -----------------------------------------------------------------

static void AlertClose (TZgAlert *pAlert, int nResult)
{
	if (pAlert->bClosing)
	{
		return;
	}

	pAlert->bClosing = TRUE;
	pAlert->nResult = nResult;
	lv_obj_add_flag (pAlert->pOverlay, LV_OBJ_FLAG_HIDDEN);
	// resolved and deleted in ZgUIProcessDeferred, outside LVGL event processing
}

static void AlertButtonEvent (lv_event_t *e)
{
	TZgAlert *pAlert = (TZgAlert *) lv_event_get_user_data (e);
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
	TZgApp *pApp = CAppHost::GetApp (ctx);
	TZgUIState *pUI = pApp->pUI;

	const char *pMessage = ToString (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "alert");
	if (pMessage == 0) return JS_EXCEPTION;

	JSValueConst Options = argc > 1 ? argv[1] : JS_UNDEFINED;
	JSValue Title = JS_IsObject (Options) ? JS_GetPropertyStr (ctx, Options, "title") : JS_UNDEFINED;
	JSValue Buttons = JS_IsObject (Options) ? JS_GetPropertyStr (ctx, Options, "buttons") : JS_UNDEFINED;

	TZgAlert *pAlert = new TZgAlert;
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
		lv_obj_set_style_text_font (pLabel, &lv_font_montserrat_20, 0);
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
	lv_obj_add_flag (pRow, LV_OBJ_FLAG_OVERFLOW_VISIBLE);

	// own focus group, so Tab stays inside the alert
	pAlert->pGroup = lv_group_create ();
	lv_group_set_focus_cb (pAlert->pGroup, ZgGroupFocusCallback);
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

static void AlertFree (TZgAlert *pAlert, boolean bResolve)
{
	TZgApp *pApp = pAlert->pApp;
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

static JSValue js_ui_on_key (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);
	JSValueConst Func = argc > 0 ? argv[0] : JS_UNDEFINED;

	if (!JS_IsFunction (ctx, Func) && !JS_IsNull (Func) && !JS_IsUndefined (Func))
	{
		return JS_ThrowTypeError (ctx, "onKey: function or null expected");
	}

	JS_FreeValue (ctx, pApp->KeyHandler);
	pApp->KeyHandler = JS_IsFunction (ctx, Func) ? JS_DupValue (ctx, Func) : JS_UNDEFINED;

	return JS_UNDEFINED;
}

// zerogap's theme = LVGL's default theme plus a clearly visible focus ring
// in the secondary color, applied on top as a child theme.
static lv_theme_t s_FocusTheme;
static lv_style_t s_FocusStyle;

static void FocusThemeApply (lv_theme_t *pTheme, lv_obj_t *pObj)
{
	lv_obj_add_style (pObj, &s_FocusStyle, LV_STATE_FOCUS_KEY);
}

static void ApplyTheme (boolean bDark, lv_color_t Primary, lv_color_t Secondary)
{
	lv_display_t *pDisplay = lv_display_get_default ();
	lv_theme_t *pBase = lv_theme_default_init (pDisplay, Primary, Secondary, bDark, &lv_font_montserrat_16);

	static boolean bStyleInit = FALSE;
	if (!bStyleInit)
	{
		lv_style_init (&s_FocusStyle);
		bStyleInit = TRUE;
	}
	lv_style_set_outline_color (&s_FocusStyle, Secondary);
	lv_style_set_outline_width (&s_FocusStyle, 3);
	lv_style_set_outline_pad (&s_FocusStyle, 2);
	lv_style_set_outline_opa (&s_FocusStyle, LV_OPA_COVER);

	s_FocusTheme = *pBase;
	lv_theme_set_parent (&s_FocusTheme, pBase);
	lv_theme_set_apply_cb (&s_FocusTheme, FocusThemeApply);

	lv_display_set_theme (pDisplay, &s_FocusTheme);
}

void ZgGroupFocusCallback (lv_group_t *pGroup)
{
	lv_obj_t *pObj = lv_group_get_focused (pGroup);
	if (pObj != 0)
	{
		lv_obj_add_state (pObj, LV_STATE_FOCUS_KEY);
	}
}

void ZgUIApplyDefaultTheme (void)
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

static const char *ModuleExports[] =
{
	"Widget", "Container", "Panel", "Label", "Button", "TextArea", "Checkbox", "Switch",
	"Dropdown", "Slider", "Bar", "Table", "QRCode", "TabView",
	"screen", "width", "height", "fonts", "symbols", "alert", "onKey", "theme"
};

static int UIModuleInit (JSContext *ctx, JSModuleDef *m)
{
	TZgApp *pApp = CAppHost::GetApp (ctx);
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

	TZgUIState *pUI = new TZgUIState;
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
		DefineAccessor (ctx, Base, Events[i].pProp, 1000 + i, TRUE);
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

	JSValue SymbolObj = JS_NewObject (ctx);
	for (unsigned i = 0; i < sizeof Symbols / sizeof Symbols[0]; i++)
	{
		JS_SetPropertyStr (ctx, SymbolObj, Symbols[i].pName, JS_NewString (ctx, Symbols[i].pSymbol));
	}
	JS_SetModuleExport (ctx, m, "symbols", SymbolObj);

	JS_SetModuleExport (ctx, m, "alert", JS_NewCFunction (ctx, js_ui_alert, "alert", 2));
	JS_SetModuleExport (ctx, m, "onKey", JS_NewCFunction (ctx, js_ui_on_key, "onKey", 1));
	JS_SetModuleExport (ctx, m, "theme", JS_NewCFunction (ctx, js_ui_theme, "theme", 1));

	return 0;
}

JSModuleDef *ZgInitUIModule (JSContext *ctx, const char *pName)
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

boolean ZgUIDispatchKey (TZgApp *pApp, const TZgKey &rKey)
{
	if (   JS_IsUndefined (pApp->KeyHandler)
	    || (pApp->pUI != 0 && pApp->pUI->pAlerts != 0))	// alerts get keys first
	{
		return FALSE;
	}

	JSContext *ctx = pApp->pContext;
	JSValue Ev = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Ev, "key", JS_NewString (ctx, rKey.Name));
	JS_SetPropertyStr (ctx, Ev, "shift", JS_NewBool (ctx, rKey.nMods & ZG_MOD_SHIFT));
	JS_SetPropertyStr (ctx, Ev, "ctrl", JS_NewBool (ctx, rKey.nMods & ZG_MOD_CTRL));
	JS_SetPropertyStr (ctx, Ev, "alt", JS_NewBool (ctx, rKey.nMods & ZG_MOD_ALT));

	JSValue Result = CAppHost::Get ()->Call (pApp->KeyHandler, JS_UNDEFINED, 1, &Ev);
	boolean bConsumed = !JS_IsException (Result) && JS_ToBool (ctx, Result) > 0;
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Ev);

	return bConsumed;
}

void ZgUIProcessDeferred (TZgApp *pApp)
{
	JSContext *ctx = pApp->pContext;

	while (pApp->pDeferredDelete != 0)
	{
		TZgNode *pNode = pApp->pDeferredDelete;
		pApp->pDeferredDelete = pNode->pNextDeferred;

		if (pNode->pObj != 0)
		{
			lv_obj_delete (pNode->pObj);	// may delete other queued nodes' objects too
		}

		JSValue Ref = pNode->DeferredRef;
		pNode->DeferredRef = JS_UNDEFINED;
		JS_FreeValue (ctx, Ref);		// may free the node
	}

	TZgUIState *pUI = pApp->pUI;
	if (pUI == 0)
	{
		return;
	}

	// close alerts that were answered, innermost first
	for (TZgAlert **pp = &pUI->pAlerts; *pp != 0; )
	{
		TZgAlert *pAlert = *pp;
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

void ZgUIAppStopping (TZgApp *pApp)
{
	JSContext *ctx = pApp->pContext;

	JS_FreeValue (ctx, pApp->KeyHandler);
	pApp->KeyHandler = JS_UNDEFINED;

	TZgUIState *pUI = pApp->pUI;
	if (pUI == 0)
	{
		return;
	}

	pUI->bStopping = TRUE;

	while (pUI->pAlerts != 0)
	{
		TZgAlert *pAlert = pUI->pAlerts;
		pUI->pAlerts = pAlert->pNext;
		AlertFree (pAlert, FALSE);
	}

	for (unsigned t = 0; t < WTypeCount; t++)
	{
		JS_FreeValue (ctx, pUI->Protos[t]);
	}
	JS_FreeValue (ctx, pUI->BaseProto);

	// pUI itself stays until the screen is deleted (NodeEventCallback checks
	// bStopping); the host frees it after the screen with ZgUIFree().
}

void ZgUIFree (TZgApp *pApp)
{
	delete pApp->pUI;
	pApp->pUI = 0;
}
