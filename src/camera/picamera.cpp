//
// picamera.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "picamera.h"
#include "../crypto/wipe.h"
#include <circle/bcm2835.h>
#include <circle/logger.h>
#include <circle/memio.h>
#include <circle/synchronize.h>
#include <circle/timer.h>
#include <circle/util.h>
#include <math.h>
#include <assert.h>

static const char FromCamera[] = "picamera";

static const unsigned PowerPin = 41;		// CAM_GPIO0, high: powered (SPEC 2.1)
static const unsigned LEDPin = 32;		// CAM_GPIO1
static const unsigned PowerUpMs = 20;		// sensor ready after >= 6 ms; regulators too
static const unsigned FrameMs = 34;		// one frame at 30 frame/s
static const unsigned BlackLevel = 16;		// RAW8 (SPEC 4.1)

// no frame end for this long: the camera has stopped sending
static const unsigned long long StallTicks = CLOCKHZ;
static const unsigned long long RateAfterTicks = 3 * CLOCKHZ;
static const unsigned long long LogEveryTicks = 2 * CLOCKHZ;

// Automatic exposure (SPEC 7). Line time 3448 / 182.4 MHz.
static const double LineUs = 18.90;
static const unsigned StartExposure = 800;	// lines, about 15 ms
static const double BlurCap = 700;		// lines, about 13 ms: hand-held codes
static const double MaxAnalogue = 8.0;		// code 224
static const double MaxDigital = 4.0;		// beyond, mostly noise
static const unsigned TargetMean = 110;		// of 255: QR codes want contrast,
						// so a little under rather than clipped

CGkPiCamera::CGkPiCamera (void)
:	m_pI2C (0),
	m_pSensor (0),
	m_bPowered (FALSE),
	m_bStreaming (FALSE),
	m_pError (0),
	m_nTestPattern (0),
	m_Field (GkFieldCenter),
	m_pForcedMode (0),
	m_pMode (&CGkIMX219::ModeDetail),
	m_nStride (0),
	m_nWidth (0),
	m_nHeight (0),
	m_pGrey (0),
	m_bColour (FALSE),
	m_pRGB (0),
	m_nRGBSize (0),
	m_nColourTicks (0),
	m_nMaxColourTicks (0),
	m_pRaw (0),
	m_bRawWanted (FALSE),
	m_bRawReady (FALSE),
	m_nRawWait (0),
	m_nRawWidth (0),
	m_nRawHeight (0),
	m_nRawStride (0),
	m_nSerial (0),
	m_nExposure (StartExposure),
	m_nAnalogue (0),
	m_nDigital (CGkIMX219::MinDigitalGain),
	m_fProduct (StartExposure),
	m_nSkip (0),
	m_nLastMean (0),
	m_nStartTicks (0),
	m_bRateLogged (FALSE),
	m_nNextExposureLog (0),
	m_bExposureChanged (FALSE),
	m_nNextErrorLog (0),
	m_nErrorsSeen (0),
	m_nFramesShown (0),
	m_nGreyTicks (0),
	m_nMaxGreyTicks (0)
{
	// the pins are only claimed here; PowerUp() drives them
	m_Power.AssignPin (PowerPin);
	m_LED.AssignPin (LEDPin);

	// sum of four RAW8 values -> grey: black (16) becomes 0, white 255
	for (unsigned nSum = 0; nSum < sizeof m_Curve; nSum++)
	{
		int nValue = (int) nSum - 4 * (int) BlackLevel;
		if (nValue < 0)
		{
			nValue = 0;
		}
		nValue = nValue * 255 / (4 * (255 - BlackLevel));
		m_Curve[nSum] = nValue > 255 ? 255 : (u8) nValue;
	}
	for (unsigned v = 0; v < sizeof m_Linear; v++)
	{
		m_Linear[v] = (u8) (v > BlackLevel ? v - BlackLevel : 0);
	}
	for (unsigned v = 0; v < sizeof m_LinearPair; v++)
	{
		m_LinearPair[v] = (u8) (v > 2 * BlackLevel ? (v - 2 * BlackLevel) / 2 : 0);
	}
}

