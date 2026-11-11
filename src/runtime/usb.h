//
// usb.h
//
// USB devices claimed for apps (gk:usb, docs/API.md): devices whose vendor
// and product ids an available app lists in its manifest ("usb"). A claimed
// device is the app's alone: none of its interfaces gets a system driver,
// so a keyboard among them types nothing (patches/circle/0014). Apps reach
// it through control transfers on endpoint 0 only, at most
// GK_USB_MAX_TRANSFER bytes each, with a timeout; nothing else (no
// interrupt, bulk or isochronous endpoints).
//
// The device itself is behind a CGkUSBPort: on the Pi, Circle's driver for
// a claimed device (src/usbclaim.cpp); in the simulator, a device imported
// over USB/IP (sim/src/usbip.cpp). Everything above it is this file's and
// is the same on both: reading and checking the descriptors (usbdesc.h),
// the bounds, the timeouts, the log, and the attach and detach events.
//
// Nothing a device sends is logged, but its ids and the names it gives
// (as text that may be shown: usbdesc.h); nothing an app sends either:
// requests by their numbers, data by its length.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_usb_h
#define _gk_usb_h

#include <circle/types.h>
#include "bundle.h"
#include "usbdesc.h"

#define GK_USB_MAX_DEVICES	4	// claimed at once
#define GK_USB_MAX_TRANSFER	64	// bytes in one of an app's control transfers
#define GK_USB_TIMEOUT_MS	1000	// an app's control transfer, each stage
#define GK_USB_MAX_TIMEOUTS	2	// then the device's transfers fail at once,
					// until it is plugged in again

enum TGkUSBSpeed
{
	GkUSBSpeedLow,
	GkUSBSpeedFull,
	GkUSBSpeedHigh,
	GkUSBSpeedSuper
};

// What a transfer comes to: >= 0 is the length of the data stage
enum
{
	GkUSBStall = -1,	// the device refused the request
	GkUSBTimeout = -2,	// no answer in time
	GkUSBError = -3,	// anything else that went wrong on the bus
	GkUSBGone = -4		// the device is not there
};

// bmRequestType, as USB 2.0 9.3
#define GK_USB_DIR_IN		0x80
#define GK_USB_TYPE_STANDARD	0x00
#define GK_USB_TYPE_CLASS	0x20
#define GK_USB_TYPE_VENDOR	0x40
#define GK_USB_TYPE_MASK	0x60
#define GK_USB_TO_DEVICE	0x00
#define GK_USB_TO_INTERFACE	0x01
#define GK_USB_RECIPIENT_MASK	0x1F

// A claimed device, as the system reaches it
class CGkUSBPort
{
public:
	virtual ~CGkUSBPort (void) {}

	// One control transfer on endpoint 0. Data IN: pData has room for
	// nLength bytes, of which no more than nLength may be written; OUT:
	// nLength bytes from it. Returns the length of the data stage, or a
	// Gk USB result < 0.
	virtual int Control (u8 ucRequestType, u8 ucRequest, u16 usValue, u16 usIndex,
			     u8 *pData, u16 usLength, unsigned nTimeoutMs) = 0;

	virtual TGkUSBSpeed GetSpeed (void) const = 0;
};

// A claimed device, as apps see it
struct TGkUSBInfo
{
	unsigned nID;			// 1, 2, ...: a new one each time a device comes
	u16 usVendor, usProduct;
	TGkUSBSpeed Speed;
	char Manufacturer[GK_USB_MAX_STRING];	// "" if it gives none
	char Product[GK_USB_MAX_STRING];
	char Serial[GK_USB_MAX_STRING];
	gk_usb_config_t Config;		// its interfaces
	const gk_app_t *pClaimant;	// the first available app that lists it
};

struct TGkUSBEvent
{
	boolean bAttached;		// FALSE: detached
	TGkUSBInfo Info;
};

class CGkUSB
{
public:
	// The first available app (CAppStore::IsAvailable) whose manifest
	// lists the device, or 0: then the system doesn't claim it.
	static const gk_app_t *Claimant (u16 usVendor, u16 usProduct);

	// Whether the app's manifest lists the device
	static boolean Lists (const gk_app_t *pApp, u16 usVendor, u16 usProduct);

	// A claimed device has come: its descriptors are read through pPort
	// and checked. FALSE if they are not right (logged): the device is not
	// used, nor given to any other driver.
	static boolean Attach (CGkUSBPort *pPort);

	// It has gone (unplugged, or its driver is going away). Its transfers
	// fail from now on.
	static void Detach (CGkUSBPort *pPort);

	// The claimed devices: nIndex from 0 while it returns one
	static const TGkUSBInfo *Get (unsigned nIndex);
	static const TGkUSBInfo *Find (unsigned nID);

	// An app's control transfer to the device nID, checked as gk:usb's
	// (js_usb.cpp): nLength <= GK_USB_MAX_TRANSFER. Never more than
	// GK_USB_TIMEOUT_MS a stage; after GK_USB_MAX_TIMEOUTS timeouts the
	// device's transfers fail at once (GkUSBTimeout) until it is plugged
	// in again. Failures are logged (pAppID's, the request's numbers).
	static int Transfer (const char *pAppID, unsigned nID, u8 ucRequestType, u8 ucRequest,
			     u16 usValue, u16 usIndex, u8 *pData, u16 usLength);

	// Attaches and detaches since the last call, oldest first: TRUE and
	// *pEvent while there is one. Called by gk:usb, from the main loop.
	static boolean TakeEvent (TGkUSBEvent *pEvent);

private:
	static boolean ReadInfo (CGkUSBPort *pPort, TGkUSBInfo *pInfo);
	static void ReadString (CGkUSBPort *pPort, u8 ucIndex, u16 usLangID, char *pOut);
	static void QueueEvent (boolean bAttached, const TGkUSBInfo &rInfo);

	struct TSlot
	{
		CGkUSBPort *pPort;	// 0: free
		TGkUSBInfo Info;
		unsigned nTimeouts;
	};
	static TSlot s_Slots[GK_USB_MAX_DEVICES];
	static unsigned s_nNextID;

	static const unsigned MaxEvents = 16;
	static TGkUSBEvent s_Events[MaxEvents];
	static unsigned s_nEventIn, s_nEventCount;
};

#endif
