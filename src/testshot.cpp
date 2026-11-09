//
// testshot.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "testshot.h"
#include "testpictures.h"
#include "runtime/settings.h"
#include "runtime/i18n.h"
#include "runtime/keylayout.h"
#include "runtime/ttfstyles.h"
#include "testcrash.h"
#include <circle/bcmframebuffer.h>
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/string.h>
#include <circle/util.h>

CTestShot::CTestShot (CScreenDevice *pScreen, CSerialDevice *pSerial, CGkPiCamera *pPiCamera)
:	m_pScreen (pScreen),
	m_pSerial (pSerial),
	m_pPiCamera (pPiCamera),
	m_nLine (0),
	m_bRawPending (FALSE)
{
	CGkCamera::Set (&m_Camera);
}

void CTestShot::Update (void)
{
	if (m_bRawPending)
	{
		SendRaw ();
	}

	char Buf[16];
	int n;
	while ((n = m_pSerial->Read (Buf, sizeof Buf)) > 0)
	{
		for (int i = 0; i < n; i++)
		{
			char c = Buf[i];
			if (c == '\n' || c == '\r')
			{
				m_Line[m_nLine] = '\0';
				if (strcmp (m_Line, "#shot") == 0)
				{
					Send ();
				}
				else if (strncmp (m_Line, "#crash ", 7) == 0)
				{
					GkTestCrash (m_Line + 7);
				}
				else if (strcmp (m_Line, "#experimental on") == 0)
				{
					CGkSettings::SetExperimental (TRUE, "serial line, test build");
				}
				else if (strcmp (m_Line, "#fonts") == 0)
				{
					GkStyledFontStats ();
				}
				else if (strcmp (m_Line, "#redraw") == 0)
				{
					// the whole screen drawn again, now: what a frame costs
					lv_obj_invalidate (lv_screen_active ());
					unsigned nStart = CTimer::GetClockTicks ();
					lv_refr_now (0);
					CLogger::Get ()->Write ("testshot", LogNotice, "redraw: %u us",
								CTimer::GetClockTicks () - nStart);
				}
				else if (strncmp (m_Line, "#keyboard ", 10) == 0)
				{
					GkKeyLayoutSet (m_Line + 10, "serial line, test build");
				}
				else if (strncmp (m_Line, "#camera ", 8) == 0)
				{
					Camera (m_Line + 8);
				}
				else if (strncmp (m_Line, "#language ", 10) == 0)
				{
					// for the apps started from now on
					CGkI18n::SetLanguage (m_Line + 10, "serial line, test build");
				}
				m_nLine = 0;
			}
			else if (m_nLine < sizeof m_Line - 1)
			{
				m_Line[m_nLine++] = c;
			}
		}
	}
}

static u32 Crc32 (u32 nCrc, const u8 *p, unsigned n)
{
	nCrc = ~nCrc;
	while (n--)
	{
		nCrc ^= *p++;
		for (int k = 0; k < 8; k++)
		{
			nCrc = (nCrc >> 1) ^ (0xEDB88320 & -(nCrc & 1));
		}
	}
	return ~nCrc;
}

void CTestShot::Send (void)
{
	CBcmFrameBuffer *pFB = m_pScreen->GetFrameBuffer ();
	unsigned nWidth = pFB->GetWidth ();
	unsigned nHeight = pFB->GetHeight ();
	unsigned nBytes = pFB->GetDepth () / 8;
	unsigned nPitch = pFB->GetPitch ();
	const u8 *pBase = (const u8 *) (uintptr) pFB->GetBuffer ();

	// encode into a heap buffer first, so the header can carry length and CRC
	unsigned nMax = nWidth * nHeight * (2 + nBytes);
	u8 *pOut = new u8[nMax];
	unsigned nLen = 0;

	u32 nRunPixel = 0;
	unsigned nRun = 0;
	for (unsigned y = 0; y < nHeight; y++)
	{
		const u8 *pRow = pBase + y * nPitch;
		for (unsigned x = 0; x < nWidth; x++)
		{
			u32 nPixel = 0;
			memcpy (&nPixel, pRow + x * nBytes, nBytes);
			if (nRun > 0 && (nPixel != nRunPixel || nRun == 0xFFFF))
			{
				pOut[nLen++] = nRun & 0xFF;
				pOut[nLen++] = nRun >> 8;
				memcpy (pOut + nLen, &nRunPixel, nBytes);
				nLen += nBytes;
				nRun = 0;
			}
			nRunPixel = nPixel;
			nRun++;
		}
	}
	if (nRun > 0)
	{
		pOut[nLen++] = nRun & 0xFF;
		pOut[nLen++] = nRun >> 8;
		memcpy (pOut + nLen, &nRunPixel, nBytes);
		nLen += nBytes;
	}

	CString Header;
	Header.Format ("\nZGSHOT1 %u %u %u %u %08x\n", nWidth, nHeight, nBytes * 8, nLen, Crc32 (0, pOut, nLen));
	SendBinary (Header, pOut, nLen);

	delete [] pOut;
}