CGkPiCamera::~CGkPiCamera (void)
{
	Stop ();
	if (m_pGrey != 0) gk_wipe (m_pGrey, m_nWidth * m_nHeight);
	if (m_pRaw != 0) gk_wipe (m_pRaw, m_nRawStride * m_nRawHeight);
	if (m_pRGB != 0) gk_wipe (m_pRGB, m_nRGBSize);
	delete [] m_pGrey;
	delete [] m_pRaw;
	delete [] m_pRGB;
}

boolean CGkPiCamera::PowerUp (void)
{
	assert (!m_bPowered);

	// GPIO 0/1 can be routed to the same controller (BSC0) as 28/29; only
	// one pair may be (SPEC 8.10)
	CGPIOPin ID_SD (0, GPIOModeInput);
	CGPIOPin ID_SC (1, GPIOModeInput);

	m_Power.SetMode (GPIOModeOutput);	// low first
	m_LED.SetMode (GPIOModeOutput);
	m_LED.SetPullMode (GPIOPullModeDown);
	m_Power.Write (HIGH);			// regulators, oscillator, reset released
	m_LED.Write (HIGH);
	m_bPowered = TRUE;

	CTimer::SimpleMsDelay (PowerUpMs);

	// 400 kHz: the module's 2.2 kOhm pull-ups allow it (SPEC 2.3)
	m_pI2C = new CI2CMaster (0, TRUE, 1);
	if (!m_pI2C->Initialize ())
	{
		PowerDown ();
		return FALSE;
	}

	// Without a BSC0 (an emulator), Circle's transfers would wait forever
	// for "done": the divider must read back as set.
	PeripheralEntry ();
	u32 nDivider = read32 (ARM_BSC0_BASE + ARM_BSC_DIV__OFFSET);
	PeripheralExit ();
	if (nDivider == 0)
	{
		CLogger::Get ()->Write (FromCamera, LogNotice, "no I2C controller");
		PowerDown ();
		return FALSE;
	}

	m_pSensor = new CGkIMX219 (m_pI2C);
	return TRUE;
}

void CGkPiCamera::PowerDown (void)
{
	delete m_pSensor;
	m_pSensor = 0;
	delete m_pI2C;			// GPIO 28/29 back to inputs
	m_pI2C = 0;

	if (m_bPowered)
	{
		m_Power.Write (LOW);
		m_LED.Write (LOW);
		m_bPowered = FALSE;
	}
}

boolean CGkPiCamera::Probe (void)
{
	if (m_bStreaming)
	{
		return TRUE;
	}

	CLogger *pLogger = CLogger::Get ();
	boolean bFound = FALSE;
	if (PowerUp ())
	{
		u16 nID;
		bFound = m_pSensor->Probe (&nID);
		if (bFound)
		{
			pLogger->Write (FromCamera, LogNotice, "IMX219 found (model %04x)", nID);
		}
		else if (nID != 0)
		{
			pLogger->Write (FromCamera, LogNotice, "no IMX219: model %04x at 0x10", nID);
		}
		else
		{
			pLogger->Write (FromCamera, LogNotice, "no camera (I2C: %d)",
					m_pSensor->GetLastResult ());
		}
		PowerDown ();
	}
	return bFound;
}

void CGkPiCamera::Fail (const char *pError)
{
	CLogger::Get ()->Write (FromCamera, LogError, "%s", pError);
	if (m_pError == 0)
	{
		m_pError = pError;
	}
}

boolean CGkPiCamera::Start (void)
{
	if (m_bStreaming)
	{
		return TRUE;
	}

	m_pError = 0;
	if (!StartStreaming ())
	{
		if (m_pError == 0)
		{
			m_pError = "the camera did not start";
		}
		m_Unicam.Stop ();
		m_Unicam.PowerOff ();
		PowerDown ();
		return FALSE;
	}
	return TRUE;
}

