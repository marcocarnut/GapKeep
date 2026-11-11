//
// usbip.cpp - the simulator's USB devices: imported over USB/IP.
//
// USB/IP (the Linux kernel's Documentation/usb/usbip_protocol.rst) carries
// USB requests over TCP. A server offers devices by bus id; a client
// imports one and sends it URBs. Here the simulator is the client, and an
// imported device is a device plugged into GapKeep, claimed as on the Pi
// (src/runtime/usb.h): any device a USB/IP server offers, real (Linux's
// usbipd) or simulated, so apps using gk:usb can be tried and tested.
//
// An attachment is a cable that stays plugged in: when the server closes
// the connection (the device was unplugged, or reset and enumerates
// again), the device is detached, and the import is tried again every
// RetryMs until it comes back, possibly as another device under the same
// bus id. "usbip detach" pulls the cable.
//
// Only what gk:usb needs: control transfers on endpoint 0. The server has
// set the device's address; this sets its configuration, as Circle does
// on the Pi, before gk:usb reads its descriptors. A transfer waits for its
// answer, as on the Pi, at most its timeout; then it is unlinked, and the
// answer, if it comes, dropped. A server that breaks the protocol (an
// unknown reply, more data than asked for) is disconnected.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "sim.h"
#include "../../src/runtime/usb.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static const char From[] = "usbip";

static const unsigned MaxCables = GK_USB_MAX_DEVICES;
static const unsigned RetryMs = 300;
static const unsigned ConnectTimeoutMs = 1000;
static const unsigned ReplyTimeoutMs = 2000;		// to the import
static const unsigned MaxStale = 16;			// unlinked transfers whose answer may come

#define USBIP_VERSION		0x0111
#define OP_REQ_DEVLIST		0x8005
#define OP_REP_DEVLIST		0x0005
#define OP_REQ_IMPORT		0x8003
#define OP_REP_IMPORT		0x0003
#define USBIP_CMD_SUBMIT	1
#define USBIP_CMD_UNLINK	2
#define USBIP_RET_SUBMIT	3
#define USBIP_RET_UNLINK	4
#define USBIP_DEVICE_SIZE	312		// struct usbip_usb_device
#define USBIP_HEADER_SIZE	48
#define EPIPE_STATUS		(-32)		// -EPIPE: a stall

static void Put32 (u8 *p, u32 n)	{ p[0] = n >> 24; p[1] = n >> 16; p[2] = n >> 8; p[3] = n; }
static void Put16 (u8 *p, u16 n)	{ p[0] = n >> 8; p[1] = n; }
static u32 Get32 (const u8 *p)		{ return (u32) p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }
static u16 Get16 (const u8 *p)		{ return (u16) (p[0] << 8 | p[1]); }

static unsigned Now (void)		{ return CTimer::GetClockTicks (); }

// a connection to host:port, or -1
static int Connect (const char *pHost, unsigned nPort)
{
	char Port[8];
	snprintf (Port, sizeof Port, "%u", nPort);
	struct addrinfo Hints, *pResult;
	memset (&Hints, 0, sizeof Hints);
	Hints.ai_family = AF_UNSPEC;
	Hints.ai_socktype = SOCK_STREAM;
	if (getaddrinfo (pHost, Port, &Hints, &pResult) != 0)
	{
		return -1;
	}
	int fd = -1;
	for (struct addrinfo *p = pResult; p != 0 && fd < 0; p = p->ai_next)
	{
		fd = socket (p->ai_family, p->ai_socktype, p->ai_protocol);
		if (fd < 0)
		{
			continue;
		}
		fcntl (fd, F_SETFL, fcntl (fd, F_GETFL) | O_NONBLOCK);
		int nResult = connect (fd, p->ai_addr, p->ai_addrlen);
		if (nResult < 0 && errno == EINPROGRESS)
		{
			struct pollfd Poll = {fd, POLLOUT, 0};
			int nError = 0;
			socklen_t nSize = sizeof nError;
			if (   poll (&Poll, 1, ConnectTimeoutMs) == 1
			    && getsockopt (fd, SOL_SOCKET, SO_ERROR, &nError, &nSize) == 0
			    && nError == 0)
			{
				nResult = 0;
			}
		}
		if (nResult < 0)
		{
			close (fd);
			fd = -1;
		}
	}
	freeaddrinfo (pResult);
	return fd;
}

