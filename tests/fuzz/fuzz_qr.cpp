//
// fuzz_qr.cpp - fuzzes the QR decoder (src/runtime/qrdecode.cpp, zxing-cpp)
// with AddressSanitizer and UBSan: the camera's pictures are untrusted
// input. Built and run by tools/fuzz_qr.sh.
//
// Each round builds a greyscale image of random size and feeds it to
// GkDecodeQR, which must neither crash nor return a payload longer than
// GK_QR_MAX_PAYLOAD, nor stop: zxing-cpp is built without exceptions, and
// what it would throw is a fatal error (ZXing::Fatal), so a crafted code
// reaching one would stop the kernel. Here it aborts with a report, as do
// assertions and the C++ library's own checks. The images are:
//
//  - noise (random bytes),
//  - a real QR code (random payload, from the synthetic camera) damaged in
//    random ways: pixels, rectangles, rows, columns flipped or blanked,
//    and cropped,
//  - many finder-pattern-like squares (the finder pattern search, where
//    decoders tend to go wrong),
//  - crafted codes: QR symbols whose data is a random bit stream, or random
//    segments (modes, counts, ECI designators, FNC1, structured append,
//    valid or not), with correct error correction, so that they get
//    through to the payload decoder, as a code printed by an attacker
//    would; drawn at random sizes and angles, sometimes mirrored, inverted
//    or damaged,
//  - all of these with random dimensions, including tiny and lopsided ones.
//
// Some rounds skip the image and call zxing-cpp's QR decoder on a module
// matrix (QRCode::Decode: format, version, codewords, error correction),
// or its payload decoder on bytes (QRCode::DecodeBitStream), for every
// symbol type and version, as fast checks of the same code.
//
// With clang, -DGK_LIBFUZZER builds a libFuzzer target instead: the input
// bytes are the image (two bytes of width, two of height, then pixels).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "qrdecode.h"
#include "synthcam.h"
#include <circle/timer.h>
#include <lvgl/lvgl/src/libs/qrcode/qrcodegen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

#include <ReadBarcode.h>
#include <BitMatrix.h>
#include <ByteArray.h>
#include <DecoderResult.h>
#include <qrcode/QRDecoder.h>
#include <qrcode/QRErrorCorrectionLevel.h>
#include <qrcode/QRVersion.h>

// --- what the runtime would provide -------------------------------------------

u64 CTimer::GetClockTicks64 (void) { return 0; }
extern "C" void lv_log_add (lv_log_level_t, const char *, int, const char *, const char *, ...) {}
extern "C" void halt (void) { abort (); }

extern "C" void gk_fatal (const char *pMessage)
{
	fprintf (stderr, "fuzz_qr: fatal error: %s\n", pMessage);
	abort ();
}

// qrcodegen's internals (compiled with QRCODEGEN_TEST), for crafted codes
extern "C" int getNumDataCodewords (int version, enum qrcodegen_Ecc ecl);

// zxing-cpp's payload decoder (exported with ZXING_BUILD_FOR_TEST)
namespace ZXing::QRCode {
DecoderResult DecodeBitStream (ByteArray &&bytes, const Version &version, ErrorCorrectionLevel ecLevel);
}

static void Decode (const u8 *pImage, unsigned w, unsigned h, unsigned *pDecoded = 0)
{
	TGkQRCode Codes[4];
	int n = GkDecodeQR (pImage, w, h, Codes, 4);
	if (n < 0)
	{
		fprintf (stderr, "fuzz_qr: built without the decoder\n");
		exit (2);
	}
	for (int i = 0; i < n; i++)
	{
		if (Codes[i].nLength > GK_QR_MAX_PAYLOAD)
		{
			fprintf (stderr, "fuzz_qr: payload of %u bytes\n", Codes[i].nLength);
			abort ();
		}
		volatile u8 x = 0;
		for (unsigned k = 0; k < Codes[i].nLength; k++)	// touch it all (ASan)
		{
			x ^= Codes[i].pData[k];
		}
	}
	if (pDecoded != 0 && n > 0)
	{
		(*pDecoded)++;
	}
}

#ifdef GK_LIBFUZZER

extern "C" int LLVMFuzzerTestOneInput (const uint8_t *p, size_t n)
{
	if (n < 4) return 0;
	unsigned w = 1 + (p[0] | p[1] << 8) % 1024, h = 1 + (p[2] | p[3] << 8) % 1024;
	p += 4; n -= 4;
	u8 *pImage = (u8 *) malloc (w * h);
	for (size_t i = 0; i < (size_t) w * h; i++) pImage[i] = n ? p[i % n] : 0;
	Decode (pImage, w, h);
	free (pImage);
	return 0;
}

