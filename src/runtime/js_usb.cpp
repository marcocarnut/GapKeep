//
// js_usb.cpp
//
// The "gk:usb" module: control transfers to the USB devices an app's
// manifest lists ("usb": ["16c0:27db"]), claimed for it by the system
// (usb.h). See docs/API.md.
//
// Transfers are promises. Each is queued, and the main loop does one per
// pass (GkUSBUpdate, from the app host), so the screen is drawn between
// them. A transfer itself waits for the device, as Circle's control
// transfers do (on the Pi Zero's host controller they can't be
// asynchronous): at most GK_USB_TIMEOUT_MS a stage, a few milliseconds for
// a device that answers. The API is asynchronous all the same, so that it
// can stay as it is if they become so, and an app waits as it would in a
// browser (WebUSB, WebHID).
//
// Arguments are checked when the call is made (a TypeError or RangeError,
// thrown); what the device does rejects the promise, with an Error whose
// code says what: "stall", "timeout", "detached", "closed", "error".
// Data is wiped from the queue once sent; nothing of it is logged.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "usb.h"
#include "../crypto/wipe.h"
#include <circle/logger.h>
#include <circle/string.h>
#include <circle/util.h>
#include <assert.h>

static const char FromUSB[] = "usb";

static const unsigned MaxHandlers = 16;		// onAttach, onDetach: each
static const unsigned MaxHandles = GK_USB_MAX_DEVICES;
static const unsigned MaxQueued = 16;

enum TKind
{
	KindIn,			// resolves to a Uint8Array
	KindOut,		// to the number of bytes sent
	KindSetReport		// to undefined
};

struct TGkUSBRequest
{
	unsigned nHandle;		// the handle's serial
	unsigned nDevice;		// TGkUSBInfo::nID
	TKind Kind;
	u8 ucRequestType, ucRequest;
	u16 usValue, usIndex, usLength;
	u8 Data[GK_USB_MAX_TRANSFER];	// OUT
	JSValue Resolve, Reject;
};

struct TGkUSBHandle
{
	unsigned nSerial;		// 0: free
	unsigned nDevice;
};

struct TGkUSBState
{
	JSValue Handlers[2][MaxHandlers];	// [0] attach, [1] detach; JS_UNDEFINED: free
	TGkUSBHandle Handles[MaxHandles];
	unsigned nNextHandle;
	TGkUSBRequest Queue[MaxQueued];
	unsigned nQueueIn, nQueued;
};

static TGkUSBState *GetState (JSContext *ctx)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	if (pApp->pUSB == 0)
	{
		TGkUSBState *pState = new TGkUSBState;
		memset (pState, 0, sizeof *pState);
		for (unsigned k = 0; k < 2; k++)
		{
			for (unsigned i = 0; i < MaxHandlers; i++)
			{
				pState->Handlers[k][i] = JS_UNDEFINED;
			}
		}
		pState->nNextHandle = 1;
		pApp->pUSB = pState;
	}
	return pApp->pUSB;
}

static TGkUSBHandle *FindHandle (TGkUSBState *pState, unsigned nSerial)
{
	for (unsigned i = 0; nSerial != 0 && i < MaxHandles; i++)
	{
		if (pState->Handles[i].nSerial == nSerial)
		{
			return &pState->Handles[i];
		}
	}
	return 0;
}

static const char *SpeedName (TGkUSBSpeed Speed)
{
	static const char *Names[] = {"low", "full", "high", "super"};
	return Names[Speed <= GkUSBSpeedSuper ? Speed : GkUSBSpeedSuper];
}

