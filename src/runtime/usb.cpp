//
// usb.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "usb.h"
#include "appstore.h"
#include "../crypto/wipe.h"
#include <circle/logger.h>
#include <circle/util.h>
#include <assert.h>

static const char FromUSB[] = "usb";

// reading a new device's descriptors: each request gets this long
static const unsigned DescriptorTimeoutMs = 500;

CGkUSB::TSlot CGkUSB::s_Slots[GK_USB_MAX_DEVICES];
unsigned CGkUSB::s_nNextID = 1;
TGkUSBEvent CGkUSB::s_Events[CGkUSB::MaxEvents];
unsigned CGkUSB::s_nEventIn = 0;
unsigned CGkUSB::s_nEventCount = 0;

static const char *SpeedName (TGkUSBSpeed Speed)
{
	static const char *Names[] = {"low", "full", "high", "super"};
	return Names[Speed <= GkUSBSpeedSuper ? Speed : GkUSBSpeedSuper];
}

static const char *ResultName (int nResult)
{
	switch (nResult)
	{
	case GkUSBStall:	return "stall";
	case GkUSBTimeout:	return "timeout";
	case GkUSBGone:		return "detached";
	default:		return "error";
	}
}

boolean CGkUSB::Lists (const gk_app_t *pApp, u16 usVendor, u16 usProduct)
{
	unsigned nID = (unsigned) usVendor << 16 | usProduct;
	for (unsigned i = 0; pApp != 0 && i < pApp->usb_count; i++)
	{
		if (pApp->usb[i] == nID)
		{
			return TRUE;
		}
	}
	return FALSE;
}

const gk_app_t *CGkUSB::Claimant (u16 usVendor, u16 usProduct)
{
	for (unsigned i = 0; i < CAppStore::GetCount (); i++)
	{
		const gk_app_t *pApp = CAppStore::Get (i);
		if (CAppStore::IsAvailable (pApp) && Lists (pApp, usVendor, usProduct))
		{
			return pApp;
		}
	}
	return 0;
}

void CGkUSB::ReadString (CGkUSBPort *pPort, u8 ucIndex, u16 usLangID, char *pOut)
{
	pOut[0] = '\0';
	if (ucIndex == 0 || ucIndex == 0xFF)
	{
		return;
	}
	u8 Buffer[255];
	int nLength = pPort->Control (GK_USB_DIR_IN, 6, 0x0300 | ucIndex, usLangID,
				      Buffer, sizeof Buffer, DescriptorTimeoutMs);
	if (   nLength < 0
	    || gk_usb_parse_string (Buffer, nLength, pOut, GK_USB_MAX_STRING) < 0)
	{
		pOut[0] = '\0';		// a name it doesn't give right: none
	}
}

