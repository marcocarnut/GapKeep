//
// qrdecode.cpp
//
// zxing-cpp's QR code reader behind ZgDecodeQR. zxing-cpp is C++20 and uses
// the C++ standard library, so this file is compiled as zxing-cpp is
// (lib/zxing/Makefile, sim/Makefile, tools/fuzz_qr.sh): C++20, without
// exceptions or RTTI.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "qrdecode.h"
#include "zg_bridge.h"
#include <string.h>

#ifdef ZG_HAVE_ZXING

#include <ReadBarcode.h>

static const unsigned MaxCodes = 4;
// larger images are not decoded (zxing-cpp's limit is 65535; the cameras
// give at most 1640x1232)
static const unsigned MaxSide = 4096;

static u8 s_Payload[MaxCodes][ZG_QR_MAX_PAYLOAD];

// The reader's settings, chosen by measurement (docs/CAMERA.md, "The QR
// decoder") for the Pi camera's 320x240 frames on a 1 GHz ARM1176 without
// NEON, where most frames have no code in them:
static ZXing::ReaderOptions Options (unsigned nMax)
{
	ZXing::ReaderOptions Options;
	// QR codes as printed and shown (model 2): not the old model 1, micro
	// or rectangular ones, which would each cost a search of their own
	Options.setFormats (ZXing::BarcodeFormat::QRCodeModel2);
	// as many codes read without "try harder" at 320x240, 10% faster
	Options.setTryHarder (false);
	Options.setTryRotate (false);		// for linear barcodes only
	// light on dark too (screens in dark mode): a second look at frames
	// without a code, 20% more time on those
	Options.setTryInvert (true);
	// frames wider or higher than 500 px are searched again at a third of
	// their size (more codes read at 640x480); 320x240 never is
	Options.setTryDownscale (true);
	Options.setDownscaleThreshold (500);
	Options.setBinarizer (ZXing::Binarizer::LocalAverage);
	Options.setMaxNumberOfSymbols ((uint8_t) nMax);
	Options.setReturnErrors (false);
	return Options;
}

int ZgDecodeQR (const u8 *pGrey, unsigned nWidth, unsigned nHeight,
		TZgQRCode *pCodes, unsigned nMax)
{
	if (nMax > MaxCodes)
	{
		nMax = MaxCodes;
	}
	if (   pGrey == 0 || nMax == 0
	    || nWidth == 0 || nHeight == 0 || nWidth > MaxSide || nHeight > MaxSide)
	{
		return 0;
	}

	ZXing::ImageView Image (pGrey, (int) (nWidth * nHeight), (int) nWidth, (int) nHeight,
				ZXing::ImageFormat::Lum);
	ZXing::Barcodes Results = ZXing::ReadBarcodes (Image, Options (nMax));

	unsigned nFound = 0;
	for (const ZXing::Barcode &rResult : Results)
	{
		if (nFound == nMax)
		{
			break;
		}

		// the payload's bytes, as they are in the code: not text(), which
		// converts from the code's character set, and not bytesECI(),
		// which adds the ECI designators
		const std::vector<uint8_t> &rBytes = rResult.bytes ();
		if (   !rResult.isValid ()
		    || rResult.format () != ZXing::BarcodeFormat::QRCode
		    || rBytes.size () > ZG_QR_MAX_PAYLOAD)
		{
			continue;
		}

		memcpy (s_Payload[nFound], rBytes.data (), rBytes.size ());
		pCodes[nFound].pData = s_Payload[nFound];
		pCodes[nFound].nLength = (unsigned) rBytes.size ();
		const ZXing::Position &rCorners = rResult.position ();	// in the image's pixels
		for (int k = 0; k < 4; k++)
		{
			pCodes[nFound].Corners[k][0] = rCorners[k].x;
			pCodes[nFound].Corners[k][1] = rCorners[k].y;
		}
		nFound++;
	}

	return (int) nFound;
}

// zxing-cpp is built without exceptions: what it would throw (an internal
// error, never a code's content: patches/zxing-cpp/) calls this instead. It
// stops the system, like a failed assertion; the fuzzer looks for these.
void ZXing::Fatal (const char *pWhat)
{
	static char Message[200] = "QR decoder (zxing-cpp): ";
	strncat (Message, pWhat, sizeof Message - strlen (Message) - 1);
	zg_fatal (Message);
}

#else

int ZgDecodeQR (const u8 *pGrey, unsigned nWidth, unsigned nHeight,
		TZgQRCode *pCodes, unsigned nMax)
{
	(void) pGrey; (void) nWidth; (void) nHeight; (void) pCodes; (void) nMax;
	return -1;
}

#endif