static JSValue NewInfo (JSContext *ctx, const TGkUSBInfo &rInfo)
{
	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "id", JS_NewUint32 (ctx, rInfo.nID));
	JS_SetPropertyStr (ctx, Obj, "vid", JS_NewUint32 (ctx, rInfo.usVendor));
	JS_SetPropertyStr (ctx, Obj, "pid", JS_NewUint32 (ctx, rInfo.usProduct));
	JS_SetPropertyStr (ctx, Obj, "manufacturer", JS_NewString (ctx, rInfo.Manufacturer));
	JS_SetPropertyStr (ctx, Obj, "product", JS_NewString (ctx, rInfo.Product));
	JS_SetPropertyStr (ctx, Obj, "serial", rInfo.Serial[0] ? JS_NewString (ctx, rInfo.Serial)
								  : JS_NULL);
	JS_SetPropertyStr (ctx, Obj, "speed", JS_NewString (ctx, SpeedName (rInfo.Speed)));
	JSValue Interfaces = JS_NewArray (ctx);
	for (unsigned i = 0; i < rInfo.Config.interface_count; i++)
	{
		const gk_usb_interface_t *pIf = &rInfo.Config.interfaces[i];
		JSValue If = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, If, "number", JS_NewUint32 (ctx, pIf->number));
		JS_SetPropertyStr (ctx, If, "class", JS_NewUint32 (ctx, pIf->cls));
		JS_SetPropertyStr (ctx, If, "subclass", JS_NewUint32 (ctx, pIf->subclass));
		JS_SetPropertyStr (ctx, If, "protocol", JS_NewUint32 (ctx, pIf->protocol));
		JS_SetPropertyUint32 (ctx, Interfaces, i, If);
	}
	JS_SetPropertyStr (ctx, Obj, "interfaces", Interfaces);
	return Obj;
}

// an Error with a code, for rejections
static JSValue NewError (JSContext *ctx, const char *pCode, const char *pMessage)
{
	JSValue Error = JS_NewError (ctx);
	JS_SetPropertyStr (ctx, Error, "message", JS_NewString (ctx, pMessage));
	JS_SetPropertyStr (ctx, Error, "code", JS_NewString (ctx, pCode));
	return Error;
}

static boolean IsInterface (const TGkUSBInfo *pInfo, unsigned nNumber)
{
	for (unsigned i = 0; i < pInfo->Config.interface_count; i++)
	{
		if (pInfo->Config.interfaces[i].number == nNumber)
		{
			return TRUE;
		}
	}
	return FALSE;
}

// --- arguments ----------------------------------------------------------------

static boolean GetInt (JSContext *ctx, JSValueConst v, const char *pWhat, unsigned nMax,
		       unsigned *pValue, const char *pFunction)
{
	double f;
	if (!JS_IsNumber (v) || JS_ToFloat64 (ctx, &f, v) || f != (double) (long long) f
	    || f < 0 || f > nMax)
	{
		JS_ThrowRangeError (ctx, "%s: %s must be a whole number from 0 to %u",
				    pFunction, pWhat, nMax);
		return FALSE;
	}
	*pValue = (unsigned) f;
	return TRUE;
}

// An optional integer property of Obj (nDefault if undefined)
static boolean GetIntProp (JSContext *ctx, JSValueConst Obj, const char *pName, unsigned nMax,
			   int nDefault, unsigned *pValue, const char *pFunction)
{
	JSValue v = JS_GetPropertyStr (ctx, Obj, pName);
	boolean bOK;
	if (JS_IsUndefined (v) && nDefault >= 0)
	{
		*pValue = (unsigned) nDefault;
		bOK = TRUE;
	}
	else
	{
		CString What;
		What.Format ("setup.%s", pName);
		bOK = GetInt (ctx, v, What, nMax, pValue, pFunction);
	}
	JS_FreeValue (ctx, v);
	return bOK;
}

// A string property that must be one of pNames (0-terminated); its index
static boolean GetChoice (JSContext *ctx, JSValueConst Obj, const char *pName,
			  const char *const *pNames, unsigned *pIndex, const char *pFunction)
{
	JSValue v = JS_GetPropertyStr (ctx, Obj, pName);
	const char *p = JS_IsString (v) ? JS_ToCString (ctx, v) : 0;
	JS_FreeValue (ctx, v);
	for (unsigned i = 0; p != 0 && pNames[i] != 0; i++)
	{
		if (strcmp (p, pNames[i]) == 0)
		{
			JS_FreeCString (ctx, p);
			*pIndex = i;
			return TRUE;
		}
	}
	JS_FreeCString (ctx, p);
	CString List;
	for (unsigned i = 0; pNames[i] != 0; i++)
	{
		List.Append (i > 0 ? ", \"" : "\"");
		List.Append (pNames[i]);
		List.Append ("\"");
	}
	JS_ThrowTypeError (ctx, "%s: setup.%s must be one of %s", pFunction, pName,
			   (const char *) List);
	return FALSE;
}