#else

static u32 s_nRandom;
static u32 Random (void)
{
	s_nRandom ^= s_nRandom << 13;
	s_nRandom ^= s_nRandom >> 17;
	s_nRandom ^= s_nRandom << 5;
	return s_nRandom;
}
static unsigned Below (unsigned n) { return n ? Random () % n : 0; }

static void FillRect (u8 *p, unsigned w, unsigned h, int x0, int y0, int rw, int rh, u8 v)
{
	for (int y = y0; y < y0 + rh; y++)
		for (int x = x0; x < x0 + rw; x++)
			if (x >= 0 && y >= 0 && x < (int) w && y < (int) h) p[y * w + x] = v;
}

// a 7x7-module finder pattern of module size m at (x, y)
static void Finder (u8 *p, unsigned w, unsigned h, int x, int y, int m)
{
	FillRect (p, w, h, x, y, 7 * m, 7 * m, 0);
	FillRect (p, w, h, x + m, y + m, 5 * m, 5 * m, 255);
	FillRect (p, w, h, x + 2 * m, y + 2 * m, 3 * m, 3 * m, 0);
}

static void Damage (u8 *pImage, unsigned w, unsigned h, unsigned nDamage)
{
	for (unsigned d = 0; d < nDamage; d++)
	{
		switch (Below (5))
		{
		case 0: pImage[Below (w * h)] ^= 0xFF; break;
		case 1: FillRect (pImage, w, h, Below (w), Below (h), 1 + Below (60), 1 + Below (60), (u8) Random ()); break;
		case 2: FillRect (pImage, w, h, 0, Below (h), w, 1 + Below (3), (u8) Random ()); break;
		case 3: FillRect (pImage, w, h, Below (w), 0, 1 + Below (3), h, (u8) Random ()); break;
		case 4: Finder (pImage, w, h, Below (w), Below (h), 1 + Below (8)); break;
		}
	}
}

// --- crafted codes ---------------------------------------------------------------

struct TBits
{
	u8 Data[4096];
	int nLength;		// in bits
	int nMax;

	void Put (unsigned v, int nBits)
	{
		for (int i = nBits - 1; i >= 0 && nLength < nMax; i--, nLength++)
		{
			if (v >> i & 1)	Data[nLength >> 3] |= 0x80 >> (nLength & 7);
		}
	}
};

// A bit stream of nMax bits for the payload decoder, after the ECI mode
// indicator the segment carrying it starts with: random bits, or segments
// that look right, with counts, values and modes that may not be.
static void CraftStream (TBits *pBits, int nMax, int nVersion)
{
	memset (pBits->Data, 0, sizeof pBits->Data);
	pBits->nLength = 0;
	pBits->nMax = nMax;

	if (Below (4) == 0)
	{
		while (pBits->nLength < nMax) pBits->Put (Random () & 0xFF, 8);
		return;
	}

	// the ECI designator that follows the mode indicator: 1, 2 or 3 bytes, or invalid
	switch (Below (4))
	{
	case 0: pBits->Put (Below (128), 8); break;
	case 1: pBits->Put (0x8000 | Below (0x4000), 16); break;
	case 2: pBits->Put (0xC00000 | Below (0x200000), 24); break;
	case 3: pBits->Put (0xE0 | Below (32), 8); break;
	}

	int i = nVersion <= 9 ? 0 : nVersion <= 26 ? 1 : 2;
	static const int Numeric[] = {10, 12, 14}, Alphanumeric[] = {9, 11, 13},
			 Byte[] = {8, 16, 16}, Kanji[] = {8, 10, 12};
	static const unsigned Modes[] = {1, 2, 4, 8, 7, 3, 5, 9, 13, 0};
	while (pBits->nLength < nMax && Below (16) != 0)
	{
		unsigned nMode = Below (8) ? Modes[Below (sizeof Modes / sizeof Modes[0])] : Below (16);
		pBits->Put (nMode, 4);
		int nCountBits = 0, nPerUnit = 8;
		switch (nMode)
		{
		case 1:  nCountBits = Numeric[i]; nPerUnit = 10; break;		// 3 digits
		case 2:  nCountBits = Alphanumeric[i]; nPerUnit = 11; break;	// 2 characters
		case 4:  nCountBits = Byte[i]; nPerUnit = 8; break;
		case 8:  nCountBits = Kanji[i]; nPerUnit = 13; break;
		case 13: pBits->Put (Below (4) ? 1 : Below (16), 4);		// Hanzi subset
			 nCountBits = Kanji[i]; nPerUnit = 13; break;
		case 7:  pBits->Put (Random (), Below (3) ? 8 : 24); continue;		// ECI
		case 3:  pBits->Put (Random (), 16); continue;				// structured append
		case 9:  pBits->Put (Below (2) ? Below (100) : Random (), 8); continue;	// AIM FNC1
		default: continue;
		}
		// a count that fits, or one that runs past the end
		int nLeft = (nMax - pBits->nLength - nCountBits) / nPerUnit;
		unsigned nCount = Below (4) ? Below (nLeft > 0 ? nLeft + 1 : 1) : Random ();
		pBits->Put (nCount & ((1u << nCountBits) - 1), nCountBits);
		int nData = (int) (nCount & ((1u << nCountBits) - 1)) * nPerUnit;
		if (Below (3) == 0)
		{
			nData = Below (nMax);
		}
		for (int k = 0; k < nData && pBits->nLength < nMax; k += 8)
		{
			if (nMode == 1 && Below (2))
				pBits->Put (Below (Below (8) ? 1000 : 1024), 10), k += 2;	// digits, valid or not
			else
				pBits->Put (Random (), 8);
		}
	}
}

