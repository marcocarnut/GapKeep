//
// camera.h
//
// The camera, as the scanner (scanner.cpp) sees it: a source of greyscale
// frames. Apps never get frames: the kernel draws them as the scanner's
// preview and decodes them (docs/CAMERA.md). Recognising anything in the
// images is the kernel's job, never JavaScript's.
//
// Implementations: CZgSynthCamera (synthcam.h: QR codes drawn from text,
// pictures and frames pushed by the host; the simulator and test builds)
// and CZgPiCamera (src/camera/picamera.h: the Pi Camera Module v2.1, kernel
// only). No camera registered: scanners report "no camera".
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _camera_h
#define _camera_h

#include <circle/types.h>

// What part of the camera's view frames show (ui.Scanner's "field").
enum TZgCameraField
{
	ZgFieldCenter,		// the middle, at full detail (about 640x480 grey)
	ZgFieldFull		// all of it, with less detail per degree
};

class CZgCamera
{
public:
	virtual ~CZgCamera (void) {}

	// From the next Start(). Cameras with one field ignore it.
	virtual void SetField (TZgCameraField Field)	{ (void) Field; }

	// Starts streaming (the camera's LED goes on). FALSE: it can't; GetError
	// says why.
	virtual boolean Start (void) = 0;
	virtual void Stop (void) = 0;

	// The newest frame, if newer than *pSerial (which is updated): 8-bit
	// grey, nWidth * nHeight bytes, rows top to bottom. Valid until the next
	// call or Stop(). 0: no new frame.
	virtual const u8 *GetFrame (unsigned *pSerial, unsigned *pWidth, unsigned *pHeight) = 0;

	// Why the camera can't start or stopped working ("no camera", ...), or 0.
	virtual const char *GetError (void) = 0;

	// The camera of this system, or 0 if there is none.
	static CZgCamera *Get (void)			{ return s_pCamera; }
	static void Set (CZgCamera *pCamera)		{ s_pCamera = pCamera; }

private:
	static CZgCamera *s_pCamera;
};

#endif
