//
// testshot.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "testshot.h"
#include "testcrash.h"
#include <circle/bcmframebuffer.h>
#include <circle/logger.h>
#include <circle/string.h>
#include <circle/util.h>

CTestShot::CTestShot (CScreenDevice *pScreen, CSerialDevice *pSerial, CZgPiCamera *pPiCamera)
:	m_pScreen (pScreen),
	m_pSerial (pSerial),
	m_pPiCamera (pPiCamera),
	m_nLine (0)
{
	CZgCamera::Set (&m_Camera);
}

void CTestShot::Update (void)
{
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
					ZgTestCrash (m_Line + 7);
				}
				else if (strncmp (m_Line, "#camera ", 8) == 0)
				{
					Camera (m_Line + 8);
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

	// binary data: no NL -> CR NL translation while sending
	unsigned nOptions = m_pSerial->GetOptions ();
	m_pSerial->SetOptions (nOptions & ~SERIAL_OPTION_ONLCR);

	CString Header;
	Header.Format ("\nZGSHOT1 %u %u %u %u %08x\n", nWidth, nHeight, nBytes * 8, nLen, Crc32 (0, pOut, nLen));
	m_pSerial->Write ((const char *) Header, Header.GetLength ());
	for (unsigned i = 0; i < nLen; i += 1024)
	{
		m_pSerial->Write (pOut + i, nLen - i < 1024 ? nLen - i : 1024);
	}
	m_pSerial->Write ("\nZGEND\n", 7);

	m_pSerial->SetOptions (nOptions);

	delete [] pOut;
}

// (Logs what the camera shows, never the text: tests may use secrets.)
void CTestShot::Camera (const char *pArgs)
{
	CLogger *pLogger = CLogger::Get ();
	if (strcmp (pArgs, "pi") == 0)
	{
		if (m_pPiCamera->Probe ())
		{
			CZgCamera::Set (m_pPiCamera);
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
		const TZgIMX219Mode *pMode = CZgIMX219::GetMode (pArgs + 5);
		if (pMode == 0)
		{
			pLogger->Write ("camera", LogWarning, "#camera mode auto|%s", CZgIMX219::ModeNames);
			return;
		}
		m_pPiCamera->SetMode (pMode);
		pLogger->Write ("camera", LogNotice, "pi mode %s (from the next start)", pMode->pName);
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
				"#camera qr <text> | scene | none | synth | pi | pattern <n> | mode <name>");
		return;
	}
	CZgCamera::Set (&m_Camera);
}