// n bytes, by the deadline (Now() ticks); FALSE if they don't come, or the
// connection closes (then *pClosed)
static boolean RecvAll (int fd, u8 *p, size_t n, unsigned nDeadline, boolean *pClosed = 0)
{
	while (n > 0)
	{
		int nLeft = (int) (nDeadline - Now ());
		struct pollfd Poll = {fd, POLLIN, 0};
		if (nLeft <= 0 || poll (&Poll, 1, (nLeft + 999) / 1000) != 1)
		{
			return FALSE;
		}
		ssize_t k = recv (fd, p, n, 0);
		if (k <= 0)
		{
			if (k == 0 || (errno != EAGAIN && errno != EINTR))
			{
				if (pClosed != 0)
				{
					*pClosed = TRUE;
				}
				return FALSE;
			}
			continue;
		}
		p += k;
		n -= k;
	}
	return TRUE;
}

static boolean SendAll (int fd, const u8 *p, size_t n)
{
	while (n > 0)
	{
		struct pollfd Poll = {fd, POLLOUT, 0};
		if (poll (&Poll, 1, ConnectTimeoutMs) != 1)
		{
			return FALSE;
		}
		ssize_t k = send (fd, p, n, MSG_NOSIGNAL);
		if (k <= 0)
		{
			if (k < 0 && (errno == EAGAIN || errno == EINTR))
			{
				continue;
			}
			return FALSE;
		}
		p += k;
		n -= k;
	}
	return TRUE;
}

class CGkUSBIPCable : public CGkUSBPort
{
public:
	CGkUSBIPCable (const char *pHost, unsigned nPort, const char *pBusID)
	:	m_nPort (nPort), m_fd (-1), m_bClaimed (FALSE), m_nNextTry (Now ()),
		m_bSaidWaiting (FALSE), m_nSeq (0), m_nStale (0)
	{
		snprintf (m_Host, sizeof m_Host, "%s", pHost);
		snprintf (m_BusID, sizeof m_BusID, "%s", pBusID ? pBusID : "");
		m_bAnyBusID = m_BusID[0] == '\0';
	}

	~CGkUSBIPCable (void)
	{
		Unplug (FALSE);
	}

	const char *GetBusID (void) const	{ return m_BusID; }
	boolean Matches (const char *pBusID) const
	{
		return pBusID == 0 || strcmp (pBusID, m_BusID) == 0;
	}

	void Poll (void)
	{
		if (m_fd < 0)
		{
			if ((int) (Now () - m_nNextTry) >= 0)
			{
				Import ();
			}
			return;
		}
		// between transfers: late answers to unlinked ones, or a close
		struct pollfd Poll = {m_fd, POLLIN, 0};
		while (m_fd >= 0 && poll (&Poll, 1, 0) == 1)
		{
			if (!TakeReply (0, 0, 0, Now () + ReplyTimeoutMs * (CLOCKHZ / 1000)))
			{
				Unplug (TRUE);
			}
		}
	}

	int Control (u8 ucRequestType, u8 ucRequest, u16 usValue, u16 usIndex,
		     u8 *pData, u16 usLength, unsigned nTimeoutMs)
	{
		if (m_fd < 0)
		{
			return GkUSBGone;
		}
		boolean bIn = (ucRequestType & GK_USB_DIR_IN) != 0;
		u32 nSeq = ++m_nSeq;
		u8 Header[USBIP_HEADER_SIZE + GK_USB_MAX_CONFIG_SIZE];
		memset (Header, 0, USBIP_HEADER_SIZE);
		Put32 (Header + 0, USBIP_CMD_SUBMIT);
		Put32 (Header + 4, nSeq);
		Put32 (Header + 8, m_nDevID);
		Put32 (Header + 12, bIn ? 1 : 0);
		Put32 (Header + 16, 0);				// endpoint 0
		Put32 (Header + 24, usLength);			// transfer_buffer_length
		u8 *pSetup = Header + 40;			// little-endian, as on the bus
		pSetup[0] = ucRequestType;
		pSetup[1] = ucRequest;
		pSetup[2] = usValue; pSetup[3] = usValue >> 8;
		pSetup[4] = usIndex; pSetup[5] = usIndex >> 8;
		pSetup[6] = usLength; pSetup[7] = usLength >> 8;
		size_t nSend = USBIP_HEADER_SIZE;
		if (!bIn && usLength > 0)
		{
			if (usLength > GK_USB_MAX_CONFIG_SIZE)
			{
				return GkUSBError;
			}
			memcpy (Header + nSend, pData, usLength);
			nSend += usLength;
		}
		boolean bSent = SendAll (m_fd, Header, nSend);
		memset (Header, 0, nSend);			// it may have held an app's data
		if (!bSent)
		{
			Unplug (TRUE);
			return GkUSBGone;
		}

		unsigned nDeadline = Now () + nTimeoutMs * (CLOCKHZ / 1000);
		int nResult = GkUSBTimeout;
		m_nWaitSeq = nSeq;
		m_bWaitIn = bIn;
		m_bAnswered = FALSE;
		while (m_fd >= 0 && !m_bAnswered)
		{
			struct pollfd Poll = {m_fd, POLLIN, 0};
			int nLeft = (int) (nDeadline - Now ());
			if (nLeft <= 0 || poll (&Poll, 1, (nLeft + 999) / 1000) != 1)
			{
				break;
			}
			if (!TakeReply (pData, usLength, &nResult, Now () + ReplyTimeoutMs * (CLOCKHZ / 1000)))
			{
				Unplug (TRUE);
				return GkUSBGone;
			}
		}
		m_nWaitSeq = 0;
		if (m_fd < 0)
		{
			return GkUSBGone;
		}
		if (!m_bAnswered)
		{
			Unlink (nSeq, bIn);
			return GkUSBTimeout;
		}
		return nResult;
	}

