//
// fuzz_colorqr.cpp - fuzzes the colour QR decoder (lib/colorqr) as the
// scanner calls it (src/runtime/scanner.cpp, "qr-color"), with
// AddressSanitizer and UBSan: the camera's pictures are untrusted input.
// Built and run by tools/fuzz_colorqr.sh.
//
// Each round takes one of the real colour codes (tests/colorqr, as PPM),
// damages it (noise, rectangles of random colour, swapped or scaled
// channels, blur, crops, mirroring, random sizes), finds the code with the
// real QR decoder (ZgDecodeQR, zxing-cpp) on its grey, and calls
// cq_decode_base or cq_decode with:
//
//  - what zxing-cpp found (as the scanner does),
//  - or that, falsified: corners moved, swapped, huge, NaN or infinite;
//    versions from 0 to 45; the base's codewords flipped, truncated or
//    lengthened, its level and mask out of range,
//  - work buffers and payload buffers sized right, or too small,
//
// on frames of random size and stride (up to 16384 wide), also of pure noise. Checked: no
// memory error or undefined behaviour (the sanitizers stop the run), and
// the results' promises: a payload no longer than its buffer, a work_used
// no larger than the buffer, CQ_ERR_TOO_BIG's length larger than the
// buffer, and the same result from the same call twice (no hidden state).
// FUZZ_TRACE=1 prints each call before it is made.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "qrdecode.h"
#include <colorqr.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <vector>
#include <string>

// what the runtime would provide
extern "C" void zg_fatal (const char *pMessage)
{
	fprintf (stderr, "fuzz_colorqr: fatal error: %s\n", pMessage);
	abort ();
}

extern "C" void cq_stage (int) {}	// colorqr's profiling hook (scanner.cpp)

static unsigned s_nState;
static unsigned Rand (void)
{
	s_nState ^= s_nState << 13;
	s_nState ^= s_nState >> 17;
	s_nState ^= s_nState << 5;
	return s_nState;
}
static unsigned Rand (unsigned n) { return n ? Rand () % n : 0; }
static float RandF (float a, float b) { return a + (b - a) * (Rand () & 0xFFFFFF) / (float) 0xFFFFFF; }

struct TFrame
{
	unsigned w, h;
	std::vector<unsigned char> rgb;
};

static bool ReadPPM (const char *pPath, TFrame *pFrame)
{
	FILE *f = fopen (pPath, "rb");
	if (!f) return false;
	char Magic[3] = {0};
	unsigned w, h, nMax;
	bool bOK =    fscanf (f, "%2s %u %u %u", Magic, &w, &h, &nMax) == 4 && strcmp (Magic, "P6") == 0
		   && nMax == 255 && fgetc (f) != EOF;
	if (bOK)
	{
		pFrame->w = w;
		pFrame->h = h;
		pFrame->rgb.resize ((size_t) w * h * 3);
		bOK = fread (pFrame->rgb.data (), 1, pFrame->rgb.size (), f) == pFrame->rgb.size ();
	}
	fclose (f);
	return bOK;
}

static unsigned char Clamp (int v) { return (unsigned char) (v < 0 ? 0 : v > 255 ? 255 : v); }