// Power, sensor, receiver, in the order of SPEC 4.2, 4.3 and 5.3.
boolean CGkPiCamera::StartStreaming (void)
{
	CLogger *pLogger = CLogger::Get ();

	if (!PowerUp ())
	{
		m_pError = "no camera";
		return FALSE;
	}

	u16 nID;
	if (!m_pSensor->Probe (&nID))
	{
		pLogger->Write (FromCamera, LogNotice, "no IMX219 (model %04x, I2C %d)",
				nID, m_pSensor->GetLastResult ());
		m_pError = "no camera";
		return FALSE;
	}

	if (!m_pSensor->SettleLanes ())
	{
		Fail ("the camera does not answer");
		return FALSE;
	}

	if (!m_Unicam.PowerOn ())
	{
		Fail ("the camera receiver does not start");
		return FALSE;
	}

	// The two fields' modes were chosen by measurement (IMPLEMENTATION.md,
	// decision 15): "detail" reads small codes best, "full" shows it all.
	m_pMode = m_pForcedMode != 0 ? m_pForcedMode
		: m_Field == GkFieldFull ? &CGkIMX219::ModeFull : &CGkIMX219::ModeDetail;

	if (!m_pSensor->Configure (*m_pMode, m_nExposure, m_nAnalogue,
				   m_nTestPattern != 0 ? CGkIMX219::MinDigitalGain : m_nDigital,
				   m_nTestPattern))
	{
		Fail ("the camera does not answer");
		return FALSE;
	}

	// lines start on 32 bytes (SPEC 5.5); the grey frame is half size
	m_nStride = (m_pMode->nWidth + 31) & ~31;
	if (m_pGrey == 0 || m_nWidth != m_pMode->nWidth / 2u || m_nHeight != m_pMode->nHeight / 2u)
	{
		if (m_pGrey != 0)
		{
			gk_wipe (m_pGrey, m_nWidth * m_nHeight);
		}
		delete [] m_pGrey;
		m_nWidth = m_pMode->nWidth / 2;
		m_nHeight = m_pMode->nHeight / 2;
		m_pGrey = new u8[m_nWidth * m_nHeight];
	}

	if (m_bColour && (m_pRGB == 0 || m_nRGBSize != m_nWidth * m_nHeight * 3))
	{
		if (m_pRGB != 0)
		{
			gk_wipe (m_pRGB, m_nRGBSize);
		}
		delete [] m_pRGB;
		m_nRGBSize = m_nWidth * m_nHeight * 3;
		m_pRGB = new u8[m_nRGBSize];
	}
	m_nColourTicks = 0;
	m_nMaxColourTicks = 0;

	if (!m_Unicam.Start (m_pMode->nWidth, m_pMode->nHeight, m_nStride))
	{
		Fail ("not enough memory for the camera");
		return FALSE;
	}

	if (!m_pSensor->StartStreaming ())
	{
		Fail ("the camera does not answer");
		return FALSE;
	}

	m_bStreaming = TRUE;
	m_nStartTicks = CTimer::GetClockTicks64 ();
	m_bRateLogged = FALSE;
	m_nNextExposureLog = 0;
	m_bExposureChanged = FALSE;
	m_nNextErrorLog = 0;
	m_nErrorsSeen = 0;
	m_nFramesShown = 0;
	m_nGreyTicks = 0;
	m_nMaxGreyTicks = 0;
	m_nSkip = 2;

	pLogger->Write (FromCamera, LogNotice,
			"streaming %ux%u RAW8 (%s) on 2 lanes, %u lines per frame, exposure %u lines,"
			" %u buffers of %u KiB, grey %ux%u%s",
			m_pMode->nWidth, m_pMode->nHeight, m_pMode->pName, CGkIMX219::FrameLength,
			m_nExposure, CGkUnicam::Buffers, m_nStride * m_pMode->nHeight / 1024,
			m_nWidth, m_nHeight, m_nTestPattern != 0 ? ", test pattern" : "");
	return TRUE;
}

