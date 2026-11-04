//
// synthcam.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "synthcam.h"
#include <lvgl/lvgl/src/libs/qrcode/qrcodegen.h>
#include <circle/timer.h>
#include <circle/util.h>
#include <assert.h>

static const unsigned FrameTicks = CLOCKHZ / 15;

CZgSynthCamera::CZgSynthCamera (void)
:	m_Mode (ModeScene),
	m_bStreaming (FALSE),
	m_pPicture (new u8[FrameWidth * FrameHeight]),
	m_pFrame (new u8[FrameWidth * FrameHeight]),
	m_pLive (0),
	m_nLiveWidth (0),
	m_nLiveHeight (0),
	m_nSerial (0),
	m_nLiveSerial (0),
	m_nTakenLive (0),
	m_nNextFrameAt (0),
	m_nNoise (0x2545F491)
{
	DrawScene ();
}

CZgSynthCamera::~CZgSynthCamera (void)
{
	delete [] m_pPicture;
	delete [] m_pFrame;
	delete [] m_pLive;
}

const char *CZgSynthCamera::GetMode (void) const
{
	switch (m_Mode)
	{
	case ModeNone:		return "none";
	case ModeScene:		return "scene";
	case ModeQR:		return "qr";
	case ModePicture:	return "picture";
	case ModeLive:		return "live";
	}
	return "?";
}

// A soft diagonal gradient, the "room" the camera looks at.
void CZgSynthCamera::DrawScene (void)
{
	for (unsigned y = 0; y < FrameHeight; y++)
	{
		for (unsigned x = 0; x < FrameWidth; x++)
		{
			m_pPicture[y * FrameWidth + x] = (u8) (70 + (x + 2 * y) * 80 / (FrameWidth + 2 * FrameHeight));
		}
	}
}

void CZgSynthCamera::SetNone (void)
{
	m_Mode = ModeNone;
}

void CZgSynthCamera::SetScene (void)
{
	m_Mode = ModeScene;
	DrawScene ();
}

boolean CZgSynthCamera::SetQR (const u8 *pData, unsigned nLength)
{
	if (nLength > MaxQRBytes)
	{
		return FALSE;
	}

	// qrcodegen encodes in place: the data goes into its temporary buffer
	u8 *pTemp = new u8[qrcodegen_BUFFER_LEN_MAX];
	u8 *pQR = new u8[qrcodegen_BUFFER_LEN_MAX];
	memcpy (pTemp, pData, nLength);
	boolean bOK = qrcodegen_encodeBinary (pTemp, nLength, pQR, qrcodegen_Ecc_LOW,
					      qrcodegen_VERSION_MIN, qrcodegen_VERSION_MAX,
					      qrcodegen_Mask_AUTO, true);
	if (!bOK)
	{
		delete [] pTemp;
		delete [] pQR;
		return FALSE;
	}

	DrawScene ();

	// The symbol and its quiet zone (4 modules), as large as fits in 400 px,
	// turned by 3 degrees unless the modules are small. Each pixel is the
	// average of 4 samples, as a lens would blur the edges.
	int nModules = qrcodegen_getSize (pQR);
	int nSide = nModules + 8;
	float fModule = 400.0f / nSide;
	if (fModule > 10.0f)
	{
		fModule = 10.0f;
	}
	float fCos = 1.0f, fSin = 0.0f;
	if (fModule >= 3.0f)
	{
		fCos = 0.99863f;	// 3 degrees
		fSin = 0.05234f;
	}
	float fCX = FrameWidth / 2.0f, fCY = FrameHeight / 2.0f;
	int nReach = (int) (nSide * fModule * 0.75f) + 2;
	for (int y = (int) fCY - nReach; y < (int) fCY + nReach; y++)
	{
		if (y < 0 || y >= (int) FrameHeight)
		{
			continue;
		}
		for (int x = (int) fCX - nReach; x < (int) fCX + nReach; x++)
		{
			if (x < 0 || x >= (int) FrameWidth)
			{
				continue;
			}
			unsigned nSum = 0, nInside = 0;
			for (int s = 0; s < 4; s++)
			{
				float dx = x + 0.25f + 0.5f * (s & 1) - fCX;
				float dy = y + 0.25f + 0.5f * (s >> 1) - fCY;
				float u = ( fCos * dx + fSin * dy) / fModule + nSide / 2.0f;
				float v = (-fSin * dx + fCos * dy) / fModule + nSide / 2.0f;
				if (u < 0 || v < 0 || u >= nSide || v >= nSide)
				{
					continue;
				}
				nInside++;
				int mx = (int) u - 4, my = (int) v - 4;
				boolean bDark = mx >= 0 && my >= 0 && mx < nModules && my < nModules
						&& qrcodegen_getModule (pQR, mx, my);
				nSum += bDark ? 35 : 215;
			}
			if (nInside > 0)
			{
				u8 *p = &m_pPicture[y * FrameWidth + x];
				*p = (u8) ((nSum + (4 - nInside) * *p) / 4);
			}
		}
	}

	delete [] pTemp;
	delete [] pQR;

	m_Mode = ModeQR;
	return TRUE;
}

