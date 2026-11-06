//
// qrdecode.h
//
// Finds and decodes QR codes in a greyscale image, with zxing-cpp
// (third_party/zxing-cpp, its QR code reader only). The image comes from the
// camera, so it is untrusted input: the decoder is fuzzed (tests/fuzz) and
// its results are copied out with their lengths checked.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _qrdecode_h
#define _qrdecode_h

#include <circle/types.h>

// more than a QR code holds (7089 digits, version 40-L): longer results are
// left out
#define ZG_QR_MAX_PAYLOAD	8896

struct TZgQRCode
{
	const u8 *pData;		// the payload's bytes as encoded, without
					// character set conversion; valid until the
					// next ZgDecodeQR call
	unsigned nLength;
	int Corners[4][2];		// x, y in the image: top left, top right,
					// bottom right, bottom left of the symbol

	// The symbol, for a reader of what else it carries (the colour layer,
	// scanner.cpp): its version (1-40), error correction level (0 L, 1 M,
	// 2 Q, 3 H), mask (0-7), whether it was read mirrored, and its data
	// codewords after error correction, block after block, without parity
	// (valid until the next ZgDecodeQR call). nDataCodewords is 0 if they
	// are not known.
	unsigned nVersion;
	int nECLevel;
	int nMask;
	boolean bMirrored;
	const u8 *pDataCodewords;
	unsigned nDataCodewords;
};

// a version 40 code's data codewords, at level L
#define ZG_QR_MAX_DATA_CODEWORDS	2956
// what a colour QR code's colours hold at most (version 40, lib/colorqr)
#define ZG_QR_MAX_COLOUR		9893

// The number of codes decoded (at most nMax), 0 if none; -1 if this build
// has no decoder. Codes found but not readable are left out.
int ZgDecodeQR (const u8 *pGrey, unsigned nWidth, unsigned nHeight,
		TZgQRCode *pCodes, unsigned nMax);

#endif