	TGkUSBSpeed GetSpeed (void) const	{ return m_Speed; }

private:
	// Reads one reply: the one Control() waits for (m_nWaitSeq), into
	// pData, or a late one, dropped. FALSE: the connection is no good.
	boolean TakeReply (u8 *pData, u16 usLength, int *pResult, unsigned nDeadline)
	{
		u8 Header[USBIP_HEADER_SIZE];
		boolean bClosed = FALSE;
		if (!RecvAll (m_fd, Header, sizeof Header, nDeadline, &bClosed))
		{
			if (!bClosed)
			{
				CLogger::Get ()->Write (From, LogWarning, "%s: a reply cut short", m_BusID);
			}
			return FALSE;
		}
		u32 nCommand = Get32 (Header), nSeq = Get32 (Header + 4);
		if (nCommand == USBIP_RET_UNLINK)
		{
			ForgetStale (nSeq);	// what remains of it, if anything
			return TRUE;
		}
		if (nCommand != USBIP_RET_SUBMIT)
		{
			CLogger::Get ()->Write (From, LogWarning, "%s: unknown reply %u", m_BusID, nCommand);
			return FALSE;
		}
		int nStatus = (int) Get32 (Header + 20);
		u32 nActual = Get32 (Header + 24);

		boolean bMine = m_nWaitSeq != 0 && nSeq == m_nWaitSeq;
		boolean bIn;
		if (bMine)
		{
			bIn = m_bWaitIn;
		}
		else if (!TakeStale (nSeq, &bIn))
		{
			CLogger::Get ()->Write (From, LogWarning, "%s: a reply to no request", m_BusID);
			return FALSE;
		}
		u32 nData = bIn && nStatus == 0 ? nActual : 0;	// OUT: no data comes back
		if (nData > GK_USB_MAX_CONFIG_SIZE)
		{
			CLogger::Get ()->Write (From, LogWarning, "%s: a reply of %u bytes", m_BusID, nData);
			return FALSE;
		}
		u8 Data[GK_USB_MAX_CONFIG_SIZE];
		if (nData > 0 && !RecvAll (m_fd, Data, nData, nDeadline))
		{
			return FALSE;
		}
		if (bMine)
		{
			m_bAnswered = TRUE;
			if (nStatus == EPIPE_STATUS)
			{
				*pResult = GkUSBStall;
			}
			else if (nStatus != 0)
			{
				*pResult = GkUSBError;
			}
			else if (nActual > usLength)
			{
				// more than was asked for: refused, as the Pi's host
				// controller (patches/circle/0008) never writes it
				CLogger::Get ()->Write (From, LogWarning, "%s: %u bytes for %u asked",
							m_BusID, nActual, usLength);
				*pResult = GkUSBError;
			}
			else
			{
				if (bIn)
				{
					memcpy (pData, Data, nData);
				}
				*pResult = (int) nActual;
			}
		}
		memset (Data, 0, nData);
		return TRUE;
	}

