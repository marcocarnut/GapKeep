//
// scanner.h
//
// The engine of the ui.Scanner widget (js_ui.cpp): takes frames from the
// camera (camera.h), draws them as the widget's preview and runs the
// detectors the app asked for on them. JavaScript gets what the detectors
// found (a QR code's bytes, ...) and nothing else: no pixels, no frames.
// Recognising things in pictures happens here, in the kernel, never in
// JavaScript (docs/CAMERA.md).
//
// Detectors, by the name apps use (manifest-free: "detect" in the widget):
//
//   "qr"      QR codes, decoded with zxing-cpp (qrdecode.h)
//
// To add one (say "aruco", for dice): a ZG_DETECT_* bit and its name in
// scanner.cpp, a decoder like qrdecode.*, a case in CZgScanner::Poll, and
// its event fields in js_ui.cpp and docs/api/zerogap-api.yaml.
//
// One scanner at a time has the camera. A QR code is reported when it
// differs from the last one reported, or when it comes back after being
// out of sight for a while (or scanning starts again), so an app reading
// animated (multi-part) codes gets each part once per appearance.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _scanner_h
#define _scanner_h

#include <circle/types.h>
#include "qrdecode.h"
#include "camera.h"

#define ZG_DETECT_QR	(1u << 0)

class CZgCamera;

class CZgScanner
{
public:
	CZgScanner (void);
	~CZgScanner (void);			// stops

	// Detectors by name ("qr"): the ZG_DETECT_* bit, or 0 if this build has
	// no such detector. GetDetectorName (i) lists them (0 after the last).
	static unsigned GetDetector (const char *pName);
	static const char *GetDetectorName (unsigned nIndex, unsigned *pBit = 0);

	void SetDetectors (unsigned nDetectors)	{ m_nDetectors = nDetectors; }

	// The camera's field (camera.h), from the next Start().
	void SetField (TZgCameraField Field)		{ m_Field = Field; }
	TZgCameraField GetField (void) const		{ return m_Field; }
	unsigned GetDetectors (void) const	{ return m_nDetectors; }

	// FALSE: the camera can't start (GetError says why)
	boolean Start (void);
	void Stop (void);
	boolean IsScanning (void) const		{ return m_pCamera != 0; }

	// Call often (every 30 ms or so). Returns PollFrame if the preview
	// changed, PollDetect if something was found (GetDetection), PollError
	// if the camera failed (GetError; scanning stopped).
	static const unsigned PollFrame = 1;
	static const unsigned PollDetect = 2;
	static const unsigned PollError = 4;
	unsigned Poll (void);

	// What was found: the ZG_DETECT_* bit, and its data (a QR code's bytes).
	// Valid until the next Poll.
	unsigned GetDetection (const u8 **ppData, unsigned *pLength) const;
	const char *GetError (void) const		{ return m_pError; }

	// The last frame scaled to fit (letterboxed) into nWidth x nHeight
	// RGB565 pixels, with the outline of the last thing found. FALSE: no
	// frame yet.
	boolean DrawPreview (u16 *pPixels, unsigned nWidth, unsigned nHeight) const;

private:
	unsigned PollQR (const u8 *pFrame, unsigned nWidth, unsigned nHeight);

private:
	unsigned m_nDetectors;			// ZG_DETECT_* bits
	TZgCameraField m_Field;
	CZgCamera *m_pCamera;			// while scanning
	const char *m_pError;
	unsigned m_nFrameSerial;
	u8 *m_pPreviewFrame;			// a copy for the preview
	unsigned m_nPreviewWidth, m_nPreviewHeight;
	unsigned long long m_nNextDecodeAt;	// clock ticks

	u8 *m_pLast;				// the last QR code reported
	unsigned m_nLastLength;
	unsigned long long m_nLastSeenAt;
	int m_Corners[4][2];			// of the last thing found, in frame pixels
	unsigned long long m_nCornersUntil;

	// for the log, when scanning stops: how long decoding takes here
	unsigned m_nFrames, m_nDecodes;
	unsigned m_nFound;			// decodes that found a code
	unsigned long long m_nSideSum;		// their sides, in frame pixels
	unsigned long long m_nDecodeTicks, m_nMaxDecodeTicks;

	static CZgScanner *s_pActive;		// the scanner that has the camera
};

#endif