boolean CZgSynthCamera::SetPicture (const u8 *pGrey, unsigned nWidth, unsigned nHeight)
{
	if (nWidth == 0 || nHeight == 0 || nWidth > 8192 || nHeight > 8192)
	{
		return FALSE;
	}

	// scaled to fit (nearest pixel), centred on black
	memset (m_pPicture, 0, FrameWidth * FrameHeight);
	unsigned nW = FrameWidth, nH = nHeight * FrameWidth / nWidth;
	if (nH > FrameHeight)
	{
		nH = FrameHeight;
		nW = nWidth * FrameHeight / nHeight;
	}
	if (nW == 0) nW = 1;
	if (nH == 0) nH = 1;
	unsigned nX0 = (FrameWidth - nW) / 2, nY0 = (FrameHeight - nH) / 2;
	for (unsigned y = 0; y < nH; y++)
	{
		const u8 *pRow = pGrey + (y * nHeight / nH) * nWidth;
		u8 *pOut = m_pPicture + (nY0 + y) * FrameWidth + nX0;
		for (unsigned x = 0; x < nW; x++)
		{
			pOut[x] = pRow[x * nWidth / nW];
		}
	}

	m_Mode = ModePicture;
	return TRUE;
}

boolean CZgSynthCamera::PushFrame (const u8 *pGrey, unsigned nWidth, unsigned nHeight)
{
	if (nWidth == 0 || nHeight == 0 || nWidth > MaxPushSide || nHeight > MaxPushSide)
	{
		return FALSE;
	}

	if (m_pLive == 0 || nWidth * nHeight != m_nLiveWidth * m_nLiveHeight)
	{
		delete [] m_pLive;
		m_pLive = new u8[nWidth * nHeight];
	}
	memcpy (m_pLive, pGrey, nWidth * nHeight);
	m_nLiveWidth = nWidth;
	m_nLiveHeight = nHeight;
	m_nLiveSerial++;

	m_Mode = ModeLive;
	return TRUE;
}

boolean CZgSynthCamera::Start (void)
{
	if (m_Mode == ModeNone)
	{
		return FALSE;
	}

	m_bStreaming = TRUE;
	m_nNextFrameAt = 0;
	return TRUE;
}

void CZgSynthCamera::Stop (void)
{
	m_bStreaming = FALSE;
}

const char *CZgSynthCamera::GetError (void)
{
	return m_Mode == ModeNone ? "no camera" : 0;
}

void CZgSynthCamera::MakeFrame (void)
{
	// the picture plus noise of +-4 levels (xorshift32)
	u32 n = m_nNoise;
	for (unsigned i = 0; i < FrameWidth * FrameHeight; i++)
	{
		n ^= n << 13;
		n ^= n >> 17;
		n ^= n << 5;
		int v = m_pPicture[i] + (int) (n & 7) - 4;
		m_pFrame[i] = (u8) (v < 0 ? 0 : v > 255 ? 255 : v);
	}
	m_nNoise = n;
}

const u8 *CZgSynthCamera::GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight)
{
	if (!m_bStreaming || m_Mode == ModeNone)
	{
		return 0;
	}

	if (m_Mode == ModeLive)
	{
		// as pushed: the host sets the pace
		if (m_nTakenLive != m_nLiveSerial)
		{
			m_nTakenLive = m_nLiveSerial;
			m_nSerial++;
		}
		if (*pSerial == m_nSerial)
		{
			return 0;
		}
		*pSerial = m_nSerial;
		*pWidth = m_nLiveWidth;
		*pHeight = m_nLiveHeight;
		return m_pLive;
	}

	unsigned long long nNow = CTimer::GetClockTicks64 ();
	if (nNow >= m_nNextFrameAt)
	{
		MakeFrame ();
		m_nSerial++;
		m_nNextFrameAt = nNow + FrameTicks;
	}
	if (*pSerial == m_nSerial)
	{
		return 0;
	}

	*pSerial = m_nSerial;
	*pWidth = FrameWidth;
	*pHeight = FrameHeight;
	return m_pFrame;
}
