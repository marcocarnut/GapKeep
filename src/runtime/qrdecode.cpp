//
// qrdecode.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "qrdecode.h"
#include <circle/util.h>

#ifdef ZG_HAVE_QUIRC

#include <quirc.h>

static const unsigned MaxCodes = 4;

static struct quirc *s_pQuirc = 0;
static unsigned s_nWidth = 0, s_nHeight = 0;
static u8 s_Payload[MaxCodes][ZG_QR_MAX_PAYLOAD];

int ZgDecodeQR (const u8 *pGrey, unsigned nWidth, unsigned nHeight,
		TZgQRCode *pCodes, unsigned nMax)
{
	if (s_pQuirc == 0)
	{
		s_pQuirc = quirc_new ();
		if (s_pQuirc == 0)
		{
			return 0;
		}
	}
	if (nWidth != s_nWidth || nHeight != s_nHeight)
	{
		if (quirc_resize (s_pQuirc, (int) nWidth, (int) nHeight) < 0)
		{
			s_nWidth = s_nHeight = 0;
			return 0;
		}
		s_nWidth = nWidth;
		s_nHeight = nHeight;
	}

	int w, h;
	u8 *pImage = quirc_begin (s_pQuirc, &w, &h);
	if ((unsigned) w != nWidth || (unsigned) h != nHeight)
	{
		return 0;
	}
	memcpy (pImage, pGrey, nWidth * nHeight);
	quirc_end (s_pQuirc);

	if (nMax > MaxCodes)
	{
		nMax = MaxCodes;
	}

	int nFound = 0;
	int nCount = quirc_count (s_pQuirc);
	for (int i = 0; i < nCount && (unsigned) nFound < nMax; i++)
	{
		static struct quirc_code Code;		// large: not on the stack
		static struct quirc_data Data;
		quirc_extract (s_pQuirc, i, &Code);
		quirc_decode_error_t Err = quirc_decode (&Code, &Data);
		if (Err == QUIRC_ERROR_DATA_ECC)
		{
			// perhaps seen in a mirror (or through the back of a screen)
			quirc_flip (&Code);
			Err = quirc_decode (&Code, &Data);
		}
		if (   Err != QUIRC_SUCCESS
		    || Data.payload_len < 0
		    || (unsigned) Data.payload_len > ZG_QR_MAX_PAYLOAD)
		{
			continue;
		}

		memcpy (s_Payload[nFound], Data.payload, Data.payload_len);
		pCodes[nFound].pData = s_Payload[nFound];
		pCodes[nFound].nLength = (unsigned) Data.payload_len;
		for (int k = 0; k < 4; k++)
		{
			pCodes[nFound].Corners[k][0] = Code.corners[k].x;
			pCodes[nFound].Corners[k][1] = Code.corners[k].y;
		}
		nFound++;
	}

	return nFound;
}

#else

int ZgDecodeQR (const u8 *pGrey, unsigned nWidth, unsigned nHeight,
		TZgQRCode *pCodes, unsigned nMax)
{
	(void) pGrey; (void) nWidth; (void) nHeight; (void) pCodes; (void) nMax;
	return -1;
}

#endif