// The setup object { type, recipient, request, value, index }, checked
// against the device: bmRequestType and the rest
static boolean GetSetup (JSContext *ctx, JSValueConst Setup, const TGkUSBInfo *pInfo, boolean bIn,
			 u8 *pRequestType, u8 *pRequest, u16 *pValue, u16 *pIndex,
			 const char *pFunction)
{
	static const char *const Types[] = {"standard", "class", "vendor", 0};
	static const char *const Recipients[] = {"device", "interface", 0};
	static const u8 TypeBits[] = {GK_USB_TYPE_STANDARD, GK_USB_TYPE_CLASS, GK_USB_TYPE_VENDOR};
	static const u8 RecipientBits[] = {GK_USB_TO_DEVICE, GK_USB_TO_INTERFACE};

	if (!JS_IsObject (Setup))
	{
		JS_ThrowTypeError (ctx, "%s: a setup object { type, recipient, request, value, index }"
				   " expected", pFunction);
		return FALSE;
	}
	unsigned nType, nRecipient, nRequest, nValue, nIndex;
	if (   !GetChoice (ctx, Setup, "type", Types, &nType, pFunction)
	    || !GetChoice (ctx, Setup, "recipient", Recipients, &nRecipient, pFunction)
	    || !GetIntProp (ctx, Setup, "request", 255, -1, &nRequest, pFunction)
	    || !GetIntProp (ctx, Setup, "value", 0xFFFF, 0, &nValue, pFunction)
	    || !GetIntProp (ctx, Setup, "index", 0xFFFF, 0, &nIndex, pFunction))
	{
		return FALSE;
	}

	// Standard requests change how the system talks to the device (its
	// address, configuration, interfaces, features): only the ones that
	// read are an app's. GET_STATUS, GET_DESCRIPTOR, GET_CONFIGURATION,
	// GET_INTERFACE.
	if (   TypeBits[nType] == GK_USB_TYPE_STANDARD
	    && (!bIn || !(nRequest == 0 || nRequest == 6 || nRequest == 8 || nRequest == 10)))
	{
		JS_ThrowTypeError (ctx, "%s: standard request %u is the system's: an app may only read"
				   " (GET_STATUS, GET_DESCRIPTOR, GET_CONFIGURATION, GET_INTERFACE)",
				   pFunction, nRequest);
		return FALSE;
	}
	if (   RecipientBits[nRecipient] == GK_USB_TO_INTERFACE
	    && !IsInterface (pInfo, nIndex & 0xFF))
	{
		JS_ThrowRangeError (ctx, "%s: the device has no interface %u", pFunction, nIndex & 0xFF);
		return FALSE;
	}

	*pRequestType = (bIn ? GK_USB_DIR_IN : 0) | TypeBits[nType] | RecipientBits[nRecipient];
	*pRequest = (u8) nRequest;
	*pValue = (u16) nValue;
	*pIndex = (u16) nIndex;
	return TRUE;
}

// The bytes of v (a typed array, ArrayBuffer or array of 0..255) into
// pOut, at most nMax; their number, or -1 (an exception is pending)
static int GetData (JSContext *ctx, JSValueConst v, u8 *pOut, unsigned nMax, const char *pFunction)
{
	if (JS_IsArray (ctx, v))
	{
		JSValue Length = JS_GetPropertyStr (ctx, v, "length");
		uint32_t n = 0;
		JS_ToUint32 (ctx, &n, Length);
		JS_FreeValue (ctx, Length);
		if (n > nMax)
		{
			JS_ThrowRangeError (ctx, "%s: at most %u bytes", pFunction, nMax);
			return -1;
		}
		for (uint32_t i = 0; i < n; i++)
		{
			JSValue b = JS_GetPropertyUint32 (ctx, v, i);
			unsigned nByte;
			boolean bOK = GetInt (ctx, b, "each byte", 255, &nByte, pFunction);
			JS_FreeValue (ctx, b);
			if (!bOK)
			{
				return -1;
			}
			pOut[i] = (u8) nByte;
		}
		return (int) n;
	}

	size_t nOffset, nLength, nElement;
	JSValue Buffer = JS_GetTypedArrayBuffer (ctx, v, &nOffset, &nLength, &nElement);
	const u8 *p = 0;
	if (!JS_IsException (Buffer))
	{
		size_t nSize;
		p = JS_GetArrayBuffer (ctx, &nSize, Buffer);
		p = p ? p + nOffset : 0;
	}
	else
	{
		JS_FreeValue (ctx, JS_GetException (ctx));
		Buffer = JS_UNDEFINED;
		size_t nSize = 0;
		p = JS_IsObject (v) ? JS_GetArrayBuffer (ctx, &nSize, v) : 0;
		if (p == 0)
		{
			JS_FreeValue (ctx, JS_GetException (ctx));
		}
		nLength = nSize;
	}
	int nResult = -1;
	if (p == 0)
	{
		JS_ThrowTypeError (ctx, "%s: bytes expected (a Uint8Array, an ArrayBuffer or an array)",
				   pFunction);
	}
	else if (nLength > nMax)
	{
		JS_ThrowRangeError (ctx, "%s: at most %u bytes", pFunction, nMax);
	}
	else
	{
		memcpy (pOut, p, nLength);
		nResult = (int) nLength;
	}
	JS_FreeValue (ctx, Buffer);
	return nResult;
}

