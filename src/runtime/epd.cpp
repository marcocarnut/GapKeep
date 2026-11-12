//
// epd.cpp
//
// E-paper panels on SPI0: gapkeep.txt's keys and the driver (epd.h).
//
// The SSD1680 code comes from EPDPages (src/epd.c, revision 241443b, by
// Marco Carnut), copied into GapKeep under GPL-3.0-or-later with its
// author's permission: the panel table's numbers, WeAct's init sequence
// (gate lines, data entry mode X+ Y-, the RAM window from X byte 1, the
// border, update control 1), the B/W panels' temperature sensor and
// display mode 1 (0x22 0xF7), their red RAM filled with the same picture,
// the SSD1683's differences (RAM X from 0, its border and the red RAM
// bypassed), and the reset, BUSY and deep sleep sequence. Changed: whole
// planes from memory instead of bands drawn on an AVR, Circle's SPI and
// GPIO, no partial refresh (a share must be written with the panel's own,
// DC-balanced, full waveform), and the checks for a missing panel.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "epd.h"
#include "../crypto/wipe.h"
#include <circle/spimaster.h>
#include <circle/gpiopin.h>
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>

static const char From[] = "epaper";

// EPDPages' panels[] (src/epd.c), the SSD1680 family's
static const TGkEPDModel Models[] =
{
	// name            module               family        W    H    land red X  refresh timeout
	{"weact-2.9-bwr",  "WeAct 2.9\" B/W/R", GkEPDSSD1680, 128, 296, 1, TRUE,  1, 18100, 40000},
	{"weact-2.13-bw",  "WeAct 2.13\" B/W",  GkEPDSSD1680, 122, 250, 1, FALSE, 1,  3000, 20000},
	{"weact-4.2-bw",   "WeAct 4.2\" B/W",   GkEPDSSD1683, 400, 300, 0, FALSE, 0,  3000, 20000},
};
static const unsigned ModelCount = sizeof Models / sizeof Models[0];

static const unsigned DefaultHz = 4000000;	// 4 MHz: fine over 20 cm of jumper wires
static const unsigned ResetMs = 10;		// RST low, then high, as EPDPages
static const unsigned AnswerMs = 1000;		// the controller's BUSY after a reset
static const unsigned SettleMs = 5;		// after the soft reset, before BUSY tells
static const unsigned NoRefreshMs = 300;	// BUSY never high this long after 0x20: no refresh
static const unsigned ChunkBytes = 512;		// of a plane, per SPI transfer

TGkSPIDevice CGkEPD::s_Panel = {"epaper", 0, 0, 25, 17, 24, DefaultHz};	// Waveshare's pins
CGkEPD *CGkEPD::s_pThis = 0;
boolean CGkEPD::s_bBuiltIn = FALSE;

// --- configuration ---------------------------------------------------------------

boolean GkEPDPinUsable (unsigned nPin)
{
	return    nPin >= 2 && nPin <= 27
	       && !(nPin >= 7 && nPin <= 11)	// SPI0: CE1, CE0, MISO, MOSI, SCLK
	       && nPin != 14 && nPin != 15;	// the serial port
}

const TGkEPDModel *CGkEPD::FindModel (const char *pName)
{
	for (unsigned i = 0; i < ModelCount; i++)
	{
		if (strcmp (Models[i].pName, pName) == 0)
		{
			return &Models[i];
		}
	}
	return 0;
}

const char *CGkEPD::ModelNames (void)
{
	static char Names[128];
	if (Names[0] == '\0')
	{
		for (unsigned i = 0; i < ModelCount; i++)
		{
			if (i > 0)
			{
				strcat (Names, ", ");
			}
			strcat (Names, Models[i].pName);
		}
	}
	return Names;
}

static boolean ParseUnsigned (const char *p, unsigned nMax, unsigned *pOut)
{
	unsigned n = 0;
	if (*p == '\0')
	{
		return FALSE;
	}
	for (; *p != '\0'; p++)
	{
		if (*p < '0' || *p > '9' || n > nMax)
		{
			return FALSE;
		}
		n = n * 10 + (*p - '0');
	}
	if (n > nMax)
	{
		return FALSE;
	}
	*pOut = n;
	return TRUE;
}