// a crafted symbol; returns its size in modules, 0 if qrcodegen could not make it
static int CraftSymbol (u8 *pQR, int *pVersion)
{
	static u8 Temp[qrcodegen_BUFFER_LEN_MAX];
	int nVersion = 1 + (Below (3) ? Below (10) : Below (40));
	enum qrcodegen_Ecc Ecc = (enum qrcodegen_Ecc) Below (4);
	int nCapacity = getNumDataCodewords (nVersion, Ecc) * 8;
	// an ECI segment: mode 0111, no count, then the crafted bits
	static TBits Bits;
	int nStream = nCapacity - 4 - (Below (4) ? 0 : Below (16));
	if (nStream < 8) return 0;
	CraftStream (&Bits, nStream, nVersion);
	struct qrcodegen_Segment Seg;
	Seg.mode = qrcodegen_Mode_ECI;
	Seg.numChars = 0;
	Seg.data = Bits.Data;
	Seg.bitLength = Bits.nLength;
	int nMask = Below (9) - 1;		// -1: automatic
	if (!qrcodegen_encodeSegmentsAdvanced (&Seg, 1, Ecc, nVersion, nVersion, nMask, false, Temp, pQR))
	{
		return 0;
	}
	*pVersion = nVersion;
	return qrcodegen_getSize (pQR);
}

// draws a symbol of n modules into a w x h image: module size, angle,
// position and grey levels at random; mirrored or inverted at times
static void DrawSymbol (u8 *pImage, unsigned w, unsigned h, const u8 *pQR, int n)
{
	u8 Light = 150 + Below (106), Dark = Below (100);
	if (Below (6) == 0) { u8 t = Light; Light = Dark; Dark = t; }		// inverted
	bool bMirror = Below (6) == 0;
	memset (pImage, Light, w * h);
	int nSide = n + 8;
	float fMaxModule = (float) (w < h ? w : h) / nSide;
	float fModule = Below (4) ? fMaxModule * (0.5f + Below (50) / 100.0f) : 1.0f + Below (6);
	if (fModule < 1.0f) fModule = 1.0f;
	float fAngle = Below (3) ? (Below (200) - 100) / 1000.0f : Below (628) / 100.0f;
	float fCos = cosf (fAngle), fSin = sinf (fAngle);
	float fCX = Below (w), fCY = Below (h);
	if (Below (3)) { fCX = w / 2.0f; fCY = h / 2.0f; }
	for (unsigned y = 0; y < h; y++)
	{
		for (unsigned x = 0; x < w; x++)
		{
			unsigned nSum = 0;
			for (int s = 0; s < 4; s++)
			{
				float dx = x + 0.25f + 0.5f * (s & 1) - fCX;
				float dy = y + 0.25f + 0.5f * (s >> 1) - fCY;
				float u = ( fCos * dx + fSin * dy) / fModule + nSide / 2.0f - 4;
				float v = (-fSin * dx + fCos * dy) / fModule + nSide / 2.0f - 4;
				bool bDark = false;
				if (u >= 0 && v >= 0 && u < n && v < n)
				{
					int mx = (int) u, my = (int) v;
					bDark = bMirror ? qrcodegen_getModule (pQR, my, mx) : qrcodegen_getModule (pQR, mx, my);
				}
				nSum += bDark ? Dark : Light;
			}
			pImage[y * w + x] = (u8) (nSum / 4);
		}
	}
	unsigned nNoise = Below (4) ? 0 : Below (40);
	for (unsigned i = 0; nNoise && i < w * h; i++)
	{
		int v = pImage[i] + (int) Below (2 * nNoise + 1) - (int) nNoise;
		pImage[i] = (u8) (v < 0 ? 0 : v > 255 ? 255 : v);
	}
}

