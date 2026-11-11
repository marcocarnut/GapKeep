//
// usbclaim.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "usbclaim.h"
#include "crypto/wipe.h"
#include <circle/usb/usbdevice.h>
#include <circle/usb/usbhostcontroller.h>
#include <circle/usb/usbrequest.h>
#include <circle/usb/usbendpoint.h>
#include <circle/logger.h>
#include <circle/util.h>
#include <assert.h>

static const char FromClaim[] = "usb";

CUSBFunction *GkUSBClaimHook (CUSBFunction *pFirstInterface, u16 usVendorID, u16 usProductID)
{
	const gk_app_t *pApp = CGkUSB::Claimant (usVendorID, usProductID);
	if (pApp == 0)
	{
		return 0;
	}
	CLogger::Get ()->Write (FromClaim, LogNotice, "%04x:%04x claimed for %s: none of its interfaces"
				" gets another driver", usVendorID, usProductID, pApp->id);
	return new CGkUSBClaimed (pFirstInterface);
}

CGkUSBClaimed::CGkUSBClaimed (CUSBFunction *pFirstInterface)
:	CUSBFunction (pFirstInterface),
	m_pBuffer (new u8[GK_USB_MAX_CONFIG_SIZE]),
	m_bAttached (FALSE)
{
}

CGkUSBClaimed::~CGkUSBClaimed (void)
{
	// unplugged (Circle deletes the device's functions), or never configured
	if (m_bAttached)
	{
		CGkUSB::Detach (this);
	}
	gk_wipe (m_pBuffer, GK_USB_MAX_CONFIG_SIZE);
	delete [] m_pBuffer;
}

boolean CGkUSBClaimed::Configure (void)
{
	// Circle has set the configuration; the first interface's alternate
	// setting, if it isn't 0, is set here as for any function
	if (!CUSBFunction::Configure ())
	{
		return FALSE;
	}
	m_bAttached = CGkUSB::Attach (this);
	return m_bAttached;		// FALSE: the device stays without a driver
}

int CGkUSBClaimed::Control (u8 ucRequestType, u8 ucRequest, u16 usValue, u16 usIndex,
			    u8 *pData, u16 usLength, unsigned nTimeoutMs)
{
	if (usLength > GK_USB_MAX_CONFIG_SIZE)
	{
		return GkUSBError;
	}
	boolean bIn = (ucRequestType & GK_USB_DIR_IN) != 0;
	if (!bIn && usLength > 0)
	{
		memcpy (m_pBuffer, pData, usLength);
	}

	// IN stages land in a bounce buffer of whole packets (patches/circle/
	// 0008), and no more than asked for is copied here; a control
	// transfer gives up after nTimeoutMs a stage, and a device whose
	// transfers time out twice gets none until replugged (0010)
	// As CUSBHostController::ControlMessage(), which says only that it
	// failed: the URB says why (a stall, a timeout).
	TSetupData *pSetup = new TSetupData;		// DMA: from the heap, aligned
	pSetup->bmRequestType = ucRequestType;
	pSetup->bRequest = ucRequest;
	pSetup->wValue = usValue;
	pSetup->wIndex = usIndex;
	pSetup->wLength = usLength;
	int nResult;
	{
		CUSBRequest URB (GetEndpoint0 (), m_pBuffer, usLength, pSetup);
		if (GetHost ()->SubmitBlockingRequest (&URB, nTimeoutMs))
		{
			nResult = URB.GetResultLength ();
		}
		else
		{
			GetEndpoint0 ()->ResetPID ();
			switch (URB.GetUSBError ())
			{
			case USBErrorStall:	nResult = GkUSBStall;	break;
			case USBErrorTimeout:	nResult = GkUSBTimeout;	break;
			case USBErrorAborted:	nResult = GkUSBGone;	break;	// the port went
			default:		nResult = GkUSBError;	break;
			}
		}
	}
	delete pSetup;

	if (nResult > usLength)
	{
		nResult = GkUSBError;
	}
	else if (bIn)
	{
		memcpy (pData, m_pBuffer, nResult);
	}
	gk_wipe (m_pBuffer, usLength);

	return nResult;
}

TGkUSBSpeed CGkUSBClaimed::GetSpeed (void) const
{
	switch (GetDevice ()->GetSpeed ())
	{
	case USBSpeedLow:	return GkUSBSpeedLow;
	case USBSpeedHigh:	return GkUSBSpeedHigh;
	case USBSpeedSuper:	return GkUSBSpeedSuper;
	default:		return GkUSBSpeedFull;
	}
}