boolean CGkEPD::SetModel (const char *pName, const char *pFrom)
{
	if (strcmp (pName, "none") == 0)
	{
		s_Panel.pModel = 0;
		CLogger::Get ()->Write (From, LogNotice, "no panel (%s)", pFrom);
		return TRUE;
	}
	const TGkEPDModel *pModel = FindModel (pName);
	if (pModel == 0)
	{
		return FALSE;
	}
	s_Panel.pModel = pModel;
	return TRUE;
}

boolean CGkEPD::Configure (const char *pKey, const char *pValue, unsigned nLine)
{
	CLogger *pLogger = CLogger::Get ();
	size_t nPrefix = strlen (s_Panel.pKey);
	if (strncmp (pKey, s_Panel.pKey, nPrefix) != 0 || (pKey[nPrefix] != '\0' && pKey[nPrefix] != '_'))
	{
		return FALSE;
	}
	if (s_bBuiltIn)
	{
		pLogger->Write (From, LogWarning, "gapkeep.txt:%u: %s: ignored: the panel is built into this "
				"kernel (EPAPER=%s)", nLine, pKey, s_Panel.pModel != 0 ? s_Panel.pModel->pName : "none");
		return TRUE;
	}
	const char *pWhat = pKey + nPrefix;
	unsigned n;
	if (*pWhat == '\0')
	{
		if (!SetModel (pValue, "gapkeep.txt"))
		{
			pLogger->Write (From, LogWarning, "gapkeep.txt:%u: %s: one of none, %s expected",
					nLine, pKey, ModelNames ());
		}
	}
	else if (strcmp (pWhat, "_cs") == 0)
	{
		if (strcmp (pValue, "ce0") == 0 || strcmp (pValue, "ce1") == 0)
		{
			s_Panel.nCS = pValue[2] - '0';
		}
		else
		{
			pLogger->Write (From, LogWarning, "gapkeep.txt:%u: %s: ce0 or ce1 expected", nLine, pKey);
		}
	}
	else if (   strcmp (pWhat, "_dc") == 0 || strcmp (pWhat, "_rst") == 0
		 || strcmp (pWhat, "_busy") == 0)
	{
		if (ParseUnsigned (pValue, 99, &n) && GkEPDPinUsable (n))
		{
			(pWhat[1] == 'd' ? s_Panel.nDC : pWhat[1] == 'r' ? s_Panel.nRST : s_Panel.nBUSY) = n;
		}
		else
		{
			pLogger->Write (From, LogWarning, "gapkeep.txt:%u: %s: a GPIO number expected, 2 to 27 "
					"but not 7 to 11 (SPI0) nor 14 and 15 (the serial port)", nLine, pKey);
		}
	}
	else if (strcmp (pWhat, "_spi_khz") == 0)
	{
		if (ParseUnsigned (pValue, 20000, &n) && n >= 100)
		{
			s_Panel.nHz = n * 1000;
		}
		else
		{
			pLogger->Write (From, LogWarning, "gapkeep.txt:%u: %s: 100 to 20000 expected", nLine, pKey);
		}
	}
	else
	{
		return FALSE;		// (an unknown key: settings.cpp says so)
	}
	return TRUE;
}

// The build's (make EPAPER=..., tools/epaper_config.py checked the values
// as Configure() would), before gapkeep.txt, which then can't change it.
void CGkEPD::ConfigureBuiltIn (void)
{
#ifdef GK_EPAPER
	static const struct { const char *pKey, *pValue; } Keys[] =
	{
		{"epaper", GK_EPAPER},
#ifdef GK_EPAPER_CS
		{"epaper_cs", GK_EPAPER_CS},
#endif
#ifdef GK_EPAPER_DC
		{"epaper_dc", GK_EPAPER_DC},
#endif
#ifdef GK_EPAPER_RST
		{"epaper_rst", GK_EPAPER_RST},
#endif
#ifdef GK_EPAPER_BUSY
		{"epaper_busy", GK_EPAPER_BUSY},
#endif
#ifdef GK_EPAPER_SPI_KHZ
		{"epaper_spi_khz", GK_EPAPER_SPI_KHZ},
#endif
	};
	for (unsigned i = 0; i < sizeof Keys / sizeof Keys[0]; i++)
	{
		Configure (Keys[i].pKey, Keys[i].pValue, 0);
	}
	CLogger::Get ()->Write (From, LogNotice, "the panel is built in (EPAPER=%s)", GK_EPAPER);
	ConfigDone ();
	s_bBuiltIn = TRUE;
#endif
}

