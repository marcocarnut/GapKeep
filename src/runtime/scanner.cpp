//
// scanner.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "scanner.h"
#include "camera.h"
#include "settings.h"
#include <colorqr.h>
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>
#include <circle/string.h>
#include <math.h>
#include <assert.h>

CZgCamera *CZgCamera::s_pCamera = 0;
CZgScanner *CZgScanner::s_pActive = 0;

// a code that was out of sight this long is reported again when it comes back
static const unsigned long long ForgetTicks = 2 * CLOCKHZ;
// the outline of a code read stays on the preview this long
static const unsigned long long OutlineTicks = CLOCKHZ / 2;
// a code's colour layer not read for this long is reported as not read (and
// still tried: a success follows if it comes)
static const unsigned long long ColourPatienceTicks = CLOCKHZ;

static const struct { const char *pName; unsigned nBit; boolean bExperimental; } Detectors[] =
{
	{"qr",		ZG_DETECT_QR,		FALSE},
	{"qr-color",	ZG_DETECT_QR_COLOR,	TRUE},
};

// colorqr's stages, timed (lib/colorqr/colorqr.mk builds it with CQ_PROFILE):
// 0 start, 1 grey, 2 blur, 3 refine known, 4 sample and rebuild, 5 refine
// all, 6 sample RGB, 7 layout, 8 demodulate, 9 LLRs, 10 decode; each ends at
// its stamp. Stages not reached keep 0.
static const unsigned ColourStages = 11;
static unsigned long long s_ColourStamps[ColourStages];

extern "C" void cq_stage (int nStage)
{
	if (nStage >= 0 && (unsigned) nStage < ColourStages)
	{
		s_ColourStamps[nStage] = CTimer::GetClockTicks64 ();
	}
}

// "stages 12 3 40 ...": each reached stage's time in ms since the one before
static void LogStages (const char *pWhat)
{
	if (s_ColourStamps[1] == 0)
	{
		return;			// settled before the first stage (a plain code)
	}
	CString Text;
	for (unsigned i = 1; i < ColourStages && s_ColourStamps[i] != 0; i++)
	{
		CString Part;
		Part.Format (" %u", (unsigned) ((s_ColourStamps[i] - s_ColourStamps[i - 1]) / (CLOCKHZ / 1000)));
		Text.Append (Part);
	}
	CLogger::Get ()->Write ("scanner", LogNotice, "colour layer %s: stages (ms)%s", pWhat, (const char *) Text);
}

// the detectors this system has: experimental ones only if zerogap.txt says so
static boolean Available (unsigned i)
{
	return !Detectors[i].bExperimental || CZgSettings::IsExperimental ();
}

unsigned CZgScanner::GetDetector (const char *pName)
{
	for (unsigned i = 0; i < sizeof Detectors / sizeof Detectors[0]; i++)
	{
		if (strcmp (pName, Detectors[i].pName) == 0 && Available (i))
		{
			return Detectors[i].nBit;
		}
	}
	return 0;
}

const char *CZgScanner::GetDetectorName (unsigned nIndex, unsigned *pBit)
{
	for (unsigned i = 0; i < sizeof Detectors / sizeof Detectors[0]; i++)
	{
		if (!Available (i))
		{
			continue;
		}
		if (nIndex-- == 0)
		{
			if (pBit != 0)
			{
				*pBit = Detectors[i].nBit;
			}
			return Detectors[i].pName;
		}
	}
	return 0;
}

CZgScanner::CZgScanner (void)
:	m_nDetectors (0),
	m_Field (ZgFieldCenter),
	m_pCamera (0),
	m_pError (0),
	m_nFrameSerial (0),
	m_pPreviewFrame (0),
	m_nPreviewWidth (0),
	m_nPreviewHeight (0),
	m_nNextDecodeAt (0),
	m_nMissedSince (0),
	m_nPending (0),
	m_pLast (0),
	m_nLastLength (0),
	m_nCornersUntil (0),
	m_bColourRead (FALSE),
	m_bColourFailReported (FALSE),
	m_nColourTries (0),
	m_nColourSince (0),
	m_ColourStatus (ZgColourUnreadable),
	m_pColour (0),
	m_nColourLength (0),
	m_pWork (0),
	m_nWorkSize (0),
	m_nColourDecodes (0),
	m_nColourOK (0),
	m_nColourTicks (0),
	m_nMaxColourTicks (0),
	m_nLastColourMs (0),
	m_nFrames (0),
	m_nDecodes (0),
	m_nFound (0),
	m_nSideSum (0),
	m_nDecodeTicks (0),
	m_nMaxDecodeTicks (0)
{
}