// the frame, damaged in random ways
static TFrame Damage (const TFrame &rIn)
{
	TFrame F = rIn;
	unsigned w = F.w, h = F.h;
	unsigned char *p = F.rgb.data ();
	unsigned nKinds = Rand (4);
	for (unsigned k = 0; k < nKinds; k++)
	{
		switch (Rand (9))
		{
		case 0:		// noise
		{
			int a = 1 + Rand (60);
			for (size_t i = 0; i < F.rgb.size (); i++) p[i] = Clamp (p[i] + (int) Rand (2 * a + 1) - a);
			break;
		}
		case 1:		// rectangles of random colour
			for (unsigned n = 1 + Rand (8); n--; )
			{
				unsigned x0 = Rand (w), y0 = Rand (h), x1 = x0 + Rand (w / 3 + 1), y1 = y0 + Rand (h / 3 + 1);
				unsigned char c[3] = {(unsigned char) Rand (256), (unsigned char) Rand (256), (unsigned char) Rand (256)};
				for (unsigned y = y0; y < y1 && y < h; y++)
					for (unsigned x = x0; x < x1 && x < w; x++)
						memcpy (p + 3 * ((size_t) y * w + x), c, 3);
			}
			break;
		case 2:		// channels swapped
		{
			unsigned a = Rand (3), b = Rand (3);
			for (size_t i = 0; i < (size_t) w * h; i++) { unsigned char t = p[3 * i + a]; p[3 * i + a] = p[3 * i + b]; p[3 * i + b] = t; }
			break;
		}
		case 3:		// channels scaled (white balance, exposure), maybe clipping
		{
			float s[3] = {RandF (0.1f, 2.5f), RandF (0.1f, 2.5f), RandF (0.1f, 2.5f)};
			for (size_t i = 0; i < F.rgb.size (); i++) p[i] = Clamp ((int) (p[i] * s[i % 3]));
			break;
		}
		case 4:		// a box blur
		{
			std::vector<unsigned char> q (F.rgb);
			for (unsigned y = 1; y + 1 < h; y++)
				for (unsigned x = 1; x + 1 < w; x++)
					for (unsigned c = 0; c < 3; c++)
					{
						unsigned s = 0;
						for (int dy = -1; dy <= 1; dy++)
							for (int dx = -1; dx <= 1; dx++)
								s += q[3 * ((size_t) (y + dy) * w + x + dx) + c];
						p[3 * ((size_t) y * w + x) + c] = (unsigned char) (s / 9);
					}
			break;
		}
		case 5:		// mirrored
			for (unsigned y = 0; y < h; y++)
				for (unsigned x = 0; x < w / 2; x++)
					for (unsigned c = 0; c < 3; c++)
					{
						unsigned char *a = p + 3 * ((size_t) y * w + x) + c, *b = p + 3 * ((size_t) y * w + w - 1 - x) + c;
						unsigned char t = *a; *a = *b; *b = t;
					}
			break;
		case 6:		// random bytes in a band
		{
			size_t i0 = Rand ((unsigned) F.rgb.size ()), n = Rand (20000);
			for (size_t i = i0; i < i0 + n && i < F.rgb.size (); i++) p[i] = (unsigned char) Rand (256);
			break;
		}
		case 7:		// cropped (the code may be cut)
		{
			unsigned nw = 8 + Rand (w), nh = 8 + Rand (h);
			if (nw > w) nw = w;
			if (nh > h) nh = h;
			unsigned x0 = Rand (w - nw + 1), y0 = Rand (h - nh + 1);
			TFrame C;
			C.w = nw; C.h = nh; C.rgb.resize ((size_t) nw * nh * 3);
			for (unsigned y = 0; y < nh; y++) memcpy (&C.rgb[3 * (size_t) y * nw], p + 3 * ((size_t) (y0 + y) * w + x0), 3 * nw);
			return C;
		}
		default:	// pure noise
			for (size_t i = 0; i < F.rgb.size (); i++) p[i] = (unsigned char) Rand (256);
			break;
		}
	}
	return F;
}

static unsigned long s_nCalls, s_nOK, s_nBaseFound;

