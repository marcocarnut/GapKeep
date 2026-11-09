//
// imx219.h
//
// The Sony IMX219 sensor of the Raspberry Pi Camera Module v2.1, over I2C
// (CCI): identification, the modes zerogap uses (RAW8 on two CSI-2 lanes,
// 30 frame/s, windows centred on the array, binned 2x2 or not), exposure and
// gain, and the test patterns. Written from docs/camera/SPEC.md (section 4);
// docs/camera/IMPLEMENTATION.md has the decisions.
//
// The sensor has no automatic exposure: CGkPiCamera computes it and calls
// SetExposure(). Powering the module (GPIO 41) is the caller's job; this
// class only talks to a powered sensor.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_imx219_h
#define _gk_imx219_h

#include <circle/i2cmaster.h>
#include <circle/types.h>

// A readout window, sent as nWidth x nHeight RAW8: binned 2x2 in the
// analogue domain (the window twice the output) or not (the same size)
struct TGkIMX219Mode
{
	const char *pName;
	u16 nXStart, nXEnd, nYStart, nYEnd;	// in the 3280 x 2464 array
	u16 nWidth, nHeight;			// sent, RAW8
	u8 nBinning;				// BINNING_MODE_H/V_A: 0 none, 3 analogue x2
};

class CGkIMX219
{
public:
	static const TGkIMX219Mode ModeCentre;	// 640x480 (SPEC 1)
	static const TGkIMX219Mode ModeFull;	// 1640x1232
	static const TGkIMX219Mode ModeDetail;	// 1280x960 unbinned centre (default)
	static const TGkIMX219Mode ModeWide;	// 1280x960 from 2560x1920 binned
	static const TGkIMX219Mode ModeMid;	// 1640x1232 unbinned centre

	// a mode by name, or 0
	static const TGkIMX219Mode *GetMode (const char *pName);
	// the names, for messages
	static const char ModeNames[];

	static const unsigned FrameLength = 1763;	// FRM_LENGTH_A, in its units
	static const unsigned MaxExposure = FrameLength - 4;
	static const unsigned MinExposure = 4;
	static const unsigned MaxAnalogueCode = 232;	// 10.67x
	static const unsigned MinDigitalGain = 0x100;	// 4.8 fixed point, 1.0x
	static const unsigned MaxDigitalGain = 0xFFF;

	CGkIMX219 (CI2CMaster *pI2C);

	// Reads MODEL_ID. TRUE: an IMX219 answered (*pID is what it said
	// whenever the bus answered at all, else 0).
	boolean Probe (u16 *pID);

	// Streams once, briefly, then back to standby: the sensor leaves its
	// lanes in LP-11 only after it has streamed (SPEC 4.2).
	boolean SettleLanes (void);

	// Writes the whole mode in standby (SPEC 4.3 A-E).
	boolean Configure (const TGkIMX219Mode &rMode, unsigned nExposure, unsigned nAnalogueCode,
			   unsigned nDigitalGain, unsigned nTestPattern);

	boolean StartStreaming (void);
	boolean StopStreaming (void);		// to software standby

	// Exposure (lines of FrameLength), analogue gain code and digital gain
	// in one I2C transfer, so the sensor latches them at the same V-sync.
	boolean SetExposure (unsigned nExposure, unsigned nAnalogueCode, unsigned nDigitalGain);

	// 0 off, 1 solid colour, 2 colour bars, ... 9 PN31 (SPEC 4.7)
	boolean SetTestPattern (unsigned nPattern);

	int GetLastResult (void) const		{ return m_nLastResult; }

private:
	boolean Write (u16 nRegister, const u8 *pValues, unsigned nCount);
	boolean Write8 (u16 nRegister, u8 uchValue);
	boolean Write16 (u16 nRegister, u16 usValue);
	boolean Read (u16 nRegister, u8 *pValues, unsigned nCount);

private:
	CI2CMaster *m_pI2C;
	int m_nLastResult;		// of the last failed transfer (Circle's codes)
};

#endif