boolean CGkUSB::ReadInfo (CGkUSBPort *pPort, TGkUSBInfo *pInfo)
{
	memset (pInfo, 0, sizeof *pInfo);
	pInfo->Speed = pPort->GetSpeed ();

	// GET_DESCRIPTOR: the device's, its configuration's (first 9 bytes,
	// then all), and the strings
	u8 Device[18];
	gk_usb_device_desc_t Desc;
	int nLength = pPort->Control (GK_USB_DIR_IN, 6, 0x0100, 0, Device, sizeof Device,
				      DescriptorTimeoutMs);
	if (nLength < 0 || gk_usb_parse_device (Device, nLength, &Desc) < 0)
	{
		CLogger::Get ()->Write (FromUSB, LogError, "a claimed device: no device descriptor"
					" (%s)", nLength < 0 ? ResultName (nLength) : "malformed");
		return FALSE;
	}
	pInfo->usVendor = Desc.vid;
	pInfo->usProduct = Desc.pid;

	u8 *pConfig = new u8[GK_USB_MAX_CONFIG_SIZE];
	nLength = pPort->Control (GK_USB_DIR_IN, 6, 0x0200, 0, pConfig, 9, DescriptorTimeoutMs);
	int nTotal = nLength < 0 ? nLength : gk_usb_config_total (pConfig, nLength);
	if (nTotal > 0)
	{
		nLength = pPort->Control (GK_USB_DIR_IN, 6, 0x0200, 0, pConfig, nTotal,
					  DescriptorTimeoutMs);
	}
	boolean bOK =    nTotal > 0
		      && nLength == nTotal
		      && gk_usb_parse_config (pConfig, nLength, &pInfo->Config) == 0;
	delete [] pConfig;
	if (!bOK)
	{
		CLogger::Get ()->Write (FromUSB, LogError, "%04x:%04x: its configuration descriptor"
					" is %s: not used", Desc.vid, Desc.pid,
					nLength < 0 ? ResultName (nLength) : "malformed");
		return FALSE;
	}

	u8 Lang[255];
	u16 usLangID = 0;
	if (Desc.i_manufacturer != 0 || Desc.i_product != 0 || Desc.i_serial != 0)
	{
		nLength = pPort->Control (GK_USB_DIR_IN, 6, 0x0300, 0, Lang, sizeof Lang,
					  DescriptorTimeoutMs);
		if (nLength < 0 || gk_usb_parse_langid (Lang, nLength, &usLangID) < 0)
		{
			usLangID = 0x0409;		// as Circle and Linux do
		}
	}
	ReadString (pPort, Desc.i_manufacturer, usLangID, pInfo->Manufacturer);
	ReadString (pPort, Desc.i_product, usLangID, pInfo->Product);
	ReadString (pPort, Desc.i_serial, usLangID, pInfo->Serial);

	return TRUE;
}

boolean CGkUSB::Attach (CGkUSBPort *pPort)
{
	assert (pPort != 0);

	TSlot *pSlot = 0;
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		assert (s_Slots[i].pPort != pPort);
		if (pSlot == 0 && s_Slots[i].pPort == 0)
		{
			pSlot = &s_Slots[i];
		}
	}
	if (pSlot == 0)
	{
		CLogger::Get ()->Write (FromUSB, LogError, "a claimed device: already %u, no more",
					GK_USB_MAX_DEVICES);
		return FALSE;
	}

	TGkUSBInfo Info;
	if (!ReadInfo (pPort, &Info))
	{
		return FALSE;
	}
	Info.pClaimant = Claimant (Info.usVendor, Info.usProduct);
	if (Info.pClaimant == 0)
	{
		// not a device the port should have claimed (the simulator asks
		// after its import; on the Pi this can't happen)
		CLogger::Get ()->Write (FromUSB, LogNotice, "%04x:%04x: no app lists it: not used",
					Info.usVendor, Info.usProduct);
		return FALSE;
	}
	Info.nID = s_nNextID++;

	pSlot->pPort = pPort;
	pSlot->Info = Info;
	pSlot->nTimeouts = 0;
	pSlot->ucInterrupt = 0;

	// names the device gives are shown as text (usbdesc.h); the serial
	// number by its length only
	CLogger::Get ()->Write (FromUSB, LogNotice, "device %u: %04x:%04x \"%s\" \"%s\", serial of %u"
				" bytes, %s speed, %u interface(s), for %s; it is not a keyboard"
				" or mouse while claimed", Info.nID, Info.usVendor, Info.usProduct,
				Info.Manufacturer, Info.Product, (unsigned) strlen (Info.Serial),
				SpeedName (Info.Speed), Info.Config.interface_count,
				Info.pClaimant->id);

	QueueEvent (TRUE, Info);

	return TRUE;
}

void CGkUSB::Detach (CGkUSBPort *pPort)
{
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		TSlot *pSlot = &s_Slots[i];
		if (pSlot->pPort == pPort)
		{
			CLogger::Get ()->Write (FromUSB, LogNotice, "device %u: detached", pSlot->Info.nID);
			if (pSlot->ucInterrupt != 0)
			{
				pPort->StopInterrupt ();
				pSlot->ucInterrupt = 0;
			}
			QueueEvent (FALSE, pSlot->Info);
			pSlot->pPort = 0;
			return;
		}
	}
}