static void Call (const TFrame &F, unsigned nStride, const std::vector<unsigned char> &rPadded,
		  const float Corners[4][2], unsigned nVersion, const cq_base *pBase, unsigned nFlags,
		  size_t nWork, size_t nCap)
{
	if (getenv ("FUZZ_TRACE") != 0)
	{
		// the call, for reproducing a report (the last one printed)
		fprintf (stderr, "call: %ux%u stride %u, corners (%g,%g) (%g,%g) (%g,%g) (%g,%g), version %u,"
			 " base %s (%zu codewords, ecl %d, mask %d), flags %u, work %zu, cap %zu\n",
			 F.w, F.h, nStride, Corners[0][0], Corners[0][1], Corners[1][0], Corners[1][1],
			 Corners[2][0], Corners[2][1], Corners[3][0], Corners[3][1], nVersion,
			 pBase ? "given" : "none", pBase ? pBase->data_len : 0, pBase ? pBase->ecl : 0,
			 pBase ? pBase->mask : 0, nFlags, nWork, nCap);
	}
	std::vector<unsigned long long> Work ((nWork + 7) / 8 + 1);
	std::vector<unsigned char> Payload (nCap + 1);
	cq_status Results[2];
	size_t Lengths[2];
	for (int k = 0; k < 2; k++)
	{
		cq_result R;
		memset (&R, 0, sizeof R);
		R.payload = nCap ? Payload.data () : 0;
		R.payload_cap = nCap;
		Results[k] = pBase ? cq_decode_base (rPadded.data (), F.w, F.h, nStride, Corners, nVersion, pBase,
						     nFlags, Work.data (), nWork, &R)
				   : cq_decode (rPadded.data (), F.w, F.h, nStride, Corners, nVersion,
						nFlags, Work.data (), nWork, &R);
		Lengths[k] = R.payload_len;
		s_nCalls++;
		if (Results[k] == CQ_OK)
		{
			s_nOK++;
			if (R.payload_len > nCap) { fprintf (stderr, "payload_len %zu > cap %zu\n", R.payload_len, nCap); abort (); }
		}
		// (colorqr 1.1.0 reports an empty payload as too big for no buffer:
		// an all-zero stream is a valid codeword and decodes to length 0.
		// Fixed on colorqr's branch fix-empty-payload, not released yet.)
		if (Results[k] == CQ_ERR_TOO_BIG && R.payload_len <= nCap
		    && !(R.payload_len == 0 && nCap == 0))
		{
			fprintf (stderr, "CQ_ERR_TOO_BIG with payload_len %zu <= cap %zu\n", R.payload_len, nCap);
			abort ();
		}
		if (Results[k] != CQ_ERR_ARGS && R.work_used > nWork)
		{
			fprintf (stderr, "work_used %zu > work %zu\n", R.work_used, nWork);
			abort ();
		}
	}
	if (Results[0] != Results[1] || Lengths[0] != Lengths[1])
	{
		fprintf (stderr, "the same call gave %d/%zu, then %d/%zu\n", Results[0], Lengths[0], Results[1], Lengths[1]);
		abort ();
	}
}

