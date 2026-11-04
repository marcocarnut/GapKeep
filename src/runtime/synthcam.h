//
// synthcam.h
//
// A camera without a sensor, for the simulator and for test builds of the
// kernel: it films, at 15 frames a second, one of
//
//  - an empty scene (a grey gradient),
//  - a QR code drawn from bytes, slightly rotated, on that scene,
//  - a picture (8-bit grey, any size up to 4096 a side),
//  - frames pushed by the host as they come (the browser's webcam),
//
// with a little noise on every frame (but the webcam's), so the scanner
// sees what a camera would, and the decoder (qrdecode.cpp) is the same code
// as with a real camera. SetNone() makes it a missing camera.
//
// Pictures and webcam frames keep their resolution, and the field
// (camera.h) decides what the frames show, as on the Pi camera: the
// middle 640x480 pixel for pixel ("center"), or the whole picture averaged
// down to fit 640x480 ("full"). Scenes and QR codes are 640x480 already.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _synthcam_h
#define _synthcam_h

#include "camera.h"

class CZgSynthCamera : public CZgCamera
{
public:
	static const unsigned FrameWidth = 640;
	static const unsigned FrameHeight = 480;
	static const unsigned MaxPushSide = 1920;	// PushFrame() limit
	static const unsigned MaxPictureSide = 4096;	// SetPicture() limit
	static const unsigned MaxQRBytes = 2953;	// a version 40 code, low error correction

	CZgSynthCamera (void);
	~CZgSynthCamera (void);

	void SetNone (void);					// no camera
	void SetScene (void);					// nothing to see
	boolean SetQR (const u8 *pData, unsigned nLength);	// FALSE: too long
	boolean SetPicture (const u8 *pGrey, unsigned nWidth, unsigned nHeight);
	// a live frame (any size up to MaxPushSide), shown as it is until the next
	boolean PushFrame (const u8 *pGrey, unsigned nWidth, unsigned nHeight);

	const char *GetMode (void) const;			// "none", "scene", "qr", ...

	void SetField (TZgCameraField Field);

	boolean Start (void);
	void Stop (void);
	const u8 *GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight);
	const char *GetError (void);

private:
	void DrawScene (void);
	void MakeFrame (void);
	boolean SetSource (const u8 *pGrey, unsigned nWidth, unsigned nHeight, unsigned nMaxSide);
	void Derive (void);		// the source -> m_pPicture, as the field asks

private:
	enum TMode { ModeNone, ModeScene, ModeQR, ModePicture, ModeLive } m_Mode;
	boolean m_bStreaming;
	u8 *m_pPicture;		// what the camera looks at, m_nPictureWidth x ..Height
	unsigned m_nPictureWidth, m_nPictureHeight;	// at most FrameWidth x FrameHeight
	u8 *m_pFrame;		// the current frame (the picture plus noise)
	TZgCameraField m_Field;
	u8 *m_pSource;		// the picture or the last pushed frame, as given
	unsigned m_nSourceSize;	// allocated
	unsigned m_nSourceWidth, m_nSourceHeight;
	unsigned m_nSerial;
	unsigned m_nLiveSerial;	// bumped by PushFrame
	unsigned m_nTakenLive;	// the live serial the current frame shows
	unsigned long long m_nNextFrameAt;	// clock ticks
	u32 m_nNoise;		// noise generator state
};

#endif