const TGkUSBInfo *CGkUSB::Get (unsigned nIndex)
{
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		if (s_Slots[i].pPort != 0 && nIndex-- == 0)
		{
			return &s_Slots[i].Info;
		}
	}
	return 0;
}

const TGkUSBInfo *CGkUSB::Find (unsigned nID)
{
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		if (s_Slots[i].pPort != 0 && s_Slots[i].Info.nID == nID)
		{
			return &s_Slots[i].Info;
		}
	}
	return 0;
}

int CGkUSB::Transfer (const char *pAppID, unsigned nID, u8 ucRequestType, u8 ucRequest,
		      u16 usValue, u16 usIndex, u8 *pData, u16 usLength)
{
	assert (usLength <= GK_USB_MAX_TRANSFER);

	TSlot *pSlot = 0;
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		if (s_Slots[i].pPort != 0 && s_Slots[i].Info.nID == nID)
		{
			pSlot = &s_Slots[i];
		}
	}
	if (pSlot == 0)
	{
		return GkUSBGone;
	}

	int nResult;
	if (pSlot->nTimeouts >= GK_USB_MAX_TIMEOUTS)
	{
		nResult = GkUSBTimeout;
	}
	else
	{
		nResult = pSlot->pPort->Control (ucRequestType, ucRequest, usValue, usIndex,
						 pData, usLength, GK_USB_TIMEOUT_MS);
		if (nResult > usLength)
		{
			nResult = GkUSBError;	// a port must not; refused all the same
		}
		if (nResult == GkUSBTimeout && ++pSlot->nTimeouts == GK_USB_MAX_TIMEOUTS)
		{
			CLogger::Get ()->Write (FromUSB, LogWarning, "device %u: timed out %u times:"
						" no more transfers until it is plugged in again",
						nID, GK_USB_MAX_TIMEOUTS);
		}
	}

	if (nResult < 0)
	{
		CLogger::Get ()->Write (FromUSB, LogWarning, "device %u: %s: control %s"
					" type 0x%02x request 0x%02x of %u bytes: %s", nID, pAppID,
					ucRequestType & GK_USB_DIR_IN ? "IN" : "OUT",
					ucRequestType, ucRequest, usLength, ResultName (nResult));
	}

	return nResult;
}

int CGkUSB::StartInterrupt (const char *pAppID, unsigned nID, u8 ucEndpoint)
{
	TSlot *pSlot = 0;
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		if (s_Slots[i].pPort != 0 && s_Slots[i].Info.nID == nID)
		{
			pSlot = &s_Slots[i];
		}
	}
	if (pSlot == 0)
	{
		return GkUSBGone;
	}
	if (pSlot->ucInterrupt == ucEndpoint)
	{
		return 0;
	}

	const gk_usb_endpoint_t *pEndpoint = 0;
	for (unsigned i = 0; i < pSlot->Info.Config.endpoint_count; i++)
	{
		const gk_usb_endpoint_t *p = &pSlot->Info.Config.endpoints[i];
		if (   p->address == ucEndpoint
		    && (p->address & GK_USB_EP_IN)
		    && (p->attributes & GK_USB_EP_TYPE_MASK) == GK_USB_EP_INTERRUPT
		    && p->max_packet > 0
		    && p->max_packet <= GK_USB_MAX_TRANSFER)
		{
			pEndpoint = p;
		}
	}
	if (pEndpoint == 0)
	{
		CLogger::Get ()->Write (FromUSB, LogWarning, "device %u: %s: endpoint 0x%02x is not an"
					" interrupt IN endpoint of at most %u bytes", nID, pAppID,
					ucEndpoint, GK_USB_MAX_TRANSFER);
		return GkUSBError;
	}

	if (pSlot->ucInterrupt != 0)
	{
		pSlot->pPort->StopInterrupt ();
		pSlot->ucInterrupt = 0;
	}
	if (!pSlot->pPort->StartInterrupt (*pEndpoint))
	{
		CLogger::Get ()->Write (FromUSB, LogWarning, "device %u: %s: cannot read endpoint 0x%02x",
					nID, pAppID, ucEndpoint);
		return GkUSBError;
	}
	pSlot->ucInterrupt = ucEndpoint;
	// what the endpoint sends is the app's: never logged
	CLogger::Get ()->Write (FromUSB, LogNotice, "device %u: %s reads endpoint 0x%02x (packets"
				" of up to %u bytes, every %u)", nID, pAppID, ucEndpoint,
				pEndpoint->max_packet, pEndpoint->interval);
	return 0;
}