void CGkPiCamera::Stop (void)
{
	if (!m_bStreaming)
	{
		return;
	}

	// the sensor first, then the receiver (SPEC 5.6); the frame in
	// progress is finished before standby, so wait one more frame before
	// the power goes
	m_pSensor->StopStreaming ();
	m_Unicam.Stop ();
	CTimer::SimpleMsDelay (FrameMs);
	m_Unicam.PowerOff ();
	PowerDown ();
	m_bStreaming = FALSE;

	// as the receiver's buffers: nothing of the picture stays
	gk_wipe (m_pGrey, m_nWidth * m_nHeight);
	if (m_pRGB != 0)
	{
		gk_wipe (m_pRGB, m_nRGBSize);
	}
	// (a raw frame, which only test builds take, stays until the next is
	// taken: the serial port may not have sent it yet)

	CLogger::Get ()->Write (FromCamera, LogNotice,
		"stopped: %u frames started, %u complete, %u shown, %u replaced unread, %u incomplete;"
		" grey in %u us each on average, %u us at most",
		m_Unicam.GetFramesStarted (), m_Unicam.GetFramesCompleted (), m_nFramesShown,
		m_Unicam.GetFramesNotTaken (), m_Unicam.GetFramesIncomplete (),
		m_nFramesShown > 0 ? (unsigned) (m_nGreyTicks * 1000000 / CLOCKHZ / m_nFramesShown) : 0,
		(unsigned) (m_nMaxGreyTicks * 1000000ULL / CLOCKHZ));
	if (m_bColour && m_nFramesShown > 0)
	{
		CLogger::Get ()->Write (FromCamera, LogNotice, "colour in %u us each on average, %u us at most",
			(unsigned) (m_nColourTicks * 1000000 / CLOCKHZ / m_nFramesShown),
			(unsigned) (m_nMaxColourTicks * 1000000ULL / CLOCKHZ));
	}
}

const char *CGkPiCamera::GetError (void)
{
	return m_pError;
}

void CGkPiCamera::SetTestPattern (unsigned nPattern)
{
	m_nTestPattern = nPattern;
	if (m_bStreaming)
	{
		// the pattern comes before digital gain (SPEC 4.7): 1.0x, so it
		// shows its own values
		m_pSensor->SetExposure (m_nExposure, m_nAnalogue,
					nPattern != 0 ? CGkIMX219::MinDigitalGain : m_nDigital);
		m_pSensor->SetTestPattern (nPattern);
		m_nSkip = 2;
	}
	CLogger::Get ()->Write (FromCamera, LogNotice, "test pattern %u", nPattern);
}

const u8 *CGkPiCamera::GetGrey (unsigned *pWidth, unsigned *pHeight) const
{
	if (!m_bStreaming || m_pError != 0)
	{
		return 0;
	}
	*pWidth = m_nWidth;
	*pHeight = m_nHeight;
	return m_pGrey;
}

const u8 *CGkPiCamera::GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight)
{
	if (!m_bStreaming || m_pError != 0)
	{
		return 0;
	}

	const u8 *pRaw = m_Unicam.TakeFrame ();
	if (pRaw != 0)
	{
		unsigned long long nStart = CTimer::GetClockTicks64 ();
		ToGrey (pRaw);
		unsigned nTicks = (unsigned) (CTimer::GetClockTicks64 () - nStart);
		// two frames after the request: any change it follows shows by then
		if (m_bRawWanted && m_nRawWait-- == 0)
		{
			if (m_pRaw != 0)
			{
				gk_wipe (m_pRaw, m_nRawStride * m_nRawHeight);
			}
			delete [] m_pRaw;
			m_nRawWidth = m_pMode->nWidth;
			m_nRawHeight = m_pMode->nHeight;
			m_nRawStride = m_nStride;
			m_pRaw = new u8[m_nRawStride * m_nRawHeight];
			memcpy (m_pRaw, pRaw, m_nRawStride * m_nRawHeight);
			m_bRawWanted = FALSE;
			m_bRawReady = TRUE;
		}
		m_nGreyTicks += nTicks;
		if (nTicks > m_nMaxGreyTicks)
		{
			m_nMaxGreyTicks = nTicks;
		}
		if (m_bColour && m_pRGB != 0)
		{
			nStart = CTimer::GetClockTicks64 ();
			ToColour (pRaw);
			nTicks = (unsigned) (CTimer::GetClockTicks64 () - nStart);
			m_nColourTicks += nTicks;
			if (nTicks > m_nMaxColourTicks)
			{
				m_nMaxColourTicks = nTicks;
			}
		}
		m_Unicam.ReleaseFrame ();
		m_nSerial++;
		m_nFramesShown++;
		AutoExposure ();
	}

	Watch ();
	if (m_pError != 0 || m_nSerial == *pSerial)
	{
		return 0;
	}

	*pSerial = m_nSerial;
	*pWidth = m_nWidth;
	*pHeight = m_nHeight;
	return m_pGrey;
}

