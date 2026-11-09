//
// hwrng.h
//
// Health-checked random bytes from the BCM2835 hardware RNG.
//
// The BCM2835 RNG is undocumented hardware, so zerogap treats it as a noise
// source of unknown quality, not as a finished random number generator:
//
//  - Every raw byte passes the two continuous health tests of NIST SP 800-90B
//    (section 4.4): the Repetition Count Test and the Adaptive Proportion
//    Test, with cutoffs for an assumed min-entropy of only 1 bit per byte
//    and a false-alarm probability of 2^-20.
//  - 4096 raw bytes are tested at startup before anything is handed out.
//  - Each 32-byte output block is SHA-256 over 256 raw bytes (8:1), i.e. it
//    holds full entropy as long as the source delivers at least 1 bit per
//    byte, the level the health tests are tuned to.
//  - A failed test latches: the generator refuses all further requests
//    until reboot. Callers get an error, never weak bytes.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_hwrng_h
#define _gk_hwrng_h

#include <circle/bcmrandom.h>
#include <circle/types.h>

class CGkRandom
{
public:
	CGkRandom (void);

	// Runs the SHA-256 self-test and the startup health test.
	boolean Initialize (void);

	// Fills pBuffer with nLength random bytes. FALSE if the generator has
	// failed (pBuffer is then zeroed).
	boolean Get (void *pBuffer, unsigned nLength);

	boolean IsHealthy (void) const		{ return m_bHealthy; }
	const char *GetFailure (void) const	{ return m_pFailure; }
	u64 GetRawBytes (void) const		{ return m_nRawBytes; }

	static CGkRandom *Instance (void)	{ return s_pThis; }

private:
	boolean RawByte (u8 *pByte);
	boolean FillRaw (u8 *pBuffer, unsigned nLength);
	void Fail (const char *pReason);

private:
	CBcmRandomNumberGenerator m_RNG;

	boolean m_bHealthy;
	const char *m_pFailure;

	u32 m_nWord;			// raw 32-bit sample being consumed
	unsigned m_nWordBytes;		// bytes left in m_nWord

	u8 m_nRCTLast;			// Repetition Count Test
	unsigned m_nRCTCount;

	u8 m_nAPTRef;			// Adaptive Proportion Test
	unsigned m_nAPTCount;
	unsigned m_nAPTIndex;

	u64 m_nRawBytes;
	u64 m_nBlocks;

	static CGkRandom *s_pThis;
};

#endif