CZgScanner::~CZgScanner (void)
{
	Stop ();
	delete [] m_pPreviewFrame;
	delete [] m_pLast;
	FreeColour ();
}

// What a colour code held may be a secret: zeroed before it goes.
void CZgScanner::FreeColour (void)
{
	if (m_pWork != 0)
	{
		memset (m_pWork, 0, m_nWorkSize);
		delete [] m_pWork;
		m_pWork = 0;
		m_nWorkSize = 0;
	}
	if (m_pColour != 0)
	{
		memset (m_pColour, 0, ZG_QR_MAX_COLOUR);
		delete [] m_pColour;
		m_pColour = 0;
	}
	m_nColourLength = 0;
}

boolean CZgScanner::Start (void)
{
	if (m_pCamera != 0)
	{
		return TRUE;
	}

	m_pError = 0;
	CZgCamera *pCamera = CZgCamera::Get ();
	if (pCamera == 0)
	{
		m_pError = "no camera";
		return FALSE;
	}
	if (s_pActive != 0)
	{
		m_pError = "the camera is in use by another scanner";
		return FALSE;
	}
	pCamera->SetField (m_Field);
	pCamera->SetColour ((m_nDetectors & ZG_DETECT_QR_COLOR) != 0);
	if (!pCamera->Start ())
	{
		m_pError = pCamera->GetError ();
		if (m_pError == 0)
		{
			m_pError = "the camera did not start";
		}
		return FALSE;
	}

	m_pCamera = pCamera;
	s_pActive = this;
	m_nFrameSerial = 0;
	m_nNextDecodeAt = 0;

	// a fresh start: the code in view is reported, even if it was before
	delete [] m_pLast;
	m_pLast = 0;
	m_nLastLength = 0;
	m_nCornersUntil = 0;
	m_nFrames = m_nDecodes = m_nFound = 0;
	m_nSideSum = 0;
	m_nDecodeTicks = m_nMaxDecodeTicks = 0;
	m_nPending = 0;
	m_nMissedSince = 0;
	m_bColourRead = m_bColourFailReported = FALSE;
	m_nColourTries = 0;
	m_nColourDecodes = m_nColourOK = 0;
	m_nColourTicks = m_nMaxColourTicks = 0;

	return TRUE;
}

void CZgScanner::Stop (void)
{
	if (m_pCamera == 0)
	{
		return;
	}

	m_pCamera->Stop ();
	m_pCamera = 0;
	m_nPending = 0;		// stopped from a "detect" handler: no more events

	if (m_nDecodes > 0)
	{
		// "found": decodes that found a code, and its average side in
		// frame pixels (how large the camera sees it)
		CLogger::Get ()->Write ("scanner", LogNotice,
			"%u frames, %u decoded, %u ms each on average, %u ms at most;"
			" %u found, %u px side in %ux%u",
			m_nFrames, m_nDecodes,
			(unsigned) (m_nDecodeTicks / m_nDecodes / (CLOCKHZ / 1000)),
			(unsigned) (m_nMaxDecodeTicks / (CLOCKHZ / 1000)),
			m_nFound, m_nFound > 0 ? (unsigned) (m_nSideSum / m_nFound) : 0,
			m_nPreviewWidth, m_nPreviewHeight);
	}
	if (m_nColourDecodes > 0)
	{
		CLogger::Get ()->Write ("scanner", LogNotice,
			"colour layer: %u tries, %u read, %u ms each on average, %u ms at most",
			m_nColourDecodes, m_nColourOK,
			(unsigned) (m_nColourTicks / m_nColourDecodes / (CLOCKHZ / 1000)),
			(unsigned) (m_nMaxColourTicks / (CLOCKHZ / 1000)));
	}
	FreeColour ();
	assert (s_pActive == this);
	s_pActive = 0;
}

unsigned CZgScanner::GetDetection (const u8 **ppData, unsigned *pLength)
{
	*ppData = m_pLast;
	*pLength = m_nLastLength;
	for (unsigned nBit = ZG_DETECT_QR; nBit <= ZG_DETECT_QR_COLOR; nBit <<= 1)
	{
		if (m_nPending & nBit)
		{
			m_nPending &= ~nBit;
			return nBit;
		}
	}
	return 0;
}

