//
// unicam.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "unicam.h"
#include <circle/bcm2835.h>
#include <circle/bcm2835int.h>
#include <circle/bcmpropertytags.h>
#include <circle/interrupt.h>
#include <circle/logger.h>
#include <circle/machineinfo.h>
#include <circle/memio.h>
#include <circle/synchronize.h>
#include <circle/timer.h>
#include <circle/alloc.h>
#include <circle/util.h>
#include <assert.h>

static const char FromUnicam[] = "unicam";

// Unicam1's registers (SPEC 5.2), and the lane clock gate of CSI port 1
// (SPEC 3.4): neither is in Broadcom's public documentation.
#define UNICAM_BASE		(ARM_IO_BASE + 0x801000)
#define UNICAM_CTRL		(UNICAM_BASE + 0x000)
#define UNICAM_STA		(UNICAM_BASE + 0x004)
#define UNICAM_ANA		(UNICAM_BASE + 0x008)
#define UNICAM_PRI		(UNICAM_BASE + 0x00C)
#define UNICAM_CLK		(UNICAM_BASE + 0x010)
#define UNICAM_CLT		(UNICAM_BASE + 0x014)
#define UNICAM_DAT0		(UNICAM_BASE + 0x018)
#define UNICAM_DAT1		(UNICAM_BASE + 0x01C)
#define UNICAM_DLT		(UNICAM_BASE + 0x028)
#define UNICAM_CMP0		(UNICAM_BASE + 0x02C)
#define UNICAM_ICTL		(UNICAM_BASE + 0x100)
#define UNICAM_ISTA		(UNICAM_BASE + 0x104)
#define UNICAM_IDI0		(UNICAM_BASE + 0x108)
#define UNICAM_IPIPE		(UNICAM_BASE + 0x10C)
#define UNICAM_IBSA0		(UNICAM_BASE + 0x110)
#define UNICAM_IBEA0		(UNICAM_BASE + 0x114)
#define UNICAM_IBLS		(UNICAM_BASE + 0x118)
#define UNICAM_IBWP		(UNICAM_BASE + 0x11C)
#define UNICAM_IHWIN		(UNICAM_BASE + 0x120)
#define UNICAM_IVWIN		(UNICAM_BASE + 0x128)
#define UNICAM_DCS		(UNICAM_BASE + 0x200)
#define UNICAM_DBCTL		(UNICAM_BASE + 0x300)
#define UNICAM_MISC		(UNICAM_BASE + 0x400)

#define LANE_CLOCK_GATE		(ARM_IO_BASE + 0x802004)
#define LANE_GATE_PASSWORD	0x5A000000
#define LANE_GATE_2LANES	0x15		// clock lane, data lanes 0 and 1: 01 each

// CTRL
#define CTRL_CPE		(1 << 0)
#define CTRL_MEM		(1 << 1)
#define CTRL_CPR		(1 << 2)
#define CTRL_CPM		(1 << 3)	// 1: CCP2
#define CTRL_SOE		(1 << 4)
#define CTRL_DCM		(1 << 5)
#define CTRL_PFT(n)		((n) << 8)
#define CTRL_PFT_MASK		CTRL_PFT (0xF)
#define CTRL_OET(n)		((n) << 12)
#define CTRL_OET_MASK		CTRL_OET (0x1FF)

// STA
#define STA_SBE			(1 << 2)
#define STA_PBE			(1 << 3)
#define STA_HOE			(1 << 4)
#define STA_PLE			(1 << 5)
#define STA_SSC			(1 << 6)
#define STA_CRCE		(1 << 7)
#define STA_IFO			(1 << 9)
#define STA_OFO			(1 << 10)
#define STA_BFO			(1 << 11)
#define STA_IS			(1 << 14)
#define STA_PI0			(1 << 15)
#define STA_CLEAR_ALL		0x0001B6FC
#define STA_ERRORS		(STA_SBE | STA_PBE | STA_HOE | STA_PLE | STA_SSC | STA_CRCE \
				 | STA_IFO | STA_OFO | STA_BFO)

// ANA
#define ANA_APD			(1 << 0)
#define ANA_BPD			(1 << 1)
#define ANA_AR			(1 << 2)
#define ANA_DDL			(1 << 3)
#define ANA_CTATADJ(n)		((n) << 4)
#define ANA_PTATADJ(n)		((n) << 8)
#define ANA_RESET_VALUE		0x777

// PRI: the fields' meanings are guesses (SPEC 5.2); the values are known
#define PRI_PE			(1 << 0)
#define PRI_PT(n)		((n) << 1)
#define PRI_NP(n)		((n) << 4)
#define PRI_PP(n)		((n) << 8)
#define PRI_MASK		0x3FFFF