void CTestShot::SendBinary (const CString &rHeader, const u8 *pData, unsigned nLength)
{
	// binary data: no NL -> CR NL translation while sending
	unsigned nOptions = m_pSerial->GetOptions ();
	m_pSerial->SetOptions (nOptions & ~SERIAL_OPTION_ONLCR);

	m_pSerial->Write ((const char *) rHeader, rHeader.GetLength ());
	for (unsigned i = 0; i < nLength; i += 1024)
	{
		m_pSerial->Write (pData + i, nLength - i < 1024 ? nLength - i : 1024);
	}
	m_pSerial->Write ("\nZGEND\n", 7);

	m_pSerial->SetOptions (nOptions);
}

// once the camera has copied a frame (it needs to be streaming)
void CTestShot::SendRaw (void)
{
	unsigned nWidth, nHeight, nStride, nExposure, nAnalogue, nDigital;
	const u8 *pRaw = m_pPiCamera->GetRaw (&nWidth, &nHeight, &nStride, &nExposure, &nAnalogue, &nDigital);
	if (pRaw == 0)
	{
		return;
	}
	m_bRawPending = FALSE;
	unsigned nLength = nStride * nHeight;
	CString Header;
	Header.Format ("\nZGRAW1 %u %u %u %u %u %u %u %08x\n", nWidth, nHeight, nStride,
		       nExposure, nAnalogue, nDigital, nLength, Crc32 (0, pRaw, nLength));
	SendBinary (Header, pRaw, nLength);
}

void CTestShot::SendGrey (void)
{
	unsigned nWidth, nHeight;
	const u8 *pGrey = m_pPiCamera->GetGrey (&nWidth, &nHeight);
	if (pGrey == 0)
	{
		CLogger::Get ()->Write ("camera", LogWarning, "#camera grey: the Pi Camera isn't streaming");
		return;
	}
	unsigned nLength = nWidth * nHeight;
	CString Header;
	Header.Format ("\nZGRAW1 %u %u %u 0 0 0 %u %08x\n", nWidth, nHeight, nWidth,
		       nLength, Crc32 (0, pGrey, nLength));
	SendBinary (Header, pGrey, nLength);
}