	void Unlink (u32 nSeq, boolean bIn)
	{
		u8 Header[USBIP_HEADER_SIZE];
		memset (Header, 0, sizeof Header);
		Put32 (Header + 0, USBIP_CMD_UNLINK);
		u32 nUnlinkSeq = ++m_nSeq;
		Put32 (Header + 4, nUnlinkSeq);
		Put32 (Header + 8, m_nDevID);
		Put32 (Header + 20, nSeq);
		if (!SendAll (m_fd, Header, sizeof Header))
		{
			Unplug (TRUE);
			return;
		}
		// its answer may still come (before the unlink's)
		if (m_nStale == MaxStale)
		{
			memmove (m_Stale, m_Stale + 1, (MaxStale - 1) * sizeof m_Stale[0]);
			m_nStale--;
		}
		m_Stale[m_nStale].nSeq = nSeq;
		m_Stale[m_nStale].nUnlinkSeq = nUnlinkSeq;
		m_Stale[m_nStale].bIn = bIn;
		m_nStale++;
	}

	boolean TakeStale (u32 nSeq, boolean *pIn)
	{
		for (unsigned i = 0; i < m_nStale; i++)
		{
			if (m_Stale[i].nSeq == nSeq)
			{
				*pIn = m_Stale[i].bIn;
				m_Stale[i] = m_Stale[--m_nStale];
				return TRUE;
			}
		}
		return FALSE;
	}

	// RET_UNLINK: the transfer it unlinked was answered before, or never will be
	void ForgetStale (u32 nUnlinkSeq)
	{
		for (unsigned i = 0; i < m_nStale; i++)
		{
			if (m_Stale[i].nUnlinkSeq == nUnlinkSeq)
			{
				m_Stale[i] = m_Stale[--m_nStale];
				return;
			}
		}
	}

	// the first bus id the server lists, into m_BusID
	boolean FindBusID (void)
	{
		int fd = Connect (m_Host, m_nPort);
		if (fd < 0)
		{
			return FALSE;
		}
		u8 Request[8];
		Put16 (Request, USBIP_VERSION);
		Put16 (Request + 2, OP_REQ_DEVLIST);
		Put32 (Request + 4, 0);
		u8 Reply[12], Device[USBIP_DEVICE_SIZE];
		unsigned nDeadline = Now () + ReplyTimeoutMs * (CLOCKHZ / 1000);
		boolean bOK =    SendAll (fd, Request, sizeof Request)
			      && RecvAll (fd, Reply, sizeof Reply, nDeadline)
			      && Get16 (Reply + 2) == OP_REP_DEVLIST && Get32 (Reply + 4) == 0
			      && Get32 (Reply + 8) > 0
			      && RecvAll (fd, Device, sizeof Device, nDeadline);
		close (fd);
		if (bOK)
		{
			memcpy (m_BusID, Device + 256, 31);
			m_BusID[31] = '\0';
			bOK = m_BusID[0] != '\0';
		}
		return bOK;
	}

	void Import (void)
	{
		m_nNextTry = Now () + RetryMs * (CLOCKHZ / 1000);
		if (m_bAnyBusID && !FindBusID ())
		{
			Waiting ("no device offered");
			return;
		}
		int fd = Connect (m_Host, m_nPort);
		if (fd < 0)
		{
			Waiting ("no USB/IP server");
			return;
		}
		u8 Request[8 + 32];
		memset (Request, 0, sizeof Request);
		Put16 (Request, USBIP_VERSION);
		Put16 (Request + 2, OP_REQ_IMPORT);
		memcpy (Request + 8, m_BusID, strlen (m_BusID));	// < 32: NUL-padded
		u8 Reply[8], Device[USBIP_DEVICE_SIZE];
		unsigned nDeadline = Now () + ReplyTimeoutMs * (CLOCKHZ / 1000);
		if (   !SendAll (fd, Request, sizeof Request)
		    || !RecvAll (fd, Reply, sizeof Reply, nDeadline)
		    || Get16 (Reply + 2) != OP_REP_IMPORT
		    || Get32 (Reply + 4) != 0
		    || !RecvAll (fd, Device, sizeof Device, nDeadline))
		{
			close (fd);
			Waiting ("not offered");
			return;
		}
		m_bSaidWaiting = FALSE;
		m_fd = fd;
		m_nSeq = 0;
		m_nStale = 0;
		m_nDevID = Get32 (Device + 288) << 16 | (Get32 (Device + 292) & 0xFFFF);
		u32 nSpeed = Get32 (Device + 296);
		m_Speed =   nSpeed == 1 ? GkUSBSpeedLow : nSpeed == 3 ? GkUSBSpeedHigh
			  : nSpeed >= 5 ? GkUSBSpeedSuper : GkUSBSpeedFull;
		u16 usVendor = Get16 (Device + 300), usProduct = Get16 (Device + 302);
		CLogger::Get ()->Write (From, LogNotice, "%s:%u %s: imported %04x:%04x", m_Host, m_nPort,
					m_BusID, usVendor, usProduct);

		// plugged in: claimed, as on the Pi, if an app lists it. Otherwise
		// it stays imported, unused: the simulator has no other driver.
		if (CGkUSB::Claimant (usVendor, usProduct) == 0)
		{
			CLogger::Get ()->Write (From, LogNotice, "%04x:%04x: no app lists it:"
						" not claimed (and the simulator has no other driver)",
						usVendor, usProduct);
			return;
		}
		u8 Config[9];
		int n = Control (GK_USB_DIR_IN, 6, 0x0200, 0, Config, sizeof Config, 500);
		if (   m_fd >= 0
		    && (   n != (int) sizeof Config
			|| Control (0, 9, Config[5], 0, 0, 0, 500) < 0))		// SET_CONFIGURATION
		{
			CLogger::Get ()->Write (From, LogWarning, "%04x:%04x: cannot set its configuration",
						usVendor, usProduct);
			return;
		}
		if (m_fd >= 0)
		{
			m_bClaimed = CGkUSB::Attach (this);
		}
	}