// CLK and DAT0/1: enable and the low-power receiver only (a
// non-continuous clock: no high-speed termination, SPEC 8.4)
#define LANE_ENABLE		(1 << 0)
#define LANE_LPE		(1 << 2)
#define CLK_RESET_VALUE		0x2

// CLT, DLT
#define TIMING(nTermEnable, nSettle)	((nTermEnable) | (nSettle) << 8)

// CMP0: compare packets with the Frame End short packet (DT 0x01), and
// interrupt on a match (PI0)
#define CMP_PCE			(1 << 31)
#define CMP_GI			(1 << 9)
#define CMP_CPH			(1 << 8)
#define CMP_DT_FRAME_END	0x01

// ICTL
#define ICTL_FSIE		(1 << 0)
#define ICTL_FEIE		(1 << 1)
#define ICTL_IBOB		(1 << 2)
#define ICTL_LIP		(1 << 5)
#define ICTL_LCIE(n)		((n) << 16)

// ISTA
#define ISTA_FSI		(1 << 0)
#define ISTA_FEI		(1 << 1)
#define ISTA_LCI		(1 << 2)
#define ISTA_ALL		(ISTA_FSI | ISTA_FEI | ISTA_LCI)

#define IDI_RAW8		0x2A		// virtual channel 0, data type RAW8
#define MISC_FL0		(1 << 6)
#define MISC_FL1		(1 << 9)

#define DOMAIN_UNICAM1		14
#define MIN_CORE_CLOCK		250000000

CZgUnicam::CZgUnicam (void)
:	m_Clock (GPIOClockCAM1, GPIOClockSourcePLLD),
	m_bPowered (FALSE),
	m_bRunning (FALSE),
	m_nStride (0),
	m_nHeight (0),
	m_nBufferSize (0),
	m_nNext (-1), m_nWriting (-1), m_nReady (-1), m_nInUse (-1),
	m_nStarted (0), m_nCompleted (0), m_nNotTaken (0), m_nIncomplete (0),
	m_nLastLines (0),
	m_nFirstFrameStart (0), m_nLastFrameStart (0), m_nLastFrameEnd (0),
	m_nErrors (0)
{
	for (unsigned i = 0; i < Buffers; i++)
	{
		m_pBuffer[i] = 0;
		m_State[i] = StateFree;
	}
}

CZgUnicam::~CZgUnicam (void)
{
	Stop ();
	PowerOff ();
}

static boolean SetDomain (boolean bOn)
{
	CBcmPropertyTags Tags;
	TPropertyTagDomainState Domain;
	Domain.nDomainId = DOMAIN_UNICAM1;
	Domain.nOn = bOn ? DOMAIN_STATE_ON : DOMAIN_STATE_OFF;
	return Tags.GetTag (PROPTAG_SET_DOMAIN_STATE, &Domain, sizeof Domain, 8);
}

boolean CZgUnicam::PowerOn (void)
{
	if (m_bPowered)
	{
		return TRUE;
	}

	CLogger *pLogger = CLogger::Get ();

	// The firmware may not know the tag (SPEC 3.2); the reset values below
	// tell whether the block is on either way.
	if (!SetDomain (TRUE))
	{
		pLogger->Write (FromUnicam, LogWarning, "the firmware refused power domain %u",
				DOMAIN_UNICAM1);
	}

	// 100 MHz from PLLD (500 MHz) / 5; CAM1's divider has only 4 integer
	// bits, so no fraction and no MASH (SPEC 3.3)
	m_Clock.Start (5, 0, 0);
	CTimer::SimpleusDelay (100);

	unsigned nCore = CMachineInfo::Get ()->GetClockRate (CLOCK_ID_CORE);
	u32 nANA = read32 (UNICAM_ANA);
	u32 nCLK = read32 (UNICAM_CLK);
	pLogger->Write (FromUnicam, nCore < MIN_CORE_CLOCK ? LogWarning : LogNotice,
			"powered: ANA %03x, CLK %x (expected %03x, %x), VPU clock %u MHz",
			nANA, nCLK, ANA_RESET_VALUE, CLK_RESET_VALUE, nCore / 1000000);

	m_bPowered = TRUE;

	if (nANA == 0 && nCLK == 0)
	{
		pLogger->Write (FromUnicam, LogError, "the receiver does not answer");
		PowerOff ();
		return FALSE;
	}

	return TRUE;
}