// --- requests -----------------------------------------------------------------

// The handle's device, for a transfer: 0 and a TypeError if it can't have one
static const TGkUSBInfo *HandleDevice (JSContext *ctx, JSValueConst *pData, const char *pFunction,
				       unsigned *pSerial)
{
	TGkUSBState *pState = GetState (ctx);
	uint32_t nSerial = 0;
	JS_ToUint32 (ctx, &nSerial, pData[0]);
	*pSerial = nSerial;
	TGkUSBHandle *pHandle = FindHandle (pState, nSerial);
	if (pHandle == 0)
	{
		JS_ThrowTypeError (ctx, "%s: the device was closed", pFunction);
		return 0;
	}
	const TGkUSBInfo *pInfo = CGkUSB::Find (pHandle->nDevice);
	if (pInfo == 0)
	{
		JS_ThrowTypeError (ctx, "%s: the device was detached", pFunction);
		return 0;
	}
	return pInfo;
}

static JSValue Queue (JSContext *ctx, unsigned nSerial, const TGkUSBInfo *pInfo, TKind Kind,
		      u8 ucRequestType, u8 ucRequest, u16 usValue, u16 usIndex,
		      const u8 *pData, unsigned nLength, const char *pFunction)
{
	TGkUSBState *pState = GetState (ctx);
	if (pState->nQueued == MaxQueued)
	{
		CLogger::Get ()->Write (FromUSB, LogWarning, "%s: %s refused: %u transfers waiting",
					CAppHost::GetApp (ctx)->pBundle->id, pFunction, MaxQueued);
		return JS_ThrowRangeError (ctx, "%s: %u transfers are waiting already: await them",
					   pFunction, MaxQueued);
	}
	TGkUSBRequest *pRequest = &pState->Queue[(pState->nQueueIn + pState->nQueued) % MaxQueued];
	pRequest->nHandle = nSerial;
	pRequest->nDevice = pInfo->nID;
	pRequest->Kind = Kind;
	pRequest->ucRequestType = ucRequestType;
	pRequest->ucRequest = ucRequest;
	pRequest->usValue = usValue;
	pRequest->usIndex = usIndex;
	pRequest->usLength = (u16) nLength;
	if (pData != 0)
	{
		memcpy (pRequest->Data, pData, nLength);
	}
	JSValue Funcs[2];
	JSValue Promise = JS_NewPromiseCapability (ctx, Funcs);
	if (JS_IsException (Promise))
	{
		gk_wipe (pRequest->Data, sizeof pRequest->Data);
		return Promise;
	}
	pRequest->Resolve = Funcs[0];
	pRequest->Reject = Funcs[1];
	pState->nQueued++;
	return Promise;
}

// controlIn(setup, length)
static JSValue js_usb_control_in (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
				  int magic, JSValue *func_data)
{
	static const char Function[] = "controlIn";
	unsigned nSerial, nLength;
	const TGkUSBInfo *pInfo = HandleDevice (ctx, func_data, Function, &nSerial);
	u8 ucType, ucRequest;
	u16 usValue, usIndex;
	if (   pInfo == 0
	    || !GetSetup (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, pInfo, TRUE,
			  &ucType, &ucRequest, &usValue, &usIndex, Function)
	    || !GetInt (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "length", GK_USB_MAX_TRANSFER,
			&nLength, Function))
	{
		return JS_EXCEPTION;
	}
	if (nLength == 0)
	{
		return JS_ThrowRangeError (ctx, "%s: length must be from 1 to %u", Function,
					   GK_USB_MAX_TRANSFER);
	}
	return Queue (ctx, nSerial, pInfo, KindIn, ucType, ucRequest, usValue, usIndex,
		      0, nLength, Function);
}