// "weact-2.9-bwr [cs=ce0] [dc=25] [rst=17] [busy=24] [spi_khz=4000]", or
// "none": the panel, as gapkeep.txt's keys would set it (test builds' serial
// line, src/testshot.h: the rig's card never changes). FALSE if refused.
boolean CGkEPD::ConfigureLine (const char *pLine, const char *pFrom)
{
	if (s_bBuiltIn || (s_pThis != 0 && s_pThis->IsBusy ()))
	{
		return FALSE;
	}
	char Line[128];
	strncpy (Line, pLine, sizeof Line - 1);
	Line[sizeof Line - 1] = '\0';
	char *pSave = 0;
	char *pWord = strtok_r (Line, " ", &pSave);
	if (pWord == 0 || !SetModel (pWord, pFrom))
	{
		return FALSE;
	}
	boolean bOK = TRUE;
	while ((pWord = strtok_r (0, " ", &pSave)) != 0)
	{
		char *pValue = strchr (pWord, '=');
		char Key[32];
		if (pValue == 0 || pValue - pWord > 16)
		{
			bOK = FALSE;
			continue;
		}
		*pValue++ = '\0';
		strcpy (Key, "epaper_");
		strcat (Key, pWord);
		if (!Configure (Key, pValue, 0))	// (a bad value: logged)
		{
			bOK = FALSE;		// not one of its keys
		}
	}
	CLogger::Get ()->Write (From, LogNotice, "configured from the %s", pFrom);
	ConfigDone ();
	return bOK;
}

void CGkEPD::ConfigDone (void)
{
	if (s_bBuiltIn)
	{
		return;		// (said when it was built in)
	}
	if (s_Panel.pModel == 0)
	{
		return;
	}
	// one device for now: its own pins must differ (more devices: each
	// one's chip select and pins against the others' too)
	if (   s_Panel.nDC == s_Panel.nRST || s_Panel.nDC == s_Panel.nBUSY
	    || s_Panel.nRST == s_Panel.nBUSY)
	{
		CLogger::Get ()->Write (From, LogWarning, "gapkeep.txt: %s_dc, %s_rst and %s_busy must be "
					"three different GPIOs: no panel", s_Panel.pKey, s_Panel.pKey, s_Panel.pKey);
		s_Panel.pModel = 0;
		return;
	}
	CLogger::Get ()->Write (From, LogNotice, "%s (%ux%u%s) on SPI0 CE%u (GPIO %u), DC GPIO %u, "
				"RST GPIO %u, BUSY GPIO %u, %u kHz", s_Panel.pModel->pModule,
				s_Panel.pModel->nWidth, s_Panel.pModel->nHeight,
				s_Panel.pModel->bRed ? ", red" : "", s_Panel.nCS, s_Panel.nCS ? 7 : 8,
				s_Panel.nDC, s_Panel.nRST, s_Panel.nBUSY, s_Panel.nHz / 1000);
}

const TGkSPIDevice *CGkEPD::GetPanel (void)
{
	return s_Panel.pModel != 0 ? &s_Panel : 0;
}

// --- the driver ------------------------------------------------------------------

CGkEPD *CGkEPD::Get (void)
{
	if (s_Panel.pModel == 0)
	{
		return 0;
	}
	if (s_pThis != 0 && s_pThis->m_pModel != s_Panel.pModel)
	{
		if (s_pThis->IsBusy ())
		{
			return 0;		// (the simulator changed the model meanwhile)
		}
		delete s_pThis;
		s_pThis = 0;
	}
	if (s_pThis == 0)
	{
		s_pThis = new CGkEPD (&s_Panel);
	}
	return s_pThis;
}

CGkEPD::CGkEPD (const TGkSPIDevice *pDevice)
:	m_pDevice (pDevice),
	m_pModel (pDevice->pModel),
	m_nRowBytes ((pDevice->pModel->nWidth + 7) / 8),
	m_pSPI (0),
	m_pDC (0), m_pRST (0), m_pBusy (0),
	m_State (StateIdle),
	m_nStateStart (0), m_nStateMs (0),
	m_pPlanes (0),
	m_nPlane (0), m_nRow (0),
	m_bSeenBusy (FALSE),
	m_bDone (FALSE),
	m_nRefreshStart (0),
	m_pError (0)
{
}

CGkEPD::~CGkEPD (void)
{
	Abort ();
}

boolean CGkEPD::Busy (void) const
{
	return m_pBusy->Read () == HIGH;	// the SSD1680's BUSY: high while busy
}