void CGkUSB::StopInterrupt (unsigned nID)
{
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		TSlot *pSlot = &s_Slots[i];
		if (pSlot->pPort != 0 && pSlot->Info.nID == nID && pSlot->ucInterrupt != 0)
		{
			pSlot->pPort->StopInterrupt ();
			pSlot->ucInterrupt = 0;
		}
	}
}

int CGkUSB::TakeInterrupt (unsigned nID, u8 *pData, unsigned nSize)
{
	for (unsigned i = 0; i < GK_USB_MAX_DEVICES; i++)
	{
		TSlot *pSlot = &s_Slots[i];
		if (pSlot->pPort != 0 && pSlot->Info.nID == nID)
		{
			if (pSlot->ucInterrupt == 0)
			{
				return GkUSBError;
			}
			int nResult = pSlot->pPort->TakeInterrupt (pData, nSize);
			if (nResult == GkUSBError)
			{
				CLogger::Get ()->Write (FromUSB, LogWarning, "device %u: endpoint 0x%02x"
							" failed: no more is read", nID, pSlot->ucInterrupt);
				pSlot->pPort->StopInterrupt ();
				pSlot->ucInterrupt = 0;
			}
			return nResult;
		}
	}
	return GkUSBGone;
}

// --- CGkUSBPackets ----------------------------------------------------------

void CGkUSBPackets::Put (const u8 *pData, unsigned nLength)
{
	if (m_nCount == GK_USB_MAX_PACKETS || nLength > GK_USB_MAX_TRANSFER)
	{
		m_nDropped++;
		return;
	}
	TPacket *pPacket = &m_Packets[(m_nIn + m_nCount) % GK_USB_MAX_PACKETS];
	memcpy (pPacket->Data, pData, nLength);
	pPacket->nLength = (u8) nLength;
	m_nCount++;
}

int CGkUSBPackets::Take (u8 *pData, unsigned nSize)
{
	if (m_nCount == 0)
	{
		return GkUSBNone;
	}
	TPacket *pPacket = &m_Packets[m_nIn];
	int nLength = pPacket->nLength <= nSize ? pPacket->nLength : (int) nSize;
	memcpy (pData, pPacket->Data, nLength);
	gk_wipe (pPacket, sizeof *pPacket);
	m_nIn = (m_nIn + 1) % GK_USB_MAX_PACKETS;
	m_nCount--;
	return nLength;
}

unsigned CGkUSBPackets::Clear (void)
{
	gk_wipe (m_Packets, sizeof m_Packets);
	m_nIn = m_nCount = 0;
	unsigned nDropped = m_nDropped;
	m_nDropped = 0;
	return nDropped;
}

void CGkUSB::QueueEvent (boolean bAttached, const TGkUSBInfo &rInfo)
{
	if (s_nEventCount == MaxEvents)
	{
		// nobody takes them (no app imports gk:usb): the oldest goes
		s_nEventIn = (s_nEventIn + 1) % MaxEvents;
		s_nEventCount--;
	}
	TGkUSBEvent *pEvent = &s_Events[(s_nEventIn + s_nEventCount) % MaxEvents];
	pEvent->bAttached = bAttached;
	pEvent->Info = rInfo;
	s_nEventCount++;
}

boolean CGkUSB::TakeEvent (TGkUSBEvent *pEvent)
{
	if (s_nEventCount == 0)
	{
		return FALSE;
	}
	*pEvent = s_Events[s_nEventIn];
	s_nEventIn = (s_nEventIn + 1) % MaxEvents;
	s_nEventCount--;
	return TRUE;
}
