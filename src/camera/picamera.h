//
// picamera.h
//
// The Raspberry Pi Camera Module v2.1 (Sony IMX219) on the Pi Zero v1.3's
// camera connector, as a CZgCamera (src/runtime/camera.h): power (GPIO 41),
// the sensor over I2C 0 on GPIO 28/29 (imx219.h), the CSI-2 receiver
// Unicam1 (unicam.h), and what the scanner needs from them: 8-bit grey
// frames, the average of each 2x2 Bayer tile of the sensor's RAW8 (320x240
// from 640x480 by default), with an automatic exposure the sensor itself
// lacks.
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

	// The sensor's mode (imx219.h), from the next Start(); the grey
	// frame is half its size in each direction.
	void SetMode (const TZgIMX219Mode *pMode)	{ m_pMode = pMode; }

	boolean Start (void);
	void Stop (void);
	const u8 *GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight);
	const char *GetError (void);

private:
	boolean PowerUp (void);
	void PowerDown (void);
	boolean StartStreaming (void);
	void Fail (const char *pError);

	void ToGrey (const u8 *pRaw);
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
	const TZgIMX219Mode *m_pMode;

	unsigned m_nStride;		// of the raw frames
	unsigned m_nWidth;		// of the grey frames: half the sensor's
	unsigned m_nHeight;
	u8 *m_pGrey;			// m_nWidth x m_nHeight
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
