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

CGkSynthCamera::CGkSynthCamera (void)
:	m_Mode (ModeScene),
	m_bStreaming (FALSE),
	m_pPicture (new u8[FrameWidth * FrameHeight]),
	m_nPictureWidth (FrameWidth),
	m_nPictureHeight (FrameHeight),
	m_pFrame (new u8[FrameWidth * FrameHeight]),
	m_Field (GkFieldCenter),
	m_pSource (0),
	m_nSourceChannels (1),
	m_pPictureRGB (0),
	m_bPictureRGB (FALSE),
	m_bColour (FALSE),
	m_pFrameRGB (0),
	m_nSourceSize (0),
	m_nSourceWidth (0),
	m_nSourceHeight (0),
	m_nSerial (0),
	m_nLiveSerial (0),
	m_nTakenLive (0),
	m_nNextFrameAt (0),
	m_nNoise (0x2545F491)
{
	DrawScene ();
}

CGkSynthCamera::~CGkSynthCamera (void)
{
	delete [] m_pPicture;
	delete [] m_pFrame;
	delete [] m_pSource;
	delete [] m_pPictureRGB;
	delete [] m_pFrameRGB;
}

const char *CGkSynthCamera::GetMode (void) const
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
void CGkSynthCamera::DrawScene (void)
{
	m_bPictureRGB = FALSE;
	m_nPictureWidth = FrameWidth;
	m_nPictureHeight = FrameHeight;
	for (unsigned y = 0; y < FrameHeight; y++)
	{
		for (unsigned x = 0; x < FrameWidth; x++)
		{
			m_pPicture[y * FrameWidth + x] = (u8) (70 + (x + 2 * y) * 80 / (FrameWidth + 2 * FrameHeight));
		}
	}
}

void CGkSynthCamera::SetNone (void)
{
	m_Mode = ModeNone;
}

void CGkSynthCamera::SetScene (void)
{
	m_Mode = ModeScene;
	DrawScene ();
}

boolean CGkSynthCamera::SetQR (const u8 *pData, unsigned nLength)
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

	DrawScene ();		// grey: no colour picture any more

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

// A picture or a live frame keeps its own resolution; each frame is made
// from it as the field asks, as a real camera's would be: the middle at
// full detail, or all of it, averaged down (less detail per degree).
boolean CGkSynthCamera::SetSource (const u8 *pPixels, unsigned nChannels, unsigned nWidth,
				   unsigned nHeight, unsigned nMaxSide)
{
	if (nWidth == 0 || nHeight == 0 || nWidth > nMaxSide || nHeight > nMaxSide)
	{
		return FALSE;
	}

	unsigned nSize = nWidth * nHeight * nChannels;
	if (m_pSource == 0 || nSize > m_nSourceSize)
	{
		delete [] m_pSource;
		m_pSource = new u8[nSize];
		m_nSourceSize = nSize;
	}
	memcpy (m_pSource, pPixels, nSize);
	m_nSourceWidth = nWidth;
	m_nSourceHeight = nHeight;
	m_nSourceChannels = nChannels;
	return TRUE;
}

// the colour picture's grey, as the Pi camera's: (R + 2G + B) / 4
void CGkSynthCamera::Greys (void)
{
	const u8 *p = m_pPictureRGB;
	for (unsigned i = 0; i < m_nPictureWidth * m_nPictureHeight; i++, p += 3)
	{
		m_pPicture[i] = (u8) ((p[0] + 2 * p[1] + p[2]) / 4);
	}
}

void CGkSynthCamera::Derive (void)
{
	unsigned W = m_nSourceWidth, H = m_nSourceHeight, C = m_nSourceChannels;
	m_bPictureRGB = C == 3;
	if (m_bPictureRGB && m_pPictureRGB == 0)
	{
		m_pPictureRGB = new u8[FrameWidth * FrameHeight * 3];
	}
	u8 *pOut = m_bPictureRGB ? m_pPictureRGB : m_pPicture;

	if (m_Field == GkFieldCenter || (W <= FrameWidth && H <= FrameHeight))
	{
		// the middle, pixel for pixel
		unsigned w = W < FrameWidth ? W : FrameWidth;
		unsigned h = H < FrameHeight ? H : FrameHeight;
		unsigned x0 = (W - w) / 2, y0 = (H - h) / 2;
		for (unsigned y = 0; y < h; y++)
		{
			memcpy (pOut + y * w * C, m_pSource + ((y0 + y) * W + x0) * C, w * C);
		}
		m_nPictureWidth = w;
		m_nPictureHeight = h;
		if (m_bPictureRGB)
		{
			Greys ();
		}
		return;
	}

	// all of it, scaled down to fit, each pixel the average of its area
	unsigned w = FrameWidth, h = H * FrameWidth / W;
	if (h > FrameHeight)
	{
		h = FrameHeight;
		w = W * FrameHeight / H;
	}
	if (w == 0) w = 1;
	if (h == 0) h = 1;
	for (unsigned y = 0; y < h; y++)
	{
		unsigned sy0 = y * H / h, sy1 = (y + 1) * H / h;
		for (unsigned x = 0; x < w; x++)
		{
			unsigned sx0 = x * W / w, sx1 = (x + 1) * W / w;
			for (unsigned c = 0; c < C; c++)
			{
				unsigned nSum = 0;
				for (unsigned sy = sy0; sy < sy1; sy++)
				{
					const u8 *pRow = m_pSource + sy * W * C + c;
					for (unsigned sx = sx0; sx < sx1; sx++)
					{
						nSum += pRow[sx * C];
					}
				}
				pOut[(y * w + x) * C + c] = (u8) (nSum / ((sy1 - sy0) * (sx1 - sx0)));
			}
		}
	}
	m_nPictureWidth = w;
	m_nPictureHeight = h;
	if (m_bPictureRGB)
	{
		Greys ();
	}
}