void CGkEPD::Command (u8 nCommand, const u8 *pData, unsigned nLength)
{
	m_pDC->Write (LOW);
	m_pSPI->Write (m_pDevice->nCS, &nCommand, 1);
	m_pDC->Write (HIGH);
	if (nLength > 0)
	{
		Data (pData, nLength);
	}
}

void CGkEPD::Data (const u8 *pData, unsigned nLength)
{
	m_pSPI->Write (m_pDevice->nCS, pData, nLength);
}

// EPDPages' ssd_setup() for a full refresh of the whole panel, after the
// soft reset: the gate lines, data entry mode X+ Y- (native row r is RAM
// line r, Y counted down from the last row), the RAM window, then WeAct's
// border and update control 1 (the SSD1683's: its border, the red RAM
// bypassed as 0, so the OTP's full waveform takes the new data alone), and
// a B/W panel's internal temperature sensor.
void CGkEPD::Setup (void)
{
	unsigned nLast = m_pModel->nHeight - 1;
	u8 Gates[3] = {(u8) (nLast & 0xFF), (u8) (nLast >> 8), 0x00};
	Command (0x01, Gates, 3);
	Command1 (0x11, 0x01);					// X+ Y-
	u8 X[2] = {(u8) m_pModel->nXStart, (u8) (m_pModel->nXStart + m_nRowBytes - 1)};
	Command (0x44, X, 2);
	u8 Y[4] = {(u8) (nLast & 0xFF), (u8) (nLast >> 8), 0, 0};
	Command (0x45, Y, 4);
	if (m_pModel->Family == GkEPDSSD1683)
	{
		Command1 (0x3C, 0x01);				// border
		u8 Update[2] = {0x40, 0x00};			// the red RAM bypassed as 0
		Command (0x21, Update, 2);
	}
	else
	{
		Command1 (0x3C, 0x05);				// border (WeAct's)
		u8 Update[2] = {0x00, 0x00};			// the red RAM normal
		Command (0x21, Update, 2);
	}
	if (!m_pModel->bRed)
	{
		Command1 (0x18, 0x80);				// internal temperature sensor
	}
}

// The planes' rows, the last first (Y counts down), the B/W RAM (0x24)
// then the red (0x26: a B/W panel's gets the same picture, the "old data"
// a full refresh doesn't use), until the deadline. TRUE: both sent.
boolean CGkEPD::SendRows (unsigned nDeadline)
{
	unsigned nHeight = m_pModel->nHeight;
	unsigned nPlaneBytes = m_nRowBytes * nHeight;
	while (m_nPlane < 2)
	{
		if (m_nRow == 0)
		{
			unsigned nLast = nHeight - 1;
			Command1 (0x4E, (u8) m_pModel->nXStart);
			u8 Y[2] = {(u8) (nLast & 0xFF), (u8) (nLast >> 8)};
			Command (0x4F, Y, 2);
			Command (m_nPlane == 0 ? 0x24 : 0x26);
		}
		const u8 *pPlane = m_pPlanes + (m_nPlane == 1 && m_pModel->bRed ? nPlaneBytes : 0);

		// rows, the last first: as many as fit a chunk
		u8 Chunk[ChunkBytes];
		unsigned nRows = ChunkBytes / m_nRowBytes;
		if (nRows > nHeight - m_nRow)
		{
			nRows = nHeight - m_nRow;
		}
		for (unsigned i = 0; i < nRows; i++)
		{
			unsigned y = nHeight - 1 - (m_nRow + i);
			memcpy (Chunk + i * m_nRowBytes, pPlane + y * m_nRowBytes, m_nRowBytes);
		}
		Data (Chunk, nRows * m_nRowBytes);
		gk_wipe (Chunk, sizeof Chunk);
		m_nRow += nRows;
		if (m_nRow == nHeight)
		{
			m_nRow = 0;
			m_nPlane++;
		}
		if ((int) (CTimer::GetClockTicks () - nDeadline) >= 0)
		{
			break;
		}
	}
	return m_nPlane == 2;
}

