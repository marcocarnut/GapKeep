//
// picamera.h
//
// The Raspberry Pi Camera Module v2.1 (Sony IMX219) on the Pi Zero v1.3's
// camera connector, as a CZgCamera (src/runtime/camera.h): power (GPIO 41),
// the sensor over I2C 0 on GPIO 28/29 (imx219.h), the CSI-2 receiver
// Unicam1 (unicam.h), and what the scanner needs from them: 8-bit grey
// frames, the average of each 2x2 Bayer tile of the sensor's RAW8 (640x480
// from the unbinned centre 1280x960 by default), with an automatic exposure
// the sensor itself lacks.
//
// Written from docs/camera/SPEC.md, without other camera drivers' code
// (docs/camera/IMPLEMENTATION.md). Kernel only: this is Circle-specific,
// and the simulator has its synthetic camera.
//
// The module is powered only while it streams: Probe() powers it just long
// enough to read the sensor's chip ID, and Stop() powers it down.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _zg_picamera_h
#define _zg_picamera_h

#include "../runtime/camera.h"
#include "imx219.h"
#include "unicam.h"
#include <circle/gpiopin.h>
#include <circle/i2cmaster.h>
#include <circle/types.h>

class CZgPiCamera : public CZgCamera
{
public:
	CZgPiCamera (void);
	~CZgPiCamera (void);

	// Is a camera there? Powers it for about 20 ms, reads the chip ID
	// (logged), powers it down again.
	boolean Probe (void);

	// The sensor's test pattern (0 off, 2 colour bars, ...; SPEC 4.7),
	// now if streaming, else from the next Start(). While a pattern is on,
	// the automatic exposure rests (the pattern does not depend on it).
	void SetTestPattern (unsigned nPattern);

	// What frames show, from the next Start(): the centre at full detail
	// ("detail": 1280x960 unbinned, 640x480 grey) or the whole view
	// ("full": 3280x2464 binned, 820x616 grey). The scanner sets it.
	void SetField (TZgCameraField Field)		{ m_Field = Field; }

	// A mode (imx219.h) that overrides the field, for tests; 0: the
	// field decides again. The grey frame is half its size each way.
	void SetMode (const TZgIMX219Mode *pMode)	{ m_pForcedMode = pMode; }

	boolean Start (void);
	void Stop (void);
	const u8 *GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight);
	const char *GetError (void);

	// Test builds: a copy of the next raw frame (RAW8 Bayer, as the sensor
	// sends it), for looking at the colours (testshot.h, "#camera raw").
	// GetRaw returns it once it is there, 0 before; it stays until the
	// next RequestRaw.
	void RequestRaw (void);

	// Test builds: the grey frame made last, while streaming ("#camera
	// grey", testshot.h). 0 otherwise.
	const u8 *GetGrey (unsigned *pWidth, unsigned *pHeight) const;

	// colour (camera.h): linear, black level removed, no white balance
	void SetColour (boolean bColour)		{ m_bColour = bColour; }
	const u8 *GetColourFrame (void)			{ return m_bColour ? m_pRGB : 0; }
	boolean IsLinear (void) const			{ return TRUE; }
	const u8 *GetRaw (unsigned *pWidth, unsigned *pHeight, unsigned *pStride,
			  unsigned *pExposure, unsigned *pAnalogue, unsigned *pDigital) const;

private:
	boolean PowerUp (void);
	void PowerDown (void);
	boolean StartStreaming (void);
	void Fail (const char *pError);

	void ToGrey (const u8 *pRaw);
	void ToColour (const u8 *pRaw);
	void AutoExposure (void);
	void SetProduct (double fProduct);
	void Watch (void);			// errors, frame rate, stalls

private:
	CGPIOPin m_Power;		// GPIO 41: the module's regulators
	CGPIOPin m_LED;			// GPIO 32: a v1 module's LED (a v2 has none)
	CI2CMaster *m_pI2C;		// only while powered
	CZgIMX219 *m_pSensor;
	CZgUnicam m_Unicam;

	boolean m_bPowered;
	boolean m_bStreaming;
	const char *m_pError;
	unsigned m_nTestPattern;
	TZgCameraField m_Field;
	const TZgIMX219Mode *m_pForcedMode;	// or 0
	const TZgIMX219Mode *m_pMode;		// of the current or last Start()

	unsigned m_nStride;		// of the raw frames
	unsigned m_nWidth;		// of the grey frames: half the sensor's
	unsigned m_nHeight;
	u8 *m_pGrey;			// m_nWidth x m_nHeight
	boolean m_bColour;		// make colour frames too (SetColour)
	u8 *m_pRGB;			// m_nWidth x m_nHeight x 3, if m_bColour
	unsigned m_nRGBSize;		// allocated
	u8 m_Linear[256];		// a RAW8 value -> black level removed
	u8 m_LinearPair[511];		// the sum of two -> their average, the same
	unsigned long long m_nColourTicks;	// time spent in ToColour, and the most
	unsigned m_nMaxColourTicks;
	u8 *m_pRaw;			// RequestRaw's copy, or 0
	boolean m_bRawWanted, m_bRawReady;
	unsigned m_nRawWait;		// frames until the copy
	unsigned m_nRawWidth, m_nRawHeight, m_nRawStride;
	unsigned m_nSerial;
	u8 m_Curve[4 * 255 + 1];	// sum of a 2x2 tile -> grey, black level removed

	// automatic exposure
	unsigned m_nExposure;		// lines
	unsigned m_nAnalogue;		// gain code
	unsigned m_nDigital;		// 4.8 fixed point
	double m_fProduct;		// exposure x analogue x digital gain, in lines
	unsigned m_nSkip;		// frames to wait for a change to show
	unsigned m_nLastMean;

	// logging
	unsigned long long m_nStartTicks;
	boolean m_bRateLogged;
	unsigned long long m_nNextExposureLog;
	boolean m_bExposureChanged;
	unsigned long long m_nNextErrorLog;
	u32 m_nErrorsSeen;
	unsigned m_nFramesShown;
	unsigned long long m_nGreyTicks;	// time spent in ToGrey, and the most
	unsigned m_nMaxGreyTicks;
};

#endif