// controlOut(setup, data)
static JSValue js_usb_control_out (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
				   int magic, JSValue *func_data)
{
	static const char Function[] = "controlOut";
	unsigned nSerial;
	const TGkUSBInfo *pInfo = HandleDevice (ctx, func_data, Function, &nSerial);
	u8 ucType, ucRequest;
	u16 usValue, usIndex;
	u8 Data[GK_USB_MAX_TRANSFER];
	int nLength = 0;
	if (   pInfo == 0
	    || !GetSetup (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, pInfo, FALSE,
			  &ucType, &ucRequest, &usValue, &usIndex, Function)
	    || (argc > 1 && !JS_IsUndefined (argv[1])
		&& (nLength = GetData (ctx, argv[1], Data, sizeof Data, Function)) < 0))
	{
		gk_wipe (Data, sizeof Data);
		return JS_EXCEPTION;
	}
	JSValue Result = Queue (ctx, nSerial, pInfo, KindOut, ucType, ucRequest, usValue, usIndex,
				Data, nLength, Function);
	gk_wipe (Data, sizeof Data);
	return Result;
}

// The interface a feature report goes to: iface if given, else the first HID one
static boolean GetHIDInterface (JSContext *ctx, JSValueConst v, const TGkUSBInfo *pInfo,
				unsigned *pInterface, const char *pFunction)
{
	if (!JS_IsUndefined (v))
	{
		if (!GetInt (ctx, v, "the interface", 255, pInterface, pFunction))
		{
			return FALSE;
		}
		if (!IsInterface (pInfo, *pInterface))
		{
			JS_ThrowRangeError (ctx, "%s: the device has no interface %u", pFunction,
					    *pInterface);
			return FALSE;
		}
		return TRUE;
	}
	for (unsigned i = 0; i < pInfo->Config.interface_count; i++)
	{
		if (pInfo->Config.interfaces[i].cls == 3)
		{
			*pInterface = pInfo->Config.interfaces[i].number;
			return TRUE;
		}
	}
	JS_ThrowTypeError (ctx, "%s: the device has no HID interface: say which interface", pFunction);
	return FALSE;
}

// getFeatureReport(id, length, iface?): HID GET_REPORT (feature)
static JSValue js_usb_get_feature (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
				   int magic, JSValue *func_data)
{
	static const char Function[] = "getFeatureReport";
	unsigned nSerial, nID, nLength, nInterface;
	const TGkUSBInfo *pInfo = HandleDevice (ctx, func_data, Function, &nSerial);
	if (   pInfo == 0
	    || !GetInt (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "the report id", 255, &nID, Function)
	    || !GetInt (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "length", GK_USB_MAX_TRANSFER,
			&nLength, Function)
	    || !GetHIDInterface (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, pInfo, &nInterface, Function))
	{
		return JS_EXCEPTION;
	}
	if (nLength == 0)
	{
		return JS_ThrowRangeError (ctx, "%s: length must be from 1 to %u", Function,
					   GK_USB_MAX_TRANSFER);
	}
	return Queue (ctx, nSerial, pInfo, KindIn,
		      GK_USB_DIR_IN | GK_USB_TYPE_CLASS | GK_USB_TO_INTERFACE, 0x01,	// GET_REPORT
		      0x0300 | nID, nInterface, 0, nLength, Function);
}

// setFeatureReport(id, data, iface?): HID SET_REPORT (feature); the data
// stage is the report id (if not 0) and the data, as on Linux and WebHID
static JSValue js_usb_set_feature (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
				   int magic, JSValue *func_data)
{
	static const char Function[] = "setFeatureReport";
	unsigned nSerial, nID, nInterface;
	const TGkUSBInfo *pInfo = HandleDevice (ctx, func_data, Function, &nSerial);
	u8 Data[GK_USB_MAX_TRANSFER];
	int nLength = -1;
	if (   pInfo == 0
	    || !GetInt (ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "the report id", 255, &nID, Function)
	    || (nLength = GetData (ctx, argc > 1 ? argv[1] : JS_UNDEFINED, Data + (nID != 0),
				   sizeof Data - (nID != 0), Function)) < 0
	    || !GetHIDInterface (ctx, argc > 2 ? argv[2] : JS_UNDEFINED, pInfo, &nInterface, Function))
	{
		gk_wipe (Data, sizeof Data);
		return JS_EXCEPTION;
	}
	if (nID != 0)
	{
		Data[0] = (u8) nID;
		nLength++;
	}
	JSValue Result = Queue (ctx, nSerial, pInfo, KindSetReport,
				GK_USB_TYPE_CLASS | GK_USB_TO_INTERFACE, 0x09,		// SET_REPORT
				0x0300 | nID, nInterface, Data, nLength, Function);
	gk_wipe (Data, sizeof Data);
	return Result;
}