boolean CGkEPD::Start (const u8 *pBW, const u8 *pRed)
{
	if (IsBusy ())
	{
		return FALSE;
	}
	if (!TakeLines ())
	{
		m_pError = "SPI0 did not start";
		return FALSE;
	}

	unsigned nPlane = m_nRowBytes * m_pModel->nHeight;
	unsigned nBytes = nPlane * (m_pModel->bRed ? 2 : 1);
	m_pPlanes = new u8[nBytes];
	memcpy (m_pPlanes, pBW, nPlane);
	if (m_pModel->bRed)
	{
		memcpy (m_pPlanes + nPlane, pRed, nPlane);
	}
	m_nPlane = 0;
	m_nRow = 0;
	m_bSeenBusy = FALSE;
	m_bDone = FALSE;
	m_bWaitSawBusy = FALSE;
	m_pError = 0;
	m_nResetStart = CTimer::GetClockTicks ();

	// a hardware reset, always (TakeLines() set RST low): it may be another
	// panel than last time, and a panel in deep sleep hears nothing else
	Next (StateResetLow, ResetMs);
	CLogger::Get ()->Write (From, LogNotice, "%s: refresh: reset", m_pModel->pModule);
	return TRUE;
}

void CGkEPD::Next (int State, unsigned nMs)
{
	m_State = State;
	m_nStateStart = CTimer::GetClockTicks ();
	m_nStateMs = nMs;
}

boolean CGkEPD::Settled (void) const
{
	return CTimer::GetClockTicks () - m_nStateStart >= SettleMs * (CLOCKHZ / 1000);
}

boolean CGkEPD::Due (void) const
{
	return CTimer::GetClockTicks () - m_nStateStart >= m_nStateMs * (CLOCKHZ / 1000);
}

// SPI0's pins and the panel's own, for a refresh: DC high, RST low (in
// reset), BUSY pulled up (without a panel, it reads busy).
boolean CGkEPD::TakeLines (void)
{
	m_pSPI = new CSPIMaster (m_pDevice->nHz, 0, 0);	// mode 0
	if (!m_pSPI->Initialize ())
	{
		delete m_pSPI;
		m_pSPI = 0;
		return FALSE;
	}
	m_pDC = new CGPIOPin (m_pDevice->nDC, GPIOModeOutput);
	m_pDC->Write (HIGH);
	m_pRST = new CGPIOPin (m_pDevice->nRST, GPIOModeOutput);
	m_pRST->Write (LOW);
	m_pBusy = new CGPIOPin (m_pDevice->nBUSY, GPIOModeInputPullUp);
	return TRUE;
}

// ...and back to inputs, after a refresh: between refreshes nothing drives
// the panel's lines, so a panel plugged in or out then gets nothing but
// its 3.3 V (no current into an unpowered controller through its inputs).
void CGkEPD::ReleaseLines (void)
{
	delete m_pSPI;			// SCLK, MOSI, MISO, CE0 and CE1: inputs
	m_pSPI = 0;
	CGPIOPin **Pins[3] = {&m_pDC, &m_pRST, &m_pBusy};
	for (unsigned i = 0; i < 3; i++)
	{
		if (*Pins[i] != 0)
		{
			(*Pins[i])->SetMode (GPIOModeInput);
			delete *Pins[i];
			*Pins[i] = 0;
		}
	}
}

void CGkEPD::FreePlanes (void)
{
	if (m_pPlanes != 0)
	{
		unsigned nPlane = m_nRowBytes * m_pModel->nHeight;
		gk_wipe (m_pPlanes, nPlane * (m_pModel->bRed ? 2 : 1));
		delete [] m_pPlanes;
		m_pPlanes = 0;
	}
	ReleaseLines ();
}

void CGkEPD::Fail (const char *pError)
{
	m_pError = pError;
	CLogger::Get ()->Write (From, LogWarning, "%s: %s", m_pModel->pModule, pError);
	m_State = StateIdle;
	FreePlanes ();
}

void CGkEPD::Abort (void)
{
	if (m_State != StateIdle)
	{
		CLogger::Get ()->Write (From, LogNotice, "%s: refresh abandoned (its app stopped)",
					m_pModel->pModule);
	}
	m_State = StateIdle;
	FreePlanes ();
}