int main (int argc, char **argv)
{
	if (argc < 4)
	{
		fprintf (stderr, "usage: fuzz_colorqr rounds seed frame.ppm...\n");
		return 2;
	}
	unsigned long nRounds = strtoul (argv[1], 0, 10);
	s_nState = (unsigned) strtoul (argv[2], 0, 10) * 2654435761u + 1;
	std::vector<TFrame> Frames;
	for (int i = 3; i < argc; i++)
	{
		TFrame F;
		if (!ReadPPM (argv[i], &F)) { fprintf (stderr, "%s: not a binary PPM\n", argv[i]); return 2; }
		Frames.push_back (F);
	}

	for (unsigned long r = 0; r < nRounds; r++)
	{
		TFrame F = Damage (Frames[Rand ((unsigned) Frames.size ())]);
		if (Rand (20) == 0)		// tiny or lopsided
		{
			F.w = 1 + Rand (40); F.h = 1 + Rand (40);
			F.rgb.assign ((size_t) F.w * F.h * 3, 0);
			for (auto &b : F.rgb) b = (unsigned char) Rand (256);
		}
		else if (Rand (300) == 0)	// very large (colorqr takes up to 16384 a side): the code
		{				// pasted into a big noisy frame, or a long thin one
			TFrame B;
			B.w = Rand (2) ? 4000 + Rand (12385) : 16384;
			B.h = B.w == 16384 ? 2 + Rand (64) : 2000 + Rand (2000);
			B.rgb.resize ((size_t) B.w * B.h * 3);
			for (size_t i = 0; i < B.rgb.size (); i += 64) B.rgb[i] = (unsigned char) Rand (256);
			unsigned x0 = Rand (B.w > F.w ? B.w - F.w : 1), y0 = Rand (B.h > F.h ? B.h - F.h : 1);
			for (unsigned y = 0; y < F.h && y0 + y < B.h; y++)
			{
				unsigned n = F.w < B.w - x0 ? F.w : B.w - x0;
				memcpy (&B.rgb[3 * ((size_t) (y0 + y) * B.w + x0)], &F.rgb[3 * (size_t) y * F.w], 3 * n);
			}
			F = std::move (B);
		}

		// the real decoder on the grey, as the camera gives it
		std::vector<unsigned char> Grey ((size_t) F.w * F.h);
		for (size_t i = 0; i < Grey.size (); i++)
			Grey[i] = (unsigned char) ((F.rgb[3 * i] + 2 * F.rgb[3 * i + 1] + F.rgb[3 * i + 2]) / 4);
		TZgQRCode Code;
		memset (&Code, 0, sizeof Code);
		int nFound = ZgDecodeQR (Grey.data (), F.w, F.h, &Code, 1);
		if (nFound > 0) s_nBaseFound++;

		// a stride with padding sometimes
		unsigned nStride = F.w * 3 + (Rand (4) == 0 ? Rand (64) : 0);
		std::vector<unsigned char> Padded ((size_t) nStride * F.h + 1);
		for (unsigned y = 0; y < F.h; y++) memcpy (&Padded[(size_t) y * nStride], &F.rgb[3 * (size_t) y * F.w], 3 * F.w);

		float Corners[4][2];
		unsigned nVersion;
		std::vector<unsigned char> Data;
		cq_base Base = {0, 0, 0, 0};
		bool bBase = false;
		if (nFound > 0 && Rand (3) != 0)
		{
			for (int k = 0; k < 4; k++) { Corners[k][0] = (float) Code.Corners[k][0]; Corners[k][1] = (float) Code.Corners[k][1]; }
			nVersion = Code.nVersion;
			Data.assign (Code.pDataCodewords, Code.pDataCodewords + Code.nDataCodewords);
			Base.ecl = Code.nECLevel;
			Base.mask = Code.nMask;
			bBase = Code.nDataCodewords > 0 && Rand (4) != 0;
		}
		else
		{
			for (int k = 0; k < 4; k++) { Corners[k][0] = RandF (-50, F.w + 50.0f); Corners[k][1] = RandF (-50, F.h + 50.0f); }
			nVersion = 1 + Rand (40);
			Data.resize (Rand (3000));
			for (auto &b : Data) b = (unsigned char) Rand (256);
			Base.ecl = (int) Rand (4);
			Base.mask = (int) Rand (8);
			bBase = Rand (2) == 0;
		}

		// falsified
		switch (Rand (10))
		{
		case 0: Corners[Rand (4)][Rand (2)] += RandF (-30, 30); break;
		case 1: { float t[2]; unsigned a = Rand (4), b = Rand (4); memcpy (t, Corners[a], sizeof t); memcpy (Corners[a], Corners[b], sizeof t); memcpy (Corners[b], t, sizeof t); break; }
		case 2: Corners[Rand (4)][Rand (2)] = Rand (2) ? NAN : (Rand (2) ? INFINITY : -INFINITY); break;
		case 3: Corners[Rand (4)][Rand (2)] = Rand (2) ? 1e30f : -1e30f; break;
		case 4: nVersion = Rand (46); break;
		case 5: if (!Data.empty ()) Data[Rand ((unsigned) Data.size ())] ^= (unsigned char) (1 + Rand (255)); break;
		case 6: Data.resize (Rand ((unsigned) Data.size () + 50)); break;
		case 7: Base.ecl = (int) Rand (10) - 3; Base.mask = (int) Rand (14) - 3; break;
		default: break;
		}
		if (bBase)
		{
			Base.data = Data.empty () ? 0 : Data.data ();
			Base.data_len = Data.size ();
		}

		size_t nWork = cq_work_size (F.w, F.h, nVersion >= 1 && nVersion <= 40 ? nVersion : 40);
		if (Rand (6) == 0) nWork = Rand ((unsigned) nWork + 1);
		size_t nCap = Rand (5) == 0 ? Rand (600) : ZG_QR_MAX_COLOUR;
		unsigned nFlags = Rand (2) ? CQ_FLAG_LINEAR : 0;
		if (Rand (50) == 0) nFlags = Rand ();

		Call (F, nStride, Padded, Corners, nVersion, bBase ? &Base : 0, nFlags, nWork, nCap);

		if ((r + 1) % 100 == 0)
		{
			printf ("fuzz_colorqr: %lu rounds, %lu calls, %lu read, %lu bases found\n", r + 1, s_nCalls, s_nOK, s_nBaseFound);
			fflush (stdout);
		}
	}
	printf ("fuzz_colorqr: done, %lu rounds, %lu calls, %lu read, %lu bases found\n", nRounds, s_nCalls, s_nOK, s_nBaseFound);
	return 0;
}