// whether a crafted code got through to the payload decoder: found, and
// error correction succeeded (the payload may still be invalid)
static unsigned ReachesPayload (const u8 *pImage, unsigned w, unsigned h)
{
	using namespace ZXing;
	ReaderOptions Options;
	Options.setFormats (BarcodeFormat::QRCodeModel2 | BarcodeFormat::QRCodeModel1);
	Options.setTryDownscale (false);
	Options.setReturnErrors (true);
	for (const Barcode &rResult : ReadBarcodes (ImageView (pImage, (int) w, (int) h, ImageFormat::Lum), Options))
		if (rResult.error ().type () != Error::Type::Checksum)
			return 1;
	return 0;
}

// zxing-cpp's QR decoder on a module matrix: a crafted symbol, with module
// errors, or random modules in the sizes of every symbol type
static unsigned DecodeMatrix (const u8 *pQR, int n)
{
	using namespace ZXing;
	int w, h;
	if (n > 0 && Below (2))
	{
		w = h = n;
	}
	else switch (Below (4))
	{
	case 0: w = h = 21 + 4 * Below (40); break;		// QR code (model 1 or 2)
	case 1: w = h = 11 + 2 * Below (4); break;		// Micro QR code
	case 2: w = 27 + 2 * Below (50); h = 7 + 2 * Below (7); break;	// rMQR, roughly
	default: w = 1 + Below (180); h = 1 + Below (180); break;
	}
	BitMatrix Bits (w, h);
	bool bFromSymbol = n > 0 && w == n && h == n;
	for (int y = 0; y < h; y++)
		for (int x = 0; x < w; x++)
			if (bFromSymbol ? qrcodegen_getModule (pQR, x, y) : (Random () & 1))
				Bits.set (x, y);
	unsigned nFlips = bFromSymbol ? Below (Below (2) ? 4 : 60) : 0;
	for (unsigned i = 0; i < nFlips; i++)
		Bits.flip (Below (w), Below (h));
	DecoderResult Result = QRCode::Decode (Bits);
	volatile int x = (int) Result.content ().bytes.size ();
	(void) x;
	return Result.isValid ();
}

// zxing-cpp's payload decoder on bytes, for any symbol type and version
static unsigned DecodeStream (void)
{
	using namespace ZXing;
	const QRCode::Version *pVersion = 0;
	switch (Below (4))
	{
	case 0: pVersion = QRCode::Version::Model1 (1 + Below (14)); break;
	case 1: pVersion = QRCode::Version::Model2 (1 + Below (40)); break;
	case 2: pVersion = QRCode::Version::Micro (1 + Below (4)); break;
	case 3: pVersion = QRCode::Version::rMQR (1 + Below (32)); break;
	}
	if (pVersion == 0)
	{
		return 0;
	}
	static TBits Bits;
	int nLength = 8 * (Below (4) ? 1 + Below (pVersion->totalCodewords ()) : Below (40));
	CraftStream (&Bits, nLength, pVersion->versionNumber ());
	ByteArray Bytes (nLength / 8);
	if (nLength > 0) memcpy (Bytes.data (), Bits.Data, nLength / 8);
	DecoderResult Result = QRCode::DecodeBitStream (std::move (Bytes), *pVersion,
							 (QRCode::ErrorCorrectionLevel) Below (4));
	volatile int x = (int) Result.content ().bytes.size ();
	(void) x;
	return Result.isValid ();
}