void CZgUnicam::PowerOff (void)
{
	if (!m_bPowered)
	{
		return;
	}
	assert (!m_bRunning);

	m_Clock.Stop ();
	SetDomain (FALSE);
	m_bPowered = FALSE;
}

boolean CZgUnicam::Start (unsigned nWidth, unsigned nHeight, unsigned nStride)
{
	assert (m_bPowered);
	assert (!m_bRunning);
	assert (nStride >= nWidth && nStride % 32 == 0);

	m_nStride = nStride;
	m_nHeight = nHeight;
	m_nBufferSize = nStride * nHeight;	// a whole number of cache lines

	for (unsigned i = 0; i < Buffers; i++)
	{
		// cache-line aligned (Circle's heap aligns to no more; SPEC 5.5
		// asks for at least 32 bytes)
		m_pBuffer[i] = (u8 *) memalign (DATA_CACHE_LINE_LENGTH_MAX, m_nBufferSize);
		if (m_pBuffer[i] == 0)
		{
			FreeBuffers ();
			return FALSE;
		}
		// no dirty line from the heap's earlier use may later be written
		// back over a frame
		CleanAndInvalidateDataCacheRange ((uintptr) m_pBuffer[i], m_nBufferSize);
		m_State[i] = StateFree;
	}

	m_nWriting = m_nReady = m_nInUse = -1;
	m_nStarted = m_nCompleted = m_nNotTaken = m_nIncomplete = 0;
	m_nLastLines = 0;
	m_nFirstFrameStart = m_nLastFrameStart = 0;
	m_nLastFrameEnd = CTimer::GetClockTicks64 ();
	m_nErrors = 0;

	PeripheralEntry ();

	// SPEC 5.3, step by step
	write32 (LANE_CLOCK_GATE, LANE_GATE_PASSWORD | LANE_GATE_2LANES);		// 1
	write32 (UNICAM_CTRL, CTRL_MEM);						// 2
	write32 (UNICAM_ANA, ANA_AR | ANA_CTATADJ (7) | ANA_PTATADJ (7));		// 3
	CTimer::SimpleMsDelay (2);							// 4
	write32 (UNICAM_ANA, read32 (UNICAM_ANA) & ~ANA_AR);				// 5
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) | CTRL_CPR);			// 6
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) & ~CTRL_CPR);
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) & ~CTRL_CPE);			// 7
	u32 nCtrl = read32 (UNICAM_CTRL);						// 8
	nCtrl &= ~(CTRL_CPM | CTRL_DCM | CTRL_PFT_MASK | CTRL_OET_MASK);
	nCtrl |= CTRL_PFT (0xF) | CTRL_OET (128);
	write32 (UNICAM_CTRL, nCtrl);
	write32 (UNICAM_IHWIN, 0);							// 9
	write32 (UNICAM_IVWIN, 0);
	u32 nPri = read32 (UNICAM_PRI) & ~PRI_MASK;					// 10
	write32 (UNICAM_PRI, nPri | PRI_PP (0xE) | PRI_NP (8) | PRI_PT (2) | PRI_PE);
	write32 (UNICAM_ANA, read32 (UNICAM_ANA) & ~ANA_DDL);				// 11

	// 12: frame start and end interrupts; the line count interrupt is
	// left as the proven setting has it (every 128 lines) and ignored
	unsigned nLines = nHeight / 4 > 128 ? nHeight / 4 : 128;
	write32 (UNICAM_ICTL, ICTL_FSIE | ICTL_FEIE | ICTL_IBOB | ICTL_LCIE (nLines));
	write32 (UNICAM_STA, STA_CLEAR_ALL);						// 13
	write32 (UNICAM_ISTA, ISTA_ALL);
	write32 (UNICAM_CLT, TIMING (2, 6));						// 14
	write32 (UNICAM_DLT, TIMING (2, 6));						// 15
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) & ~CTRL_SOE);			// 16
	write32 (UNICAM_CMP0, CMP_PCE | CMP_GI | CMP_CPH | CMP_DT_FRAME_END);		// 17
	write32 (UNICAM_CLK, LANE_ENABLE | LANE_LPE);					// 18
	write32 (UNICAM_DAT0, LANE_ENABLE | LANE_LPE);					// 19
	write32 (UNICAM_DAT1, LANE_ENABLE | LANE_LPE);
	// 20: DAT2/DAT3 are not wired on the Zero
	write32 (UNICAM_IBLS, nStride);						// 21
	Program (0);									// 22
	write32 (UNICAM_IPIPE, 0);							// 23: as received
	write32 (UNICAM_IDI0, IDI_RAW8);						// 24
	write32 (UNICAM_MISC, read32 (UNICAM_MISC) | MISC_FL0 | MISC_FL1);		// 25

	PeripheralExit ();

	// the handler must be in place before the receiver is enabled
	m_bRunning = TRUE;
	CInterruptSystem::Get ()->ConnectIRQ (ARM_IRQ_CAM1, InterruptHandler, this);

	PeripheralEntry ();
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) | CTRL_CPE);			// 26
	write32 (UNICAM_ICTL, read32 (UNICAM_ICTL) | ICTL_LIP);			// 27
	PeripheralExit ();

	// 28 is the sensor's stream-on, by the caller
	return TRUE;
}

