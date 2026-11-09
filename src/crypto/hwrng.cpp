//
// hwrng.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "hwrng.h"
#include "sha256.h"
#include <circle/logger.h>
#include <circle/util.h>
#include <assert.h>

static const char FromRNG[] = "rng";

// SP 800-90B 4.4.1: C = 1 + ceil(-log2(alpha) / H), alpha = 2^-20, H = 1
static const unsigned RCTCutoff = 21;

// SP 800-90B 4.4.2: window 512 (non-binary), H = 1, alpha = 2^-20
static const unsigned APTWindow = 512;
static const unsigned APTCutoff = 410;

static const unsigned StartupBytes = 4096;
static const unsigned RawPerBlock = 256;	// 8:1 conditioning

CGkRandom *CGkRandom::s_pThis = 0;

CGkRandom::CGkRandom (void)
:	m_bHealthy (FALSE),
	m_pFailure ("not initialized"),
	m_nWord (0),
	m_nWordBytes (0),
	m_nRCTLast (0),
	m_nRCTCount (0),
	m_nAPTRef (0),
	m_nAPTCount (0),
	m_nAPTIndex (0),
	m_nRawBytes (0),
	m_nBlocks (0)
{
	assert (s_pThis == 0);
	s_pThis = this;
}

boolean CGkRandom::Initialize (void)
{
	int nResult = gk_sha256_selftest ();
	if (nResult != 0)
	{
		CLogger::Get ()->Write (FromRNG, LogError, "SHA-256 self-test failed (%d)", nResult);
		Fail ("SHA-256 self-test failed");
		return FALSE;
	}

	m_bHealthy = TRUE;
	m_pFailure = 0;

	u8 Buffer[256];
	for (unsigned i = 0; i < StartupBytes / sizeof Buffer; i++)
	{
		if (!FillRaw (Buffer, sizeof Buffer))
		{
			break;
		}
	}
	memset (Buffer, 0, sizeof Buffer);

	if (m_bHealthy)
	{
		CLogger::Get ()->Write (FromRNG, LogNotice, "Hardware RNG passed startup tests (%u bytes)",
					StartupBytes);
	}

	return m_bHealthy;
}

void CGkRandom::Fail (const char *pReason)
{
	if (m_bHealthy)
	{
		CLogger::Get ()->Write (FromRNG, LogError, "Hardware RNG disabled: %s", pReason);
	}
	m_bHealthy = FALSE;
	m_pFailure = pReason;
}

boolean CGkRandom::RawByte (u8 *pByte)
{
	if (m_nWordBytes == 0)
	{
		m_nWord = m_RNG.GetNumber ();
		m_nWordBytes = 4;
	}

	u8 b = (u8) m_nWord;
	m_nWord >>= 8;
	m_nWordBytes--;
	m_nRawBytes++;

	// Repetition Count Test
	if (m_nRCTCount > 0 && b == m_nRCTLast)
	{
		if (++m_nRCTCount >= RCTCutoff)
		{
			Fail ("repetition count test failed");
			return FALSE;
		}
	}
	else
	{
		m_nRCTLast = b;
		m_nRCTCount = 1;
	}

	// Adaptive Proportion Test
	if (m_nAPTIndex == 0)
	{
		m_nAPTRef = b;
		m_nAPTCount = 1;
	}
	else if (b == m_nAPTRef)
	{
		if (++m_nAPTCount >= APTCutoff)
		{
			Fail ("adaptive proportion test failed");
			return FALSE;
		}
	}
	if (++m_nAPTIndex == APTWindow)
	{
		m_nAPTIndex = 0;
	}

	*pByte = b;

	return TRUE;
}

boolean CGkRandom::FillRaw (u8 *pBuffer, unsigned nLength)
{
	for (unsigned i = 0; i < nLength; i++)
	{
		if (!m_bHealthy || !RawByte (&pBuffer[i]))
		{
			return FALSE;
		}
	}

	return TRUE;
}

boolean CGkRandom::Get (void *pBuffer, unsigned nLength)
{
	u8 *pOut = (u8 *) pBuffer;
	u8 Raw[RawPerBlock];
	u8 Digest[GK_SHA256_DIGEST_SIZE];
	boolean bOK = m_bHealthy;

	while (bOK && nLength > 0)
	{
		if (!FillRaw (Raw, sizeof Raw))
		{
			bOK = FALSE;
			break;
		}

		gk_sha256_t Ctx;
		static const char Label[] = "gapkeep hwrng v1";
		gk_sha256_init (&Ctx);
		gk_sha256_update (&Ctx, Label, sizeof Label);
		gk_sha256_update (&Ctx, &m_nBlocks, sizeof m_nBlocks);
		gk_sha256_update (&Ctx, Raw, sizeof Raw);
		gk_sha256_final (&Ctx, Digest);
		m_nBlocks++;

		unsigned n = nLength < sizeof Digest ? nLength : sizeof Digest;
		memcpy (pOut, Digest, n);
		pOut += n;
		nLength -= n;
	}

	memset (Raw, 0, sizeof Raw);
	memset (Digest, 0, sizeof Digest);

	if (!bOK)
	{
		memset (pBuffer, 0, (pOut - (u8 *) pBuffer) + nLength);
	}

	return bOK;
}