	void Waiting (const char *pWhy)
	{
		if (!m_bSaidWaiting)
		{
			CLogger::Get ()->Write (From, LogNotice, "%s:%u %s: %s, trying again every %u ms",
						m_Host, m_nPort, m_bAnyBusID ? "(any device)" : m_BusID,
						pWhy, RetryMs);
			m_bSaidWaiting = TRUE;
		}
		if (m_bAnyBusID)
		{
			m_BusID[0] = '\0';
		}
	}

	void Unplug (boolean bLog)
	{
		if (m_fd < 0)
		{
			return;
		}
		if (m_bClaimed)
		{
			CGkUSB::Detach (this);
			m_bClaimed = FALSE;
		}
		close (m_fd);
		m_fd = -1;
		m_nNextTry = Now () + RetryMs * (CLOCKHZ / 1000);
		if (bLog)
		{
			CLogger::Get ()->Write (From, LogNotice, "%s: disconnected by the server (unplugged)",
						m_BusID);
		}
		if (m_bAnyBusID)
		{
			m_BusID[0] = '\0';
		}
	}

private:
	char m_Host[256];
	unsigned m_nPort;
	char m_BusID[32];
	boolean m_bAnyBusID;
	int m_fd;
	boolean m_bClaimed;
	unsigned m_nNextTry;
	boolean m_bSaidWaiting;
	u32 m_nDevID;
	TGkUSBSpeed m_Speed;
	u32 m_nSeq;

	u32 m_nWaitSeq = 0;		// the transfer Control() waits for
	boolean m_bWaitIn = FALSE;
	boolean m_bAnswered = FALSE;

	struct { u32 nSeq, nUnlinkSeq; boolean bIn; } m_Stale[MaxStale];
	unsigned m_nStale;
};

static CGkUSBIPCable *s_pCables[MaxCables];

int gk_sim_usbip_attach (const char *pHost, unsigned nPort, const char *pBusID)
{
	for (unsigned i = 0; i < MaxCables; i++)
	{
		if (s_pCables[i] == 0)
		{
			s_pCables[i] = new CGkUSBIPCable (pHost, nPort, pBusID);
			s_pCables[i]->Poll ();
			return 0;
		}
	}
	return -1;
}

int gk_sim_usbip_detach (const char *pBusID)
{
	int nResult = -1;
	for (unsigned i = 0; i < MaxCables; i++)
	{
		if (s_pCables[i] != 0 && s_pCables[i]->Matches (pBusID))
		{
			CLogger::Get ()->Write (From, LogNotice, "%s: detached (the cable pulled)",
						s_pCables[i]->GetBusID ());
			delete s_pCables[i];
			s_pCables[i] = 0;
			nResult = 0;
		}
	}
	return nResult;
}

void GkSimUSBIPPoll (void)
{
	for (unsigned i = 0; i < MaxCables; i++)
	{
		if (s_pCables[i] != 0)
		{
			s_pCables[i]->Poll ();
		}
	}
}