void CZgUnicam::Stop (void)
{
	if (!m_bRunning)
	{
		return;
	}

	PeripheralEntry ();

	// SPEC 5.6, steps 2 to 8 (1, the sensor's standby, was the caller's)
	write32 (UNICAM_ANA, read32 (UNICAM_ANA) | ANA_DDL);
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) | CTRL_SOE);
	write32 (UNICAM_DAT0, 0);
	write32 (UNICAM_DAT1, 0);
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) | CTRL_CPR);
	CTimer::SimpleusDelay (100);
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) & ~CTRL_CPR);
	write32 (UNICAM_CTRL, read32 (UNICAM_CTRL) & ~CTRL_CPE);
	write32 (UNICAM_DCS, 0);
	write32 (LANE_CLOCK_GATE, LANE_GATE_PASSWORD);

	// no more interrupts: none enabled, none pending
	write32 (UNICAM_ICTL, 0);
	write32 (UNICAM_STA, read32 (UNICAM_STA));
	write32 (UNICAM_ISTA, read32 (UNICAM_ISTA));

	PeripheralExit ();

	CInterruptSystem::Get ()->DisconnectIRQ (ARM_IRQ_CAM1);
	m_bRunning = FALSE;

	// CPE is clear: the receiver writes no more (SPEC 8.8)
	FreeBuffers ();
}

void CZgUnicam::FreeBuffers (void)
{
	for (unsigned i = 0; i < Buffers; i++)
	{
		// what the camera saw stays out of the heap: a code may hold a
		// secret, and the next start's first frames come from this memory
		if (m_pBuffer[i] != 0)
		{
			memset (m_pBuffer[i], 0, m_nBufferSize);
		}
		free (m_pBuffer[i]);
		m_pBuffer[i] = 0;
		m_State[i] = StateFree;
	}
	m_nNext = m_nWriting = m_nReady = m_nInUse = -1;
}

void CZgUnicam::Program (unsigned nBuffer)
{
	assert (nBuffer < Buffers);
	m_State[nBuffer] = StateNext;
	m_nNext = nBuffer;

	u32 nStart = BUS_ADDRESS ((uintptr) m_pBuffer[nBuffer]);
	DataSyncBarrier ();
	write32 (UNICAM_IBSA0, nStart);
	write32 (UNICAM_IBEA0, nStart + m_nBufferSize);		// exclusive
}

void CZgUnicam::InterruptHandler (void *pParam)
{
	CZgUnicam *pThis = (CZgUnicam *) pParam;
	assert (pThis != 0);
	pThis->Interrupt ();
}

void CZgUnicam::Interrupt (void)
{
	u32 nSTA = read32 (UNICAM_STA);
	write32 (UNICAM_STA, nSTA);
	u32 nISTA = read32 (UNICAM_ISTA);
	write32 (UNICAM_ISTA, nISTA);

	m_nErrors |= nSTA & STA_ERRORS;

	if (!(nSTA & (STA_IS | STA_PI0)))
	{
		return;
	}

	// both in one interrupt: the end belongs to the frame before the start
	if ((nISTA & ISTA_FEI) || (nSTA & STA_PI0))
	{
		FrameEnd ();
	}
	if (nISTA & ISTA_FSI)
	{
		FrameStart ();
	}
}

void CZgUnicam::FrameStart (void)
{
	unsigned long long nNow = CTimer::GetClockTicks64 ();
	if (m_nStarted++ == 0)
	{
		m_nFirstFrameStart = nNow;
	}
	m_nLastFrameStart = nNow;

	if (m_nWriting >= 0)		// its frame end never came
	{
		m_State[m_nWriting] = StateFree;
		m_nIncomplete++;
	}

	// the hardware took the Next buffer's address at this frame start
	m_nWriting = m_nNext;
	m_nNext = -1;
	if (m_nWriting >= 0)
	{
		m_State[m_nWriting] = StateWriting;
	}

	for (unsigned i = 0; i < Buffers; i++)
	{
		if (m_State[i] == StateFree)
		{
			Program (i);
			return;
		}
	}

	// cannot happen with four buffers (unicam.h); never leave the
	// receiver without a valid address: give it the unread frame
	assert (m_nReady >= 0);
	unsigned nBuffer = m_nReady;
	m_nReady = -1;
	m_nNotTaken++;
	Program (nBuffer);
}

