//
// testpictures.h
//
// Test builds only: pictures for the synthetic camera ("#camera picture
// <name>", testshot.h), from tests/colorqr (tools/make_test_pictures.py):
// RGB, run-length encoded as runs of (count, R, G, B).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _testpictures_h
#define _testpictures_h

#ifdef __cplusplus
extern "C" {
#endif

typedef struct
{
	const char *pName;		// the PNG's name without ".png"
	unsigned nWidth, nHeight;
	const unsigned char *pRuns;
	unsigned nLength;
}
TZgTestPicture;

extern const TZgTestPicture zg_test_pictures[];	// ends with pName == 0

#ifdef __cplusplus
}
#endif

#endif
