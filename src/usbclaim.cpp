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
#include <circle/synchronize.h>
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
	m_bAttached (FALSE),
	m_pInterrupt (0),
	m_ucInterrupt (0),
	m_usInterruptSize (0),
	m_pInterruptBuffer (new u8[GK_USB_MAX_TRANSFER]),
	m_bReading (FALSE),
	m_bPending (FALSE),
	m_bFailed (FALSE),
	m_nErrors (0)
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

	// Circle has cancelled the device's requests (~CUSBDevice), the
	// interrupt endpoint's with them, before deleting its functions
	m_bReading = FALSE;
	EnterCritical (IRQ_LEVEL);
	m_Packets.Clear ();
	LeaveCritical ();
	gk_wipe (m_pInterruptBuffer, GK_USB_MAX_TRANSFER);
	delete [] m_pInterruptBuffer;
	delete m_pInterrupt;
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

	// a failed request's result is negative (GkUSBStall, GkUSBTimeout...):
	// nothing to copy. Copying it as a length (size_t) overwrote all of
	// memory, so a device that let one IN request time out (a DigiMacro
	// behind a hub, on the rig) or stalled one froze the system.
	if (nResult < 0)
	{
	}
	else if (nResult > usLength)
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

// --- the interrupt endpoint -------------------------------------------------

// errors in a row (a device that stops answering, a bus problem) before it
// is given up, as Circle's HID driver
static const unsigned MaxInterruptErrors = 3;

boolean CGkUSBClaimed::StartInterrupt (const gk_usb_endpoint_t &rEndpoint)
{
	assert (rEndpoint.max_packet > 0 && rEndpoint.max_packet <= GK_USB_MAX_TRANSFER);

	if (m_bPending && m_ucInterrupt != rEndpoint.address)
	{
		// one endpoint a device: its request still waits (a device that
		// has sent nothing since), and can't be withdrawn
		return FALSE;
	}
	if (m_pInterrupt == 0 || m_ucInterrupt != rEndpoint.address)
	{
		TUSBEndpointDescriptor Desc;
		Desc.bLength = sizeof Desc;
		Desc.bDescriptorType = DESCRIPTOR_ENDPOINT;
		Desc.bEndpointAddress = rEndpoint.address;
		Desc.bmAttributes = rEndpoint.attributes;
		Desc.wMaxPacketSize = rEndpoint.max_packet;
		Desc.bInterval = rEndpoint.interval;
		delete m_pInterrupt;
		m_pInterrupt = new CUSBEndpoint (GetDevice (), &Desc);
		m_ucInterrupt = rEndpoint.address;
		m_usInterruptSize = rEndpoint.max_packet;
	}

	EnterCritical (IRQ_LEVEL);
	m_Packets.Clear ();
	m_bFailed = FALSE;
	m_nErrors = 0;
	m_bReading = TRUE;
	boolean bOK = m_bPending || SubmitInterrupt ();
	if (!bOK)
	{
		m_bReading = FALSE;
	}
	LeaveCritical ();
	return bOK;
}

void CGkUSBClaimed::StopInterrupt (void)
{
	// a request still waiting stays (Circle has no way to withdraw one): its
	// packet, when it comes, is dropped, and it is not asked again
	EnterCritical (IRQ_LEVEL);
	m_bReading = FALSE;
	unsigned nDropped = m_Packets.Clear ();
	LeaveCritical ();
	if (nDropped > 0)
	{
		CLogger::Get ()->Write (FromClaim, LogWarning, "endpoint 0x%02x: %u packet(s) dropped:"
					" not taken in time", m_ucInterrupt, nDropped);
	}
}

int CGkUSBClaimed::TakeInterrupt (u8 *pData, unsigned nSize)
{
	EnterCritical (IRQ_LEVEL);
	int nResult = m_Packets.Take (pData, nSize);
	if (nResult == GkUSBNone && m_bFailed)
	{
		nResult = GkUSBError;
	}
	LeaveCritical ();
	return nResult;
}

// with IRQs off (EnterCritical, or in the handler)
boolean CGkUSBClaimed::SubmitInterrupt (void)
{
	assert (m_pInterrupt != 0);
	CUSBRequest *pURB = new CUSBRequest (m_pInterrupt, m_pInterruptBuffer, m_usInterruptSize);
	pURB->SetCompletionRoutine (InterruptStub, 0, this);
	m_bPending = GetHost ()->SubmitAsyncRequest (pURB);
	if (!m_bPending)
	{
		delete pURB;
	}
	return m_bPending;
}

// in the USB interrupt handler
void CGkUSBClaimed::InterruptComplete (CUSBRequest *pURB)
{
	m_bPending = FALSE;
	boolean bAgain = m_bReading;
	if (pURB->GetStatus () != 0)
	{
		m_nErrors = 0;
		unsigned nLength = pURB->GetResultLength ();
		if (m_bReading && nLength <= m_usInterruptSize)
		{
			m_Packets.Put (m_pInterruptBuffer, nLength);
		}
	}
	else if (pURB->GetUSBError () == USBErrorAborted)
	{
		bAgain = FALSE;			// the device is going
	}
	else if (pURB->GetUSBError () != USBErrorFrameOverrun && ++m_nErrors >= MaxInterruptErrors)
	{
		m_bFailed = TRUE;
		bAgain = FALSE;
	}
	gk_wipe (m_pInterruptBuffer, GK_USB_MAX_TRANSFER);
	delete pURB;

	if (bAgain)
	{
		SubmitInterrupt ();
		if (!m_bPending)
		{
			m_bFailed = TRUE;
		}
	}
}

void CGkUSBClaimed::InterruptStub (CUSBRequest *pURB, void *pParam, void *pContext)
{
	((CGkUSBClaimed *) pContext)->InterruptComplete (pURB);
}