// close(): the handle's transfers still waiting are rejected ("closed")
static JSValue js_usb_close (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
			     int magic, JSValue *func_data)
{
	TGkUSBState *pState = GetState (ctx);
	uint32_t nSerial = 0;
	JS_ToUint32 (ctx, &nSerial, func_data[0]);
	TGkUSBHandle *pHandle = FindHandle (pState, nSerial);
	if (pHandle != 0)
	{
		pHandle->nSerial = 0;
	}
	return JS_UNDEFINED;
}

// --- module functions ---------------------------------------------------------

static JSValue js_usb_list (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const gk_app_t *pApp = CAppHost::GetApp (ctx)->pBundle;
	JSValue List = JS_NewArray (ctx);
	unsigned n = 0;
	const TGkUSBInfo *pInfo;
	for (unsigned i = 0; (pInfo = CGkUSB::Get (i)) != 0; i++)
	{
		if (CGkUSB::Lists (pApp, pInfo->usVendor, pInfo->usProduct))
		{
			JS_SetPropertyUint32 (ctx, List, n++, NewInfo (ctx, *pInfo));
		}
	}
	return List;
}

// open(device): device is an entry of list() (or an event's), or its id
static JSValue js_usb_open (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	TGkUSBState *pState = GetState (ctx);

	JSValue ID = argc > 0 && JS_IsObject (argv[0]) ? JS_GetPropertyStr (ctx, argv[0], "id")
						       : JS_DupValue (ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
	unsigned nID = 0;
	boolean bOK = GetInt (ctx, ID, "the device (an entry of list(), or its id)", 0xFFFFFFFF,
			      &nID, "open");
	JS_FreeValue (ctx, ID);
	if (!bOK)
	{
		return JS_EXCEPTION;
	}

	const TGkUSBInfo *pInfo = CGkUSB::Find (nID);
	if (pInfo == 0 || !CGkUSB::Lists (pApp->pBundle, pInfo->usVendor, pInfo->usProduct))
	{
		return JS_ThrowTypeError (ctx, "open: no device %u (it was detached, or the manifest's"
					  " \"usb\" doesn't list it)", nID);
	}
	TGkUSBHandle *pFree = 0;
	for (unsigned i = 0; i < MaxHandles; i++)
	{
		TGkUSBHandle *pHandle = &pState->Handles[i];
		if (pHandle->nSerial != 0 && pHandle->nDevice == nID)
		{
			return JS_ThrowTypeError (ctx, "open: device %u is open already: close() it first",
						  nID);
		}
		if (pHandle->nSerial != 0 && CGkUSB::Find (pHandle->nDevice) == 0)
		{
			pHandle->nSerial = 0;		// its device is gone
		}
		if (pFree == 0 && pHandle->nSerial == 0)
		{
			pFree = pHandle;
		}
	}
	assert (pFree != 0);		// as many as there can be devices
	pFree->nSerial = pState->nNextHandle++;
	pFree->nDevice = nID;

	struct { const char *pName; int nArgs; JSCFunctionData *pFunc; } Methods[] = {
		{"controlIn", 2, js_usb_control_in},
		{"controlOut", 2, js_usb_control_out},
		{"getFeatureReport", 3, js_usb_get_feature},
		{"setFeatureReport", 3, js_usb_set_feature},
		{"close", 0, js_usb_close},
	};
	JSValue Serial = JS_NewUint32 (ctx, pFree->nSerial);
	JSValue Handle = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Handle, "device", NewInfo (ctx, *pInfo));
	for (unsigned i = 0; i < sizeof Methods / sizeof Methods[0]; i++)
	{
		JS_SetPropertyStr (ctx, Handle, Methods[i].pName,
				   JS_NewCFunctionData (ctx, Methods[i].pFunc, Methods[i].nArgs, 0,
							1, &Serial));
	}
	JS_FreeValue (ctx, Serial);
	return Handle;
}