// (Logs what the camera shows, never the text: tests may use secrets.)
void CTestShot::Camera (const char *pArgs)
{
	CLogger *pLogger = CLogger::Get ();
	if (strcmp (pArgs, "pi") == 0)
	{
		if (m_pPiCamera->Probe ())
		{
			CGkCamera::Set (m_pPiCamera);
			pLogger->Write ("camera", LogNotice, "pi");
		}
		else
		{
			pLogger->Write ("camera", LogWarning, "no Pi Camera: still the synthetic one");
		}
		return;
	}
	if (strcmp (pArgs, "mode auto") == 0)
	{
		m_pPiCamera->SetMode (0);
		pLogger->Write ("camera", LogNotice, "pi mode auto: from the scanner's field");
		return;
	}
	if (strncmp (pArgs, "mode ", 5) == 0)
	{
		const TGkIMX219Mode *pMode = CGkIMX219::GetMode (pArgs + 5);
		if (pMode == 0)
		{
			pLogger->Write ("camera", LogWarning, "#camera mode auto|%s", CGkIMX219::ModeNames);
			return;
		}
		m_pPiCamera->SetMode (pMode);
		pLogger->Write ("camera", LogNotice, "pi mode %s (from the next start)", pMode->pName);
		return;
	}
	if (strncmp (pArgs, "picture ", 8) == 0)
	{
		// a test picture (testpictures.h), unpacked
		const TGkTestPicture *p = gk_test_pictures;
		while (p->pName != 0 && strcmp (p->pName, pArgs + 8) != 0)
		{
			p++;
		}
		if (p->pName == 0)
		{
			pLogger->Write ("camera", LogWarning, "#camera picture: no test picture \"%s\"", pArgs + 8);
			return;
		}
		unsigned nSize = p->nWidth * p->nHeight * 3;
		u8 *pRGB = new u8[nSize];
		unsigned nOut = 0;
		for (unsigned i = 0; i + 4 <= p->nLength && nOut < nSize; i += 4)
		{
			for (unsigned n = p->pRuns[i]; n > 0 && nOut + 3 <= nSize; n--)
			{
				memcpy (pRGB + nOut, p->pRuns + i + 1, 3);
				nOut += 3;
			}
		}
		if (nOut == nSize && m_Camera.SetPictureRGB (pRGB, p->nWidth, p->nHeight))
		{
			CGkCamera::Set (&m_Camera);
			pLogger->Write ("camera", LogNotice, "a colour picture, %ux%u", p->nWidth, p->nHeight);
		}
		else
		{
			pLogger->Write ("camera", LogWarning, "#camera picture %s: damaged", p->pName);
		}
		delete [] pRGB;
		return;
	}
	if (strcmp (pArgs, "grey") == 0)
	{
		if (m_pPiCamera == 0)
		{
			pLogger->Write ("camera", LogWarning, "#camera grey: no Pi Camera");
			return;
		}
		SendGrey ();
		return;
	}
	if (strcmp (pArgs, "raw") == 0)
	{
		if (m_pPiCamera == 0)
		{
			pLogger->Write ("camera", LogWarning, "#camera raw: no Pi Camera");
			return;
		}
		m_pPiCamera->RequestRaw ();
		m_bRawPending = TRUE;
		pLogger->Write ("camera", LogNotice, "raw frame requested");
		return;
	}
	if (strncmp (pArgs, "pattern ", 8) == 0)
	{
		char *pEnd;
		unsigned long nPattern = strtoul (pArgs + 8, &pEnd, 10);
		if (pEnd == pArgs + 8 || *pEnd != '\0' || nPattern > 9)
		{
			pLogger->Write ("camera", LogWarning, "#camera pattern <0..9>");
			return;
		}
		m_pPiCamera->SetTestPattern ((unsigned) nPattern);
		return;
	}

	// everything else is the synthetic camera's
	if (strncmp (pArgs, "qr ", 3) == 0)
	{
		unsigned nLength = strlen (pArgs + 3);
		if (m_Camera.SetQR ((const u8 *) pArgs + 3, nLength))
		{
			pLogger->Write ("camera", LogNotice, "a QR code of %u bytes", nLength);
		}
		else
		{
			pLogger->Write ("camera", LogWarning, "too long for a QR code");
		}
	}
	else if (strcmp (pArgs, "scene") == 0)
	{
		m_Camera.SetScene ();
		pLogger->Write ("camera", LogNotice, "scene");
	}
	else if (strcmp (pArgs, "none") == 0)
	{
		m_Camera.SetNone ();
		pLogger->Write ("camera", LogNotice, "none");
	}
	else if (strcmp (pArgs, "synth") == 0)
	{
		m_pPiCamera->SetMode (0);	// a fresh start for the next "#camera pi"
		pLogger->Write ("camera", LogNotice, "synthetic (%s)", m_Camera.GetMode ());
	}
	else
	{
		pLogger->Write ("camera", LogWarning,
				"#camera qr <text> | picture <name> | scene | none | synth | pi | grey | raw | pattern <n> | mode <name>");
		return;
	}
	CGkCamera::Set (&m_Camera);
}
