//
// usbclaim.h
//
// The Circle driver for USB devices claimed for apps (gk:usb,
// src/runtime/usb.h). Circle's device factory asks GkUSBClaimHook first
// about every new device (patches/circle/0014); a device some available
// app lists by its ids is claimed whole: this driver takes it, made from
// its first interface, and none of its interfaces gets another driver.
// So a claimed device's keyboard and mouse interfaces are ignored: what
// it types never reaches the system. The driver uses endpoint 0, through
// Circle's control transfers (bounded by patches 0003, 0008 and 0010), and
// hands the device to CGkUSB, which reads its descriptors and serves the
// app's transfers. While an app asks for it, it also reads one interrupt
// IN endpoint, as Circle's HID driver does: a request always waiting,
// completed in the USB interrupt handler, which keeps the packet and asks
// again; the packets wait in a CGkUSBPackets until the app takes them.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_usbclaim_h
#define _gk_usbclaim_h

#include <circle/usb/usbfunction.h>
#include <circle/usb/usbendpoint.h>
#include <circle/usb/usbrequest.h>
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

	boolean StartInterrupt (const gk_usb_endpoint_t &rEndpoint);
	void StopInterrupt (void);
	int TakeInterrupt (u8 *pData, unsigned nSize);

private:
	boolean SubmitInterrupt (void);		// from the main loop or the handler
	void InterruptComplete (CUSBRequest *pURB);
	static void InterruptStub (CUSBRequest *pURB, void *pParam, void *pContext);

	u8 *m_pBuffer;			// for the transfers: DMA, cache-line aligned
	boolean m_bAttached;

	// the interrupt endpoint (all but the packets: the handler's too)
	CUSBEndpoint *m_pInterrupt;	// 0: none read yet
	u8 m_ucInterrupt;		// its address
	u16 m_usInterruptSize;		// its max_packet
	u8 *m_pInterruptBuffer;		// one packet: DMA
	volatile boolean m_bReading;	// the app wants it
	volatile boolean m_bPending;	// a request is waiting on it
	volatile boolean m_bFailed;
	volatile unsigned m_nErrors;	// in a row
	CGkUSBPackets m_Packets;
};

// For CUSBDeviceFactory::SetClaimHook()
CUSBFunction *GkUSBClaimHook (CUSBFunction *pFirstInterface, u16 usVendorID, u16 usProductID);

#endif
