//
// scanner.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "scanner.h"
#include "camera.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>
#include <math.h>
#include <assert.h>

CZgCamera *CZgCamera::s_pCamera = 0;
CZgScanner *CZgScanner::s_pActive = 0;

// a code that was out of sight this long is reported again when it comes back
static const unsigned long long ForgetTicks = 2 * CLOCKHZ;
// the outline of a code read stays on the preview this long
static const unsigned long long OutlineTicks = CLOCKHZ / 2;

static const struct { const char *pName; unsigned nBit; } Detectors[] =
{
	{"qr", ZG_DETECT_QR},
};

unsigned CZgScanner::GetDetector (const char *pName)
{
	for (unsigned i = 0; i < sizeof Detectors / sizeof Detectors[0]; i++)
	{
		if (strcmp (pName, Detectors[i].pName) == 0)
		{
			return Detectors[i].nBit;
		}
	}
	return 0;
}

const char *CZgScanner::GetDetectorName (unsigned nIndex, unsigned *pBit)
{
	if (nIndex >= sizeof Detectors / sizeof Detectors[0])
	{
		return 0;
	}
	if (pBit != 0)
	{
		*pBit = Detectors[nIndex].nBit;
	}
	return Detectors[nIndex].pName;
}

CZgScanner::CZgScanner (void)
:	m_nDetectors (0),
	m_pCamera (0),
	m_pError (0),
	m_nFrameSerial (0),
	m_pPreviewFrame (0),
	m_nPreviewWidth (0),
	m_nPreviewHeight (0),
	m_nNextDecodeAt (0),
	m_pLast (0),
	m_nLastLength (0),
	m_nLastSeenAt (0),
	m_nCornersUntil (0),
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
	assert (s_pActive == this);
	s_pActive = 0;
}

unsigned CZgScanner::GetDetection (const u8 **ppData, unsigned *pLength) const
{
	*ppData = m_pLast;
	*pLength = m_nLastLength;
	return ZG_DETECT_QR;		// the only detector so far
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

	if (m_nDetectors & ZG_DETECT_QR)
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
	boolean bReport = !bSame || nDone - m_nLastSeenAt > ForgetTicks;
	m_nLastSeenAt = nDone;
	if (!bReport)
	{
		return 0;
	}

	if (!bSame)
	{
		delete [] m_pLast;
		m_pLast = new u8[rCode.nLength + 1];
		memcpy (m_pLast, rCode.pData, rCode.nLength);
		m_nLastLength = rCode.nLength;
	}

	return PollDetect;
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
