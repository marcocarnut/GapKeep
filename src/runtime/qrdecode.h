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
};

// The number of codes decoded (at most nMax), 0 if none; -1 if this build
// has no decoder. Codes found but not readable are left out.
int ZgDecodeQR (const u8 *pGrey, unsigned nWidth, unsigned nHeight,
		TZgQRCode *pCodes, unsigned nMax);

#endif
