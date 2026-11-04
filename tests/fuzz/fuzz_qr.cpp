//
// fuzz_qr.cpp - fuzzes the QR decoder (src/runtime/qrdecode.cpp, quirc)
// with AddressSanitizer and UBSan: the camera's pictures are untrusted
// input, and the decoder is C. Built and run by tools/fuzz_qr.sh.
//
// Each round builds a greyscale image of random size and feeds it to
// ZgDecodeQR, which must neither crash nor return a payload longer than
// ZG_QR_MAX_PAYLOAD. The images are:
//
//  - noise (random bytes),
//  - a real QR code (random payload, from the synthetic camera) damaged in
//    random ways: pixels, rectangles, rows, columns flipped or blanked,
//  - many finder-pattern-like squares (quirc's capstone/grid search, where
//    decoders tend to go wrong),
//  - all of these with random dimensions, including tiny and lopsided ones.
//
// With clang, -DZG_LIBFUZZER builds a libFuzzer target instead: the input
// bytes are the image (two bytes of width, two of height, then pixels).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "qrdecode.h"
#include "synthcam.h"
#include <circle/timer.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

// --- what the runtime would provide -------------------------------------------

u64 CTimer::GetClockTicks64 (void) { return 0; }
extern "C" void lv_log_add (int, const char *, int, const char *, const char *, ...) {}
extern "C" void halt (void) { abort (); }

static void Decode (const u8 *pImage, unsigned w, unsigned h)
{
	TZgQRCode Codes[4];
	int n = ZgDecodeQR (pImage, w, h, Codes, 4);
	if (n < 0)
	{
		fprintf (stderr, "fuzz_qr: built without the decoder\n");
		exit (2);
	}
	for (int i = 0; i < n; i++)
	{
		if (Codes[i].nLength > ZG_QR_MAX_PAYLOAD)
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
}

#ifdef ZG_LIBFUZZER

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

int main (int argc, char **argv)
{
	unsigned nRounds = argc > 1 ? atoi (argv[1]) : 2000;
	s_nRandom = argc > 2 ? atoi (argv[2]) : 1;
	if (s_nRandom == 0) s_nRandom = 1;

	CZgSynthCamera Camera;
	unsigned nDecoded = 0;
	for (unsigned r = 0; r < nRounds; r++)
	{
		unsigned nKind = Below (4);
		unsigned w, h;
		u8 *pImage;
		if (nKind == 1 || nKind == 3)
		{
			// a real code, damaged
			unsigned nLen = 1 + Below (Below (4) ? 200 : CZgSynthCamera::MaxQRBytes);
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
			unsigned nDamage = Below (12);
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

		TZgQRCode Probe[1];
		Decode (pImage, w, h);
		nDecoded += ZgDecodeQR (pImage, w, h, Probe, 1) > 0;
		free (pImage);
		if ((r + 1) % 500 == 0)
		{
			printf ("fuzz_qr: %u rounds, %u images decoded\n", r + 1, nDecoded);
			fflush (stdout);
		}
	}
	printf ("fuzz_qr: done, %u rounds, %u images decoded, no faults\n", nRounds, nDecoded);
	return 0;
}

#endif