TZgColourStatus CZgScanner::GetColour (const u8 **ppColour, unsigned *pLength) const
{
	boolean bOK = m_ColourStatus == ZgColourOK;
	*ppColour = bOK ? m_pColour : 0;
	*pLength = bOK ? m_nColourLength : 0;
	return m_ColourStatus;
}

unsigned CZgScanner::Poll (void)
{
	if (m_pCamera == 0)
	{
		return 0;
	}

	unsigned nWidth, nHeight;
	const u8 *pFrame = m_pCamera->GetFrame (&m_nFrameSerial, &nWidth, &nHeight);
	if (pFrame == 0)
	{
		const char *pError = m_pCamera->GetError ();
		if (pError != 0)
		{
			m_pError = pError;
			Stop ();
			return PollError;
		}
		return 0;
	}

	// keep a copy for the preview (the camera may reuse its buffer)
	if (m_pPreviewFrame == 0 || nWidth * nHeight != m_nPreviewWidth * m_nPreviewHeight)
	{
		delete [] m_pPreviewFrame;
		m_pPreviewFrame = new u8[nWidth * nHeight];
	}
	memcpy (m_pPreviewFrame, pFrame, nWidth * nHeight);
	m_nPreviewWidth = nWidth;
	m_nPreviewHeight = nHeight;
	unsigned nResult = PollFrame;
	m_nFrames++;
	m_nPending = 0;

	if (m_nDetectors & (ZG_DETECT_QR | ZG_DETECT_QR_COLOR))
	{
		nResult |= PollQR (pFrame, nWidth, nHeight);
		if (m_pCamera == 0)
		{
			return nResult;		// stopped (no decoder)
		}
	}

	return nResult;
}

// Decodes at most half the time: a decode that took D waits D before the
// next one, so the UI stays responsive on a slow CPU.
unsigned CZgScanner::PollQR (const u8 *pFrame, unsigned nWidth, unsigned nHeight)
{
	unsigned long long nNow = CTimer::GetClockTicks64 ();
	if (nNow < m_nNextDecodeAt)
	{
		return 0;
	}

	TZgQRCode Codes[1];
	int nFound = ZgDecodeQR (pFrame, nWidth, nHeight, Codes, 1);
	unsigned long long nDone = CTimer::GetClockTicks64 ();
	m_nNextDecodeAt = nDone + (nDone - nNow);
	m_nDecodes++;
	m_nDecodeTicks += nDone - nNow;
	if (nDone - nNow > m_nMaxDecodeTicks)
	{
		m_nMaxDecodeTicks = nDone - nNow;
	}
	if (nFound < 0)
	{
		m_pError = "this build has no QR decoder";
		Stop ();
		return PollError;
	}
	if (nFound == 0)
	{
		if (m_nMissedSince == 0)
		{
			m_nMissedSince = nDone;		// out of sight from about now
		}
		return 0;
	}

	const TZgQRCode &rCode = Codes[0];
	memcpy (m_Corners, rCode.Corners, sizeof m_Corners);
	m_nFound++;
	double fSides = 0;
	for (int k = 0; k < 4; k++)
	{
		double dx = m_Corners[(k + 1) % 4][0] - m_Corners[k][0];
		double dy = m_Corners[(k + 1) % 4][1] - m_Corners[k][1];
		fSides += sqrt (dx * dx + dy * dy);
	}
	m_nSideSum += (unsigned) (fSides / 4);
	m_nCornersUntil = nDone + OutlineTicks;

	boolean bSame =    m_pLast != 0 && m_nLastLength == rCode.nLength
			&& memcmp (m_pLast, rCode.pData, rCode.nLength) == 0;
	// Again only if it was out of sight long enough: a decode missed it, that
	// long ago. Not merely long since the last decode, which a slow colour
	// layer (seconds for a large code) makes long too.
	boolean bReport = !bSame || (m_nMissedSince != 0 && nDone - m_nMissedSince > ForgetTicks);
	m_nMissedSince = 0;

	if (!bSame)
	{
		delete [] m_pLast;
		m_pLast = new u8[rCode.nLength + 1];
		memcpy (m_pLast, rCode.pData, rCode.nLength);
		m_nLastLength = rCode.nLength;
	}

	unsigned nResult = 0;
	if (bReport && (m_nDetectors & ZG_DETECT_QR))
	{
		m_nPending |= ZG_DETECT_QR;
		nResult = PollDetect;
	}
	if (m_nDetectors & ZG_DETECT_QR_COLOR)
	{
		nResult |= PollColour (rCode, nWidth, nHeight, bReport, nNow);
		// the colour decoder's time counts too: decoding stays at most
		// half the time
		unsigned long long nEnd = CTimer::GetClockTicks64 ();
		m_nNextDecodeAt = nEnd + (nEnd - nNow);
	}
	return nResult;
}

