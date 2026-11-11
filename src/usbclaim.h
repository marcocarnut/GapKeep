//
// usbclaim.h
//
// The Circle driver for USB devices claimed for apps (gk:usb,
// src/runtime/usb.h). Circle's device factory asks GkUSBClaimHook first
// about every new device (patches/circle/0014); a device some available
// app lists by its ids is claimed whole: this driver takes it, made from
// its first interface, and none of its interfaces gets another driver.
// So a claimed device's keyboard and mouse interfaces are ignored: what
// it types never reaches the system. The driver uses endpoint 0 only,
// through Circle's control transfers (bounded by patches 0003, 0008 and
// 0010), and hands the device to CGkUSB, which reads its descriptors and
// serves the app's transfers.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_usbclaim_h
#define _gk_usbclaim_h

#include <circle/usb/usbfunction.h>
#include <circle/types.h>
#include "runtime/usb.h"

class CGkUSBClaimed : public CUSBFunction, public CGkUSBPort
{
public:
	CGkUSBClaimed (CUSBFunction *pFirstInterface);
	~CGkUSBClaimed (void);

	boolean Configure (void);

	int Control (u8 ucRequestType, u8 ucRequest, u16 usValue, u16 usIndex,
		     u8 *pData, u16 usLength, unsigned nTimeoutMs);

	TGkUSBSpeed GetSpeed (void) const;

private:
	u8 *m_pBuffer;			// for the transfers: DMA, cache-line aligned
	boolean m_bAttached;
};

// For CUSBDeviceFactory::SetClaimHook()
CUSBFunction *GkUSBClaimHook (CUSBFunction *pFirstInterface, u16 usVendorID, u16 usProductID);

#endif