void CZgUnicam::FrameEnd (void)
{
	if (m_nWriting < 0)		// a second report of the same end
	{
		return;
	}

	// how far it got (a check of the mode; when the next frame has
	// already started, the pointer is in another buffer: no news)
	u32 nWritten = read32 (UNICAM_IBWP) - BUS_ADDRESS ((uintptr) m_pBuffer[m_nWriting]);
	if (nWritten <= m_nBufferSize)
	{
		m_nLastLines = (nWritten + m_nStride - 1) / m_nStride;
	}

	if (m_nReady >= 0)		// never taken: a newer frame is here
	{
		m_State[m_nReady] = StateFree;
		m_nNotTaken++;
	}
	m_nReady = m_nWriting;
	m_State[m_nReady] = StateReady;
	m_nWriting = -1;
	m_nCompleted++;
	m_nLastFrameEnd = CTimer::GetClockTicks64 ();
}

const u8 *CZgUnicam::TakeFrame (void)
{
	assert (m_nInUse < 0);

	EnterCritical (IRQ_LEVEL);
	int nBuffer = m_nReady;
	if (nBuffer >= 0)
	{
		m_nReady = -1;
		m_State[nBuffer] = StateInUse;
		m_nInUse = nBuffer;
	}
	LeaveCritical ();

	if (nBuffer < 0)
	{
		return 0;
	}

	// what the cache holds of this buffer is from an earlier frame
	CleanAndInvalidateDataCacheRange ((uintptr) m_pBuffer[nBuffer], m_nBufferSize);
	return m_pBuffer[nBuffer];
}

void CZgUnicam::ReleaseFrame (void)
{
	EnterCritical (IRQ_LEVEL);
	if (m_nInUse >= 0)
	{
		m_State[m_nInUse] = StateFree;
		m_nInUse = -1;
	}
	LeaveCritical ();
}

void CZgUnicam::GetFrameStartTiming (unsigned *pCount, unsigned long long *pTicks) const
{
	EnterCritical (IRQ_LEVEL);
	*pCount = m_nStarted;
	*pTicks = m_nLastFrameStart - m_nFirstFrameStart;
	LeaveCritical ();
}

u32 CZgUnicam::GetErrors (void)
{
	EnterCritical (IRQ_LEVEL);
	u32 nErrors = m_nErrors;
	m_nErrors = 0;
	LeaveCritical ();
	return nErrors;
}

void CZgUnicam::DescribeErrors (u32 nErrors, char *pBuffer, unsigned nSize)
{
	static const struct { u32 nBit; const char *pName; } Names[] =
	{
		{STA_SBE, "single-bit ECC"}, {STA_PBE, "packet ECC"}, {STA_HOE, "header overflow"},
		{STA_PLE, "packet length"}, {STA_SSC, "sync short packet"}, {STA_CRCE, "CRC"},
		{STA_IFO, "input FIFO overflow"}, {STA_OFO, "output FIFO overflow"},
		{STA_BFO, "buffer overflow"},
	};
	assert (nSize > 0);
	pBuffer[0] = '\0';
	for (unsigned i = 0; i < sizeof Names / sizeof Names[0]; i++)
	{
		if (nErrors & Names[i].nBit)
		{
			if (pBuffer[0] != '\0')
			{
				strncat (pBuffer, ", ", nSize - strlen (pBuffer) - 1);
			}
			strncat (pBuffer, Names[i].pName, nSize - strlen (pBuffer) - 1);
		}
	}
}

void CZgUnicam::DumpRegisters (const char *pWhen)
{
	PeripheralEntry ();
	CLogger::Get ()->Write (FromUnicam, LogNotice,
		"%s: CTRL %08x STA %08x ANA %08x CLK %08x DAT0 %08x DAT1 %08x ISTA %08x IBWP %08x",
		pWhen, read32 (UNICAM_CTRL), read32 (UNICAM_STA), read32 (UNICAM_ANA),
		read32 (UNICAM_CLK), read32 (UNICAM_DAT0), read32 (UNICAM_DAT1),
		read32 (UNICAM_ISTA), read32 (UNICAM_IBWP));
	PeripheralExit ();
}