// The colour layer of the code just read, from the same frame in colour:
// tried on every decode of an appearance until it is read. Reported once
// read, or as not read (plain or unreadable) after ColourPatienceTicks; a
// success after that is reported too.
unsigned CZgScanner::PollColour (const TZgQRCode &rCode, unsigned nWidth, unsigned nHeight,
				 boolean bNewAppearance, unsigned long long nNow)
{
	if (bNewAppearance)
	{
		m_bColourRead = m_bColourFailReported = FALSE;
		m_nColourTries = 0;
		m_nColourSince = nNow;
	}
	if (m_bColourRead)
	{
		return 0;
	}

	TZgColourStatus Status = ZgColourUnreadable;
	const u8 *pRGB = m_pCamera->GetColourFrame ();
	if (pRGB != 0 && rCode.nVersion >= 1 && rCode.nVersion <= 40)
	{
		size_t nNeeded = cq_work_size (nWidth, nHeight, rCode.nVersion);
		if (nNeeded > m_nWorkSize)
		{
			if (m_pWork != 0)
			{
				memset (m_pWork, 0, m_nWorkSize);
				delete [] m_pWork;
			}
			m_pWork = new u64[(nNeeded + 7) / 8];	// 8-byte aligned, as colorqr needs
			m_nWorkSize = (unsigned) nNeeded;
		}
		if (m_pColour == 0)
		{
			m_pColour = new u8[ZG_QR_MAX_COLOUR];
		}

		float Corners[4][2];
		for (unsigned k = 0; k < 4; k++)
		{
			Corners[k][0] = (float) rCode.Corners[k][0];
			Corners[k][1] = (float) rCode.Corners[k][1];
		}
		cq_result Result;
		memset (&Result, 0, sizeof Result);
		Result.payload = m_pColour;
		Result.payload_cap = ZG_QR_MAX_COLOUR;
		unsigned nFlags = m_pCamera->IsLinear () ? CQ_FLAG_LINEAR : 0;

		memset (s_ColourStamps, 0, sizeof s_ColourStamps);
		unsigned long long nStart = CTimer::GetClockTicks64 ();
		cq_status Code;
		if (   rCode.nDataCodewords > 0 && !rCode.bMirrored
		    && rCode.nECLevel >= 0 && rCode.nMask >= 0)
		{
			// the codewords zxing-cpp corrected: no second reading
			cq_base Base = {rCode.pDataCodewords, rCode.nDataCodewords,
					rCode.nECLevel, rCode.nMask};
			Code = cq_decode_base (pRGB, nWidth, nHeight, nWidth * 3, Corners, rCode.nVersion,
					       &Base, nFlags, m_pWork, m_nWorkSize, &Result);
		}
		else
		{
			Code = cq_decode (pRGB, nWidth, nHeight, nWidth * 3, Corners, rCode.nVersion,
					  nFlags, m_pWork, m_nWorkSize, &Result);
		}
		unsigned long long nTicks = CTimer::GetClockTicks64 () - nStart;
		m_nLastColourMs = (unsigned) (nTicks / (CLOCKHZ / 1000));
		LogStages (Code == CQ_OK ? "read" : Code == CQ_ERR_NO_COLOUR ? "plain" : "not read");
		m_nColourDecodes++;
		m_nColourTicks += nTicks;
		if (nTicks > m_nMaxColourTicks)
		{
			m_nMaxColourTicks = nTicks;
		}

		if (Code == CQ_OK && Result.payload_len <= ZG_QR_MAX_COLOUR)
		{
			Status = ZgColourOK;
			m_nColourLength = (unsigned) Result.payload_len;
			m_nColourOK++;
		}
		else if (Code == CQ_ERR_NO_COLOUR)
		{
			Status = ZgColourPlain;
		}
		else if (Code == CQ_ERR_TOO_BIG || Code == CQ_ERR_NOMEM)
		{
			// sized for any version (cq_work_size, ZG_QR_MAX_COLOUR)
			CLogger::Get ()->Write ("scanner", LogWarning, "colour layer: %s",
						Code == CQ_ERR_TOO_BIG ? "payload larger than expected"
								       : "work buffer too small");
		}
	}
	m_nColourTries++;

	if (Status == ZgColourOK)
	{
		m_bColourRead = TRUE;
		m_ColourStatus = Status;
		m_nPending |= ZG_DETECT_QR_COLOR;
		CLogger::Get ()->Write ("scanner", LogNotice, "colour layer read: %u bytes, version %u, try %u, %u ms",
					m_nColourLength, rCode.nVersion, m_nColourTries, m_nLastColourMs);
		return PollDetect;
	}
	if (!m_bColourFailReported && CTimer::GetClockTicks64 () - m_nColourSince >= ColourPatienceTicks)
	{
		m_bColourFailReported = TRUE;
		m_ColourStatus = Status;
		m_nPending |= ZG_DETECT_QR_COLOR;
		CLogger::Get ()->Write ("scanner", LogNotice, "colour layer not read: %s, version %u, %u tries,"
					" %u ms the last", Status == ZgColourPlain ? "plain QR code" : "unreadable",
					rCode.nVersion, m_nColourTries, m_nLastColourMs);
		return PollDetect;
	}
	return 0;
}

