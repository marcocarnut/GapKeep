//
// qrscan.h
//
// The engine of the ui.QRScanner widget (js_ui.cpp): takes frames from the
// camera (camera.h), draws them as the widget's preview and decodes the QR
// codes in them (qrdecode.h). JavaScript gets the decoded bytes and nothing
// else: no pixels, no frames.
//
// One scanner at a time has the camera. A code is reported when it differs
// from the last one reported, or when it comes back after being out of
// sight for a while (or scanning starts again), so an app reading animated
// (multi-part) codes gets each part once per appearance.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _qrscan_h
#define _qrscan_h

#include <circle/types.h>
#include "qrdecode.h"

class CZgCamera;

class CZgQRScanner
{
public:
	CZgQRScanner (void);
	~CZgQRScanner (void);			// stops

	// FALSE: the camera can't start (GetError says why)
	boolean Start (void);
	void Stop (void);
	boolean IsScanning (void) const		{ return m_pCamera != 0; }

	// Call often (every 30 ms or so). Returns PollFrame if the preview
	// changed, PollCode if a code was read (GetCode), PollError if the
	// camera failed (GetError; scanning stopped).
	static const unsigned PollFrame = 1;
	static const unsigned PollCode = 2;
	static const unsigned PollError = 4;
	unsigned Poll (void);

	const u8 *GetCode (unsigned *pLength) const;	// until the next Poll
	const char *GetError (void) const		{ return m_pError; }

	// The last frame scaled to fit (letterboxed) into nWidth x nHeight
	// RGB565 pixels, with the outline of the last code read. FALSE: no
	// frame yet.
	boolean DrawPreview (u16 *pPixels, unsigned nWidth, unsigned nHeight) const;

private:
	CZgCamera *m_pCamera;			// while scanning
	const char *m_pError;
	unsigned m_nFrameSerial;
	u8 *m_pPreviewFrame;			// a copy for the preview
	unsigned m_nPreviewWidth, m_nPreviewHeight;
	unsigned long long m_nNextDecodeAt;	// clock ticks

	u8 *m_pLast;				// the last code reported
	unsigned m_nLastLength;
	unsigned long long m_nLastSeenAt;
	int m_Corners[4][2];			// of the last code seen, in frame pixels
	unsigned long long m_nCornersUntil;

	static CZgQRScanner *s_pActive;		// the scanner that has the camera
};

#endif