int CGkEPD::Step (unsigned nDeadline)
{
	for (;;)
	{
		switch (m_State)
		{
		case StateIdle:
			return m_pError != 0 ? -1 : 0;

		case StateResetLow:
			if (!Due ())
			{
				return 1;
			}
			m_pRST->Write (HIGH);
			Next (StateResetHigh, ResetMs);
			return 1;

		case StateResetHigh:
			if (!Due ())
			{
				return 1;
			}
			Next (StateWaitReset, AnswerMs);
			break;

		case StateWaitReset:
		case StateWaitSoft:
			if (m_State == StateWaitSoft && !Settled ())
			{
				return 1;	// (BUSY goes up after the command)
			}
			if (Busy ())
			{
				m_bWaitSawBusy = TRUE;
				if (Due ())
				{
					// pulled up: no panel at all, or one that doesn't answer
					Fail (m_State == StateWaitReset
					      ? "no panel answers: is one plugged in? (BUSY stays high after a reset)"
					      : "the panel stopped answering (BUSY stays high after its soft reset)");
					return -1;
				}
				return 1;
			}
			if (m_State == StateWaitReset)
			{
				m_nResetUs = CTimer::GetClockTicks () - m_nStateStart;
				m_bResetSawBusy = m_bWaitSawBusy;
				m_bWaitSawBusy = FALSE;
				Command (0x12);				// soft reset
				Next (StateWaitSoft, AnswerMs);
				break;
			}
			m_nSoftUs = CTimer::GetClockTicks () - m_nStateStart;
			Setup ();
			Next (StatePlane, 0);
			break;

		case StatePlane:
			if (!SendRows (nDeadline))
			{
				return 1;
			}
			{
				unsigned nPlane = m_nRowBytes * m_pModel->nHeight;
				gk_wipe (m_pPlanes, nPlane * (m_pModel->bRed ? 2 : 1));	// the panel has them
			}
			if (!m_pModel->bRed)
			{
				Command1 (0x22, 0xF7);			// display mode 1, then off
			}
			Command (0x20);					// refresh
			m_nRefreshStart = CTimer::GetClockTicks ();
			m_nBusyHighUs = 0;
			// BUSY's timings, for the hardware's record (docs/EPAPER.md)
			CLogger::Get ()->Write (From, LogNotice, "%s: refresh: BUSY low %u us after the reset (%s), "
						"%u us after the soft reset (%s); planes sent in %u us",
						m_pModel->pModule, m_nResetUs, m_bResetSawBusy ? "seen high" : "never seen high",
						m_nSoftUs, m_bWaitSawBusy ? "seen high" : "never seen high",
						m_nRefreshStart - m_nStateStart);
			Next (StateRefresh, m_pModel->nTimeoutMs);
			CLogger::Get ()->Write (From, LogNotice, "%s: refresh: sent, the waveform runs",
						m_pModel->pModule);
			return 1;

		case StateRefresh:
			if (Busy ())
			{
				if (!m_bSeenBusy)
				{
					m_nBusyHighUs = CTimer::GetClockTicks () - m_nRefreshStart;
				}
				m_bSeenBusy = TRUE;
				if (Due ())
				{
					Fail ("the panel did not finish its refresh: was it unplugged?");
					return -1;
				}
				return 1;
			}
			if (!m_bSeenBusy)
			{
				if (CTimer::GetClockTicks () - m_nRefreshStart < NoRefreshMs * (CLOCKHZ / 1000))
				{
					return 1;	// BUSY may not be up yet
				}
				Fail ("the panel did not refresh (BUSY never went high): is it plugged in?");
				return -1;
			}
			Command1 (0x10, 0x01);				// deep sleep
			CLogger::Get ()->Write (From, LogNotice, "%s: refresh: done in %u ms (BUSY high %u us after "
						"0x20), asleep; %u ms since the reset", m_pModel->pModule,
						(CTimer::GetClockTicks () - m_nRefreshStart) / (CLOCKHZ / 1000), m_nBusyHighUs,
						(CTimer::GetClockTicks () - m_nResetStart) / (CLOCKHZ / 1000));
			m_State = StateIdle;
			FreePlanes ();
			m_bDone = TRUE;
			return 0;
		}
		if ((int) (CTimer::GetClockTicks () - nDeadline) >= 0)
		{
			return 1;
		}
	}
}

double CGkEPD::GetProgress (void) const
{
	unsigned nPlane = m_nRowBytes * m_pModel->nHeight;
	switch (m_State)
	{
	case StatePlane:
		return 0.02 + 0.03 * (double) (m_nPlane * nPlane + m_nRow * m_nRowBytes) / (2 * nPlane);
	case StateRefresh:
	{
		double f = (double) (CTimer::GetClockTicks () - m_nRefreshStart)
			   / ((double) m_pModel->nRefreshMs * (CLOCKHZ / 1000));
		return 0.05 + 0.94 * (f < 1 ? f : 1);
	}
	case StateIdle:
		return m_bDone ? 1 : 0;
	default:
		return 0.01;
	}
}