// onAttach(fn), onDetach(fn) -> a function that removes it
static JSValue js_usb_off (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
			   int magic, JSValue *func_data)
{
	TGkUSBState *pState = GetState (ctx);
	uint32_t nSlot = 0;
	JS_ToUint32 (ctx, &nSlot, func_data[0]);
	if (nSlot < MaxHandlers)
	{
		JS_FreeValue (ctx, pState->Handlers[magic][nSlot]);
		pState->Handlers[magic][nSlot] = JS_UNDEFINED;
	}
	return JS_UNDEFINED;
}

static JSValue OnEvent (JSContext *ctx, int argc, JSValueConst *argv, int nKind, const char *pFunction)
{
	if (argc < 1 || !JS_IsFunction (ctx, argv[0]))
	{
		return JS_ThrowTypeError (ctx, "%s: a function expected", pFunction);
	}
	TGkUSBState *pState = GetState (ctx);
	for (unsigned i = 0; i < MaxHandlers; i++)
	{
		if (JS_IsUndefined (pState->Handlers[nKind][i]))
		{
			pState->Handlers[nKind][i] = JS_DupValue (ctx, argv[0]);
			JSValue Slot = JS_NewUint32 (ctx, i);
			JSValue Off = JS_NewCFunctionData (ctx, js_usb_off, 0, nKind, 1, &Slot);
			JS_FreeValue (ctx, Slot);
			return Off;
		}
	}
	return JS_ThrowRangeError (ctx, "%s: at most %u handlers", pFunction, MaxHandlers);
}

static JSValue js_usb_on_attach (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return OnEvent (ctx, argc, argv, 0, "onAttach");
}

static JSValue js_usb_on_detach (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return OnEvent (ctx, argc, argv, 1, "onDetach");
}

// --- the main loop's part -----------------------------------------------------

static void Settle (TGkApp *pApp, TGkUSBRequest *pRequest, int nResult, const u8 *pIn)
{
	JSContext *ctx = pApp->pContext;
	JSValue Value;
	boolean bOK = nResult >= 0;
	if (bOK)
	{
		switch (pRequest->Kind)
		{
		case KindIn:
			{
				JSValue Buffer = JS_NewArrayBufferCopy (ctx, pIn, nResult);
				JSValue Args[3] = {Buffer, JS_NewUint32 (ctx, 0), JS_NewUint32 (ctx, nResult)};
				Value = JS_NewTypedArray (ctx, 3, Args, JS_TYPED_ARRAY_UINT8);
				JS_FreeValue (ctx, Buffer);
			}
			break;

		case KindOut:
			Value = JS_NewUint32 (ctx, nResult);
			break;

		default:
			Value = JS_UNDEFINED;
			break;
		}
	}
	else
	{
		static const char *Codes[] = {"", "stall", "timeout", "error", "detached"};
		static const char *Messages[] = {"",
			"usb: the device refused the request (stall)",
			"usb: the device did not answer in time (timeout)",
			"usb: the transfer failed",
			"usb: the device was detached",
		};
		unsigned i = (unsigned) -nResult;
		const char *pCode = i < 5 ? Codes[i] : "error";
		const char *pMessage = i < 5 ? Messages[i] : Messages[3];
		if (nResult == GkUSBGone && CGkUSB::Find (pRequest->nDevice) != 0)
		{
			pCode = "closed";
			pMessage = "usb: the device was closed";
		}
		Value = NewError (ctx, pCode, pMessage);
	}

	JSValue Result = CAppHost::Get ()->Call (bOK ? pRequest->Resolve : pRequest->Reject,
						 JS_UNDEFINED, 1, &Value);
	JS_FreeValue (ctx, Result);
	JS_FreeValue (ctx, Value);
}

static void FreeRequest (JSContext *ctx, TGkUSBRequest *pRequest)
{
	JS_FreeValue (ctx, pRequest->Resolve);
	JS_FreeValue (ctx, pRequest->Reject);
	pRequest->Resolve = pRequest->Reject = JS_UNDEFINED;
	gk_wipe (pRequest->Data, sizeof pRequest->Data);
}