static inline u16 Grey565 (unsigned v)
{
	return (u16) (((v >> 3) << 11) | ((v >> 2) << 5) | (v >> 3));
}

boolean CZgScanner::DrawPreview (u16 *pPixels, unsigned nWidth, unsigned nHeight) const
{
	if (m_pPreviewFrame == 0 || nWidth == 0 || nHeight == 0)
	{
		return FALSE;
	}

	unsigned fw = m_nPreviewWidth, fh = m_nPreviewHeight;
	unsigned nW = nWidth, nH = fh * nWidth / fw;		// fit, keeping the aspect
	if (nH > nHeight)
	{
		nH = nHeight;
		nW = fw * nHeight / fh;
	}
	if (nW == 0) nW = 1;
	if (nH == 0) nH = 1;
	unsigned nX0 = (nWidth - nW) / 2, nY0 = (nHeight - nH) / 2;

	for (unsigned y = 0; y < nHeight; y++)
	{
		u16 *pOut = pPixels + y * nWidth;
		if (y < nY0 || y >= nY0 + nH)
		{
			memset (pOut, 0, nWidth * sizeof (u16));
			continue;
		}
		const u8 *pRow = m_pPreviewFrame + ((y - nY0) * fh / nH) * fw;
		for (unsigned x = 0; x < nWidth; x++)
		{
			pOut[x] = x < nX0 || x >= nX0 + nW ? 0 : Grey565 (pRow[(x - nX0) * fw / nW]);
		}
	}

	// the outline of the code just read, in green, 2 px wide
	if (CTimer::GetClockTicks64 () < m_nCornersUntil)
	{
		const u16 Green = (0 << 11) | (63 << 5) | 8;
		for (int k = 0; k < 4; k++)
		{
			int x0 = nX0 + m_Corners[k][0] * (int) nW / (int) fw;
			int y0 = nY0 + m_Corners[k][1] * (int) nH / (int) fh;
			int x1 = nX0 + m_Corners[(k + 1) % 4][0] * (int) nW / (int) fw;
			int y1 = nY0 + m_Corners[(k + 1) % 4][1] * (int) nH / (int) fh;
			int nSteps = (x1 > x0 ? x1 - x0 : x0 - x1) + (y1 > y0 ? y1 - y0 : y0 - y1) + 1;
			for (int s = 0; s <= nSteps; s++)
			{
				int x = x0 + (x1 - x0) * s / nSteps;
				int y = y0 + (y1 - y0) * s / nSteps;
				for (int d = 0; d < 4; d++)
				{
					int px = x + (d & 1), py = y + (d >> 1);
					if (px >= 0 && py >= 0 && px < (int) nWidth && py < (int) nHeight)
					{
						pPixels[py * nWidth + px] = Green;
					}
				}
			}
		}
	}

	return TRUE;
}