// Each 2x2 Bayer tile (one red, two green, one blue) -> its average, which
// does not depend on the tile's order, so neither do the flips. Four pixels
// of each line are loaded at once: two tiles.
void CGkPiCamera::ToGrey (const u8 *pRaw)
{
	u8 *pOut = m_pGrey;
	for (unsigned y = 0; y < m_nHeight; y++)
	{
		const u32 *pTop = (const u32 *) (pRaw + 2 * y * m_nStride);
		const u32 *pBottom = (const u32 *) (pRaw + (2 * y + 1) * m_nStride);
		for (unsigned x = 0; x < m_nWidth / 2; x++)
		{
			u32 nTop = pTop[x], nBottom = pBottom[x];
			// pairs added in 16-bit lanes: pixels 0+1 low, 2+3 high
			u32 nSums =   (nTop & 0x00FF00FF) + ((nTop >> 8) & 0x00FF00FF)
				    + (nBottom & 0x00FF00FF) + ((nBottom >> 8) & 0x00FF00FF);
			*pOut++ = m_Curve[nSums & 0xFFFF];
			*pOut++ = m_Curve[nSums >> 16];
		}
	}
}

// Each 2x2 Bayer tile -> one RGB pixel, linear, without white balance. The
// order is BGGR in the buffer (blue at the tile's top left, red at its
// bottom right), with both flips on (imx219.cpp): checked against a red
// object, not the sensor's colour bars, which come out RGGB because the
// sensor makes them after the flips (docs/camera/IMPLEMENTATION.md).
// Four pixels of each line are loaded at once (two tiles), as in ToGrey:
// the frame buffer is slow to read byte by byte.
void CGkPiCamera::ToColour (const u8 *pRaw)
{
	u8 *pOut = m_pRGB;
	for (unsigned y = 0; y < m_nHeight; y++)
	{
		const u32 *pTop = (const u32 *) (pRaw + 2 * y * m_nStride);		// B G B G
		const u32 *pBottom = (const u32 *) (pRaw + (2 * y + 1) * m_nStride);	// G R G R
		for (unsigned x = 0; x < m_nWidth / 2; x++)
		{
			u32 t = pTop[x], b = pBottom[x];	// little-endian: the first pixel low
			pOut[0] = m_Linear[(b >> 8) & 0xFF];
			pOut[1] = m_LinearPair[((t >> 8) & 0xFF) + (b & 0xFF)];
			pOut[2] = m_Linear[t & 0xFF];
			pOut[3] = m_Linear[b >> 24];
			pOut[4] = m_LinearPair[(t >> 24) + ((b >> 16) & 0xFF)];
			pOut[5] = m_Linear[(t >> 16) & 0xFF];
			pOut += 6;
		}
	}
}