void GkUSBUpdate (TGkApp *pApp)
{
	TGkUSBState *pState = pApp != 0 && pApp->pBundle != 0 ? pApp->pUSB : 0;

	// attaches and detaches, to the handlers of an app that lists the device
	TGkUSBEvent Event;
	while (CGkUSB::TakeEvent (&Event))
	{
		if (   pState == 0
		    || !CGkUSB::Lists (pApp->pBundle, Event.Info.usVendor, Event.Info.usProduct))
		{
			continue;
		}
		JSContext *ctx = pApp->pContext;
		unsigned nKind = Event.bAttached ? 0 : 1;
		JSValue Info = NewInfo (ctx, Event.Info);
		for (unsigned i = 0; i < MaxHandlers; i++)
		{
			// a handler may remove itself or another
			if (pApp->pUSB == 0 || JS_IsUndefined (pState->Handlers[nKind][i]))
			{
				continue;
			}
			JSValue Func = JS_DupValue (ctx, pState->Handlers[nKind][i]);
			JSValue Result = CAppHost::Get ()->Call (Func, JS_UNDEFINED, 1, &Info);
			JS_FreeValue (ctx, Result);
			JS_FreeValue (ctx, Func);
		}
		JS_FreeValue (ctx, Info);
	}

	// one transfer a pass
	if (pState == 0 || pState->nQueued == 0)
	{
		return;
	}
	TGkUSBRequest Request = pState->Queue[pState->nQueueIn];
	gk_wipe (pState->Queue[pState->nQueueIn].Data, sizeof Request.Data);
	pState->nQueueIn = (pState->nQueueIn + 1) % MaxQueued;
	pState->nQueued--;

	u8 Buffer[GK_USB_MAX_TRANSFER];
	int nResult;
	TGkUSBHandle *pHandle = FindHandle (pState, Request.nHandle);
	if (pHandle == 0 || pHandle->nDevice != Request.nDevice)
	{
		nResult = GkUSBGone;		// closed: Settle() says so
	}
	else
	{
		if (!(Request.ucRequestType & GK_USB_DIR_IN))
		{
			memcpy (Buffer, Request.Data, Request.usLength);
		}
		nResult = CGkUSB::Transfer (pApp->pBundle->id, Request.nDevice, Request.ucRequestType,
					    Request.ucRequest, Request.usValue, Request.usIndex,
					    Buffer, Request.usLength);
	}
	Settle (pApp, &Request, nResult, Buffer);
	gk_wipe (Buffer, sizeof Buffer);
	FreeRequest (pApp->pContext, &Request);
}

void GkUSBFree (TGkApp *pApp)
{
	TGkUSBState *pState = pApp->pUSB;
	if (pState == 0)
	{
		return;
	}
	JSContext *ctx = pApp->pContext;
	for (unsigned k = 0; k < 2; k++)
	{
		for (unsigned i = 0; i < MaxHandlers; i++)
		{
			JS_FreeValue (ctx, pState->Handlers[k][i]);
		}
	}
	while (pState->nQueued > 0)
	{
		FreeRequest (ctx, &pState->Queue[pState->nQueueIn]);
		pState->nQueueIn = (pState->nQueueIn + 1) % MaxQueued;
		pState->nQueued--;
	}
	gk_wipe (pState, sizeof *pState);
	delete pState;
	pApp->pUSB = 0;
}

// --- module -----------------------------------------------------------------

static const JSCFunctionListEntry USBFunctions[] =
{
	JS_CFUNC_DEF ("list", 0, js_usb_list),
	JS_CFUNC_DEF ("open", 1, js_usb_open),
	JS_CFUNC_DEF ("onAttach", 1, js_usb_on_attach),
	JS_CFUNC_DEF ("onDetach", 1, js_usb_on_detach),
};

static int USBModuleInit (JSContext *ctx, JSModuleDef *m)
{
	return JS_SetModuleExportList (ctx, m, USBFunctions,
				       sizeof USBFunctions / sizeof USBFunctions[0]);
}

JSModuleDef *GkInitUSBModule (JSContext *ctx, const char *pName)
{
	GetState (ctx);			// events from now on
	JSModuleDef *m = JS_NewCModule (ctx, pName, USBModuleInit);
	if (m != 0)
	{
		JS_AddModuleExportList (ctx, m, USBFunctions,
					sizeof USBFunctions / sizeof USBFunctions[0]);
	}
	return m;
}