int main (int argc, char **argv)
{
	unsigned nRounds = argc > 1 ? atoi (argv[1]) : 2000;
	s_nRandom = argc > 2 ? atoi (argv[2]) : 1;
	if (s_nRandom == 0) s_nRandom = 1;

	CGkSynthCamera Camera;
	static u8 QR[qrcodegen_BUFFER_LEN_MAX];
	unsigned nDecoded = 0, nCrafted = 0, nCraftedRead = 0, nCraftedDecoded = 0, nDirect = 0, nDirectValid = 0;
	for (unsigned r = 0; r < nRounds; r++)
	{
		if (r > 0 && r % 1000 == 0)
		{
			printf ("fuzz_qr: %u rounds, %u images decoded, %u of %u crafted codes read (%u valid), "
				"%u of %u direct decodes valid\n",
				r, nDecoded, nCraftedRead, nCrafted, nCraftedDecoded, nDirectValid, nDirect);
			fflush (stdout);
		}
		unsigned nKind = Below (8);
		unsigned w, h;
		u8 *pImage;
		if (nKind == 6 || nKind == 7)
		{
			// the decoder without the image: a crafted symbol's modules, or a byte stream
			int nVersion = 0, n = nKind == 6 ? CraftSymbol (QR, &nVersion) : 0;
			for (unsigned k = 0; k < 20; k++)
			{
				nDirectValid += nKind == 6 ? DecodeMatrix (QR, n) : DecodeStream ();
				nDirect++;
			}
			continue;
		}
		if (nKind == 4 || nKind == 5)
		{
			// a crafted code, as the camera would see it
			int nVersion = 0, n = CraftSymbol (QR, &nVersion);
			if (n == 0)
			{
				continue;
			}
			switch (Below (4))
			{
			case 0:  w = 320; h = 240; break;
			case 1:  w = 640; h = 480; break;
			default: w = 16 + Below (700); h = 16 + Below (700); break;
			}
			pImage = (u8 *) malloc (w * h);
			DrawSymbol (pImage, w, h, QR, n);
			if (nKind == 5)
			{
				Damage (pImage, w, h, 1 + Below (6));
			}
			nCrafted++;
			Decode (pImage, w, h, &nCraftedDecoded);
			nCraftedRead += ReachesPayload (pImage, w, h);
			free (pImage);
			continue;
		}
		if (nKind == 1 || nKind == 3)
		{
			// a real code, damaged
			unsigned nLen = 1 + Below (Below (4) ? 200 : CGkSynthCamera::MaxQRBytes);
			u8 *pData = (u8 *) malloc (nLen);
			for (unsigned i = 0; i < nLen; i++) pData[i] = (u8) Random ();
			Camera.SetQR (pData, nLen);
			free (pData);
			Camera.Start ();
			unsigned nSerial = r + 1000000, fw, fh;
			const u8 *pFrame = Camera.GetFrame (&nSerial, &fw, &fh);
			w = fw; h = fh;
			pImage = (u8 *) malloc (w * h);
			memcpy (pImage, pFrame, w * h);
			Damage (pImage, w, h, Below (12));
			if (nKind == 3 && w > 8 && h > 8)
			{
				// cropped to a random window
				unsigned cw = 1 + Below (w), ch = 1 + Below (h), cx = Below (w - cw + 1), cy = Below (h - ch + 1);
				u8 *pCrop = (u8 *) malloc (cw * ch);
				for (unsigned y = 0; y < ch; y++) memcpy (pCrop + y * cw, pImage + (cy + y) * w + cx, cw);
				free (pImage);
				pImage = pCrop; w = cw; h = ch;
			}
		}
		else
		{
			w = 1 + Below (Below (8) ? 700 : 4);
			h = 1 + Below (Below (8) ? 700 : 4);
			pImage = (u8 *) malloc (w * h);
			if (nKind == 0)
			{
				for (unsigned i = 0; i < w * h; i++) pImage[i] = Below (2) ? 255 : (u8) Random ();
			}
			else
			{
				memset (pImage, 255, w * h);
				unsigned n = Below (40);
				for (unsigned i = 0; i < n; i++) Finder (pImage, w, h, Below (w), Below (h), 1 + Below (12));
				n = Below (2000);
				for (unsigned i = 0; i < n; i++) FillRect (pImage, w, h, Below (w), Below (h), 1 + Below (6), 1 + Below (6), 0);
			}
		}

		Decode (pImage, w, h, &nDecoded);
		free (pImage);
	}
	printf ("fuzz_qr: done, %u rounds: %u images decoded, %u of %u crafted codes read (%u valid), "
		"%u of %u direct decodes valid; no faults\n",
		nRounds, nDecoded, nCraftedRead, nCrafted, nCraftedDecoded, nDirectValid, nDirect);
	return 0;
}

#endif