// SPEC 7: measure the middle of the picture, correct the product of
// exposure and gains half-way (in log terms) towards the target, then let
// two frames pass, as new values take that long to show.
void CGkPiCamera::AutoExposure (void)
{
	if (m_nTestPattern != 0)
	{
		return;
	}
	if (m_nSkip > 0)
	{
		m_nSkip--;
		return;
	}

	// the middle half in each direction, sub-sampled
	unsigned nSum = 0, nCount = 0, nClipped = 0;
	unsigned nStep = m_nWidth > 400 ? 4 : 2;	// about 5000 samples
	for (unsigned y = m_nHeight / 4; y < m_nHeight * 3 / 4; y += nStep)
	{
		const u8 *pRow = m_pGrey + y * m_nWidth;
		for (unsigned x = m_nWidth / 4; x < m_nWidth * 3 / 4; x += nStep)
		{
			nSum += pRow[x];
			nClipped += pRow[x] >= 250;
			nCount++;
		}
	}
	unsigned nMean = nSum / nCount;
	m_nLastMean = nMean;

	double fRatio;
	if (nMean < 2)
	{
		fRatio = 2.0;			// almost nothing to measure
	}
	else
	{
		// Over 2 % clipped: a lower target. Not "darker whatever the
		// mean": a lamp in view would then leave the rest black.
		unsigned nTarget = nClipped * 50 > nCount ? TargetMean / 2 : TargetMean;
		fRatio = (double) nTarget / nMean;
	}

	// Colour frames (the "qr-color" detector): green, the strongest channel
	// without white balance, must not clip on a bright screen, or light
	// colours lose their colour (dim ones only get noisier). Over 1 % of
	// green near its top: darker; over 1 % in its top fifth: no brighter.
	if (m_bColour && m_pRGB != 0)
	{
		unsigned nHigh = 0, nTop = 0;
		for (unsigned y = m_nHeight / 8; y < m_nHeight * 7 / 8; y += nStep)
		{
			const u8 *pRow = m_pRGB + y * m_nWidth * 3;
			for (unsigned x = m_nWidth / 8; x < m_nWidth * 7 / 8; x += nStep)
			{
				unsigned g = pRow[3 * x + 1];
				nTop += g >= 230;
				nHigh += g >= 190;
			}
		}
		unsigned nGreenCount = ((m_nHeight * 3 / 4 + nStep - 1) / nStep) * ((m_nWidth * 3 / 4 + nStep - 1) / nStep);
		if (nTop * 100 > nGreenCount)
		{
			fRatio = fRatio < 0.7 ? fRatio : 0.7;
		}
		else if (nHigh * 100 > nGreenCount && fRatio > 1.0)
		{
			fRatio = 1.0;
		}
	}
	if (fRatio > 2.0)	fRatio = 2.0;
	if (fRatio < 0.5)	fRatio = 0.5;
	fRatio = sqrt (fRatio);			// half-way, in log terms

	if (fRatio > 0.95 && fRatio < 1.05)
	{
		return;				// close enough: no hunting
	}

	SetProduct (m_fProduct * fRatio);
	m_nSkip = 2;
}

// Exposure first, up to the motion-blur cap; then analogue gain to 8x; then
// exposure up to the frame; digital gain last (SPEC 7, step 4). Going
// darker undoes them in the reverse order, since the same split applies.
void CGkPiCamera::SetProduct (double fProduct)
{
	const double fMaxExposure = CGkIMX219::MaxExposure;
	double fMin = CGkIMX219::MinExposure;
	double fMax = fMaxExposure * MaxAnalogue * MaxDigital;
	if (fProduct < fMin)	fProduct = fMin;
	if (fProduct > fMax)	fProduct = fMax;

	double fExposure, fAnalogue = 1.0, fDigital = 1.0;
	if (fProduct <= BlurCap)
	{
		fExposure = fProduct;
	}
	else if (fProduct <= BlurCap * MaxAnalogue)
	{
		fExposure = BlurCap;
		fAnalogue = fProduct / BlurCap;
	}
	else if (fProduct <= fMaxExposure * MaxAnalogue)
	{
		fAnalogue = MaxAnalogue;
		fExposure = fProduct / MaxAnalogue;
	}
	else
	{
		fExposure = fMaxExposure;
		fAnalogue = MaxAnalogue;
		fDigital = fProduct / (fMaxExposure * MaxAnalogue);
	}

	// analogue gain = 256 / (256 - code); digital gain in 4.8 fixed point
	unsigned nExposure = (unsigned) (fExposure + 0.5);
	unsigned nAnalogue = (unsigned) (256.0 - 256.0 / fAnalogue + 0.5);
	if (nAnalogue > CGkIMX219::MaxAnalogueCode)
	{
		nAnalogue = CGkIMX219::MaxAnalogueCode;
	}
	unsigned nDigital = (unsigned) (fDigital * 256.0 + 0.5);

	if (   nExposure == m_nExposure && nAnalogue == m_nAnalogue && nDigital == m_nDigital)
	{
		m_fProduct = fProduct;
		return;
	}

	if (!m_pSensor->SetExposure (nExposure, nAnalogue, nDigital))
	{
		Fail ("the camera does not answer");
		return;
	}
	m_nExposure = nExposure;
	m_nAnalogue = nAnalogue;
	m_nDigital = nDigital;
	// what was actually set, so the next step starts from the truth
	m_fProduct = nExposure * (256.0 / (256 - nAnalogue)) * (nDigital / 256.0);
	m_bExposureChanged = TRUE;
}

