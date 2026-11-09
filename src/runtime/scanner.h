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
//   "qr"        QR codes, decoded with zxing-cpp (qrdecode.h)
//   "qr-color"  experimental, only with "experimental = yes" in zerogap.txt
//               (settings.h): the data a colour QR code carries in its
//               colours (lib/colorqr), with the code's own. Reported apart
//               from "qr", never merged into it (docs/EXPERIMENTAL.md).
//
// To add one (say "aruco", for dice): a GK_DETECT_* bit and its name in
// scanner.cpp, a decoder like qrdecode.*, a case in CGkScanner::Poll, and
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

#define GK_DETECT_QR		(1u << 0)
#define GK_DETECT_QR_COLOR	(1u << 1)

// What a "qr-color" detection found (GetColour)
enum TGkColourStatus
{
	GkColourOK,		// the colour layer was read
	GkColourPlain,		// a plain QR code: no colour layer
	GkColourUnreadable	// a colour layer, or a code, it could not read
};

class CGkCamera;

class CGkScanner
{
public:
	CGkScanner (void);
	~CGkScanner (void);			// stops

	// Detectors by name ("qr"): the GK_DETECT_* bit, or 0 if this build has
	// no such detector. GetDetectorName (i) lists them (0 after the last).
	static unsigned GetDetector (const char *pName);
	static const char *GetDetectorName (unsigned nIndex, unsigned *pBit = 0);

	void SetDetectors (unsigned nDetectors)	{ m_nDetectors = nDetectors; }

	// The camera's field (camera.h), from the next Start().
	void SetField (TGkCameraField Field)		{ m_Field = Field; }
	TGkCameraField GetField (void) const		{ return m_Field; }
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

	// What was found, one detection at a time (a poll can find a QR code
	// and its colour layer): the GK_DETECT_* bit and its data (the QR
	// code's bytes), 0 when there are no more. Valid until the next Poll.
	unsigned GetDetection (const u8 **ppData, unsigned *pLength);
	// For a GK_DETECT_QR_COLOR detection: what the colours held (0 unless
	// the status is GkColourOK)
	TGkColourStatus GetColour (const u8 **ppColour, unsigned *pLength) const;
	const char *GetError (void) const		{ return m_pError; }

	// The last frame scaled to fit (letterboxed) into nWidth x nHeight
	// RGB565 pixels, with the outline of the last thing found. FALSE: no
	// frame yet.
	boolean DrawPreview (u16 *pPixels, unsigned nWidth, unsigned nHeight) const;

private:
	unsigned PollQR (const u8 *pFrame, unsigned nWidth, unsigned nHeight);
	unsigned PollColour (const TGkQRCode &rCode, unsigned nWidth, unsigned nHeight,
			     boolean bNewAppearance, unsigned long long nNow);
	void FreeColour (void);

private:
	unsigned m_nDetectors;			// GK_DETECT_* bits
	TGkCameraField m_Field;
	CGkCamera *m_pCamera;			// while scanning
	const char *m_pError;
	unsigned m_nFrameSerial;
	u8 *m_pPreviewFrame;			// a copy for the preview
	unsigned m_nPreviewWidth, m_nPreviewHeight;
	unsigned long long m_nNextDecodeAt;	// clock ticks

	unsigned long long m_nMissedSince;	// the first decode without the code, or 0
	unsigned m_nPending;			// GK_DETECT_* bits GetDetection hands out

	u8 *m_pLast;				// the last QR code reported
	unsigned m_nLastLength;
	int m_Corners[4][2];			// of the last thing found, in frame pixels
	unsigned long long m_nCornersUntil;

	// the colour layer of the code in view ("qr-color")
	boolean m_bColourRead;			// reported for this appearance
	boolean m_bColourFailReported;
	unsigned m_nColourTries;
	unsigned long long m_nColourSince;	// the first try, this appearance
	TGkColourStatus m_ColourStatus;
	u8 *m_pColour;				// its payload, GK_QR_MAX_COLOUR bytes
	unsigned m_nColourLength;
	u64 *m_pWork;				// colorqr's scratch memory, m_nWorkSize bytes
	unsigned m_nWorkSize;
	unsigned m_nColourDecodes, m_nColourOK;
	unsigned long long m_nColourTicks, m_nMaxColourTicks;
	unsigned m_nLastColourMs;		// the last try, for the log

	// for the log, when scanning stops: how long decoding takes here
	unsigned m_nFrames, m_nDecodes;
	unsigned m_nFound;			// decodes that found a code
	unsigned long long m_nSideSum;		// their sides, in frame pixels
	unsigned long long m_nDecodeTicks, m_nMaxDecodeTicks;

	static CGkScanner *s_pActive;		// the scanner that has the camera
};

#endif