void CGkSynthCamera::SetField (TGkCameraField Field)
{
	m_Field = Field;
	if (m_Mode == ModePicture)
	{
		Derive ();
	}
	if (m_Mode == ModeLive)
	{
		m_nTakenLive = m_nLiveSerial - 1;	// the last frame is made again
	}
}

boolean CGkSynthCamera::SetPicture (const u8 *pGrey, unsigned nWidth, unsigned nHeight)
{
	if (!SetSource (pGrey, 1, nWidth, nHeight, MaxPictureSide))
	{
		return FALSE;
	}
	Derive ();
	m_Mode = ModePicture;
	return TRUE;
}

boolean CGkSynthCamera::SetPictureRGB (const u8 *pRGB, unsigned nWidth, unsigned nHeight)
{
	if (!SetSource (pRGB, 3, nWidth, nHeight, MaxColourSide))
	{
		return FALSE;
	}
	Derive ();
	m_Mode = ModePicture;
	return TRUE;
}

boolean CGkSynthCamera::PushFrame (const u8 *pGrey, unsigned nWidth, unsigned nHeight)
{
	if (!SetSource (pGrey, 1, nWidth, nHeight, MaxPushSide))
	{
		return FALSE;
	}
	m_nLiveSerial++;
	m_Mode = ModeLive;
	return TRUE;
}

boolean CGkSynthCamera::PushFrameRGB (const u8 *pRGB, unsigned nWidth, unsigned nHeight)
{
	if (!SetSource (pRGB, 3, nWidth, nHeight, MaxPushSide))
	{
		return FALSE;
	}
	m_nLiveSerial++;
	m_Mode = ModeLive;
	return TRUE;
}

boolean CGkSynthCamera::Start (void)
{
	if (m_Mode == ModeNone)
	{
		return FALSE;
	}

	if (m_bColour && m_pFrameRGB == 0)
	{
		m_pFrameRGB = new u8[FrameWidth * FrameHeight * 3];
	}
	m_bStreaming = TRUE;
	m_nNextFrameAt = 0;
	return TRUE;
}

void CGkSynthCamera::Stop (void)
{
	m_bStreaming = FALSE;
}

const char *CGkSynthCamera::GetError (void)
{
	return m_Mode == ModeNone ? "no camera" : 0;
}

static inline u8 Clamp (int v)
{
	return (u8) (v < 0 ? 0 : v > 255 ? 255 : v);
}

void CGkSynthCamera::MakeFrame (void)
{
	// the picture plus noise of +-4 levels (xorshift32); in colour, the
	// same noise on each channel, so the grey frame stays its grey
	boolean bColour = m_bColour && m_pFrameRGB != 0;
	u32 n = m_nNoise;
	for (unsigned i = 0; i < m_nPictureWidth * m_nPictureHeight; i++)
	{
		n ^= n << 13;
		n ^= n >> 17;
		n ^= n << 5;
		int d = (int) (n & 7) - 4;
		m_pFrame[i] = Clamp (m_pPicture[i] + d);
		if (bColour)
		{
			const u8 *pIn = m_bPictureRGB ? m_pPictureRGB + 3 * i : 0;
			for (unsigned c = 0; c < 3; c++)
			{
				m_pFrameRGB[3 * i + c] = Clamp ((pIn ? pIn[c] : m_pPicture[i]) + d);
			}
		}
	}
	m_nNoise = n;
}

const u8 *CGkSynthCamera::GetColourFrame (void)
{
	if (!m_bColour || m_pFrameRGB == 0)
	{
		return 0;
	}
	if (m_Mode == ModeLive)
	{
		// as pushed, without noise: the picture itself
		if (m_bPictureRGB)
		{
			return m_pPictureRGB;
		}
		for (unsigned i = 0; i < m_nPictureWidth * m_nPictureHeight; i++)
		{
			m_pFrameRGB[3 * i] = m_pFrameRGB[3 * i + 1] = m_pFrameRGB[3 * i + 2] = m_pPicture[i];
		}
	}
	return m_pFrameRGB;
}

const u8 *CGkSynthCamera::GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight)
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
			Derive ();
			m_nSerial++;
		}
		if (*pSerial == m_nSerial)
		{
			return 0;
		}
		*pSerial = m_nSerial;
		*pWidth = m_nPictureWidth;
		*pHeight = m_nPictureHeight;
		return m_pPicture;
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
	*pWidth = m_nPictureWidth;
	*pHeight = m_nPictureHeight;
	return m_pFrame;
}