// From GetFrame: logs what is worth knowing, rate-limited, and notices a
// camera that has stopped sending.
void CGkPiCamera::Watch (void)
{
	CLogger *pLogger = CLogger::Get ();
	unsigned long long nNow = CTimer::GetClockTicks64 ();

	if (nNow - m_Unicam.GetLastFrameEndTicks () > StallTicks)
	{
		m_Unicam.DumpRegisters ("stalled");
		pLogger->Write (FromCamera, LogError, "%u frames started, %u complete",
				m_Unicam.GetFramesStarted (), m_Unicam.GetFramesCompleted ());
		Fail ("no frames from the camera");
		return;
	}

	if (!m_bRateLogged && nNow - m_nStartTicks > RateAfterTicks)
	{
		unsigned nStarts;
		unsigned long long nTicks;
		m_Unicam.GetFrameStartTiming (&nStarts, &nTicks);
		unsigned nRate10 = 0;		// tenths of a frame per second
		if (nStarts > 1 && nTicks > 0)
		{
			nRate10 = (unsigned) ((nStarts - 1) * 10ULL * CLOCKHZ / nTicks);
		}
		pLogger->Write (FromCamera, LogNotice,
			"%u frames in %u ms: %u.%u frame/s, %u lines in the last",
			nStarts, (unsigned) (nTicks / (CLOCKHZ / 1000)), nRate10 / 10, nRate10 % 10,
			m_Unicam.GetLinesInLastFrame ());
		m_bRateLogged = TRUE;
	}

	if (m_bExposureChanged && nNow >= m_nNextExposureLog)
	{
		unsigned nGain100 = 256 * 100 / (256 - m_nAnalogue);
		unsigned nDigital100 = m_nDigital * 100 / 256;
		unsigned nUs = (unsigned) (m_nExposure * LineUs);
		pLogger->Write (FromCamera, LogNotice,
			"exposure %u lines (%u.%u ms), gain %u.%02u, digital %u.%02u, mean %u",
			m_nExposure, nUs / 1000, nUs / 100 % 10, nGain100 / 100, nGain100 % 100,
			nDigital100 / 100, nDigital100 % 100, m_nLastMean);
		m_bExposureChanged = FALSE;
		m_nNextExposureLog = nNow + LogEveryTicks;
	}

	m_nErrorsSeen |= m_Unicam.GetErrors ();
	if (m_nErrorsSeen != 0 && nNow >= m_nNextErrorLog)
	{
		char Buffer[160];
		CGkUnicam::DescribeErrors (m_nErrorsSeen, Buffer, sizeof Buffer);
		pLogger->Write (FromCamera, LogWarning, "receiver errors: %s", Buffer);
		m_nErrorsSeen = 0;
		m_nNextErrorLog = nNow + LogEveryTicks;
	}
}

void CGkPiCamera::RequestRaw (void)
{
	m_bRawReady = FALSE;
	m_nRawWait = 2;
	m_bRawWanted = TRUE;
}

const u8 *CGkPiCamera::GetRaw (unsigned *pWidth, unsigned *pHeight, unsigned *pStride,
			       unsigned *pExposure, unsigned *pAnalogue, unsigned *pDigital) const
{
	if (!m_bRawReady)
	{
		return 0;
	}
	*pWidth = m_nRawWidth;
	*pHeight = m_nRawHeight;
	*pStride = m_nRawStride;
	*pExposure = m_nExposure;
	*pAnalogue = m_nAnalogue;
	*pDigital = m_nDigital;
	return m_pRaw;
}
