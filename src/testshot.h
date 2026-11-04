//
// testshot.h
//
// Test builds only (make TEST=1): commands on the serial line.
//
// "#shot": a screenshot, for testing on real hardware without an HDMI
// capture device.
//
// The host sends "#shot\n". The kernel answers with
//
//   \nZGSHOT1 <width> <height> <bits-per-pixel> <payload-bytes> <crc32-hex>\n
//   <payload>
//   \nZGEND\n
//
// where the payload is the framebuffer, run-length encoded as pairs of
// (count: u16 LE, pixel: bits-per-pixel/8 bytes LE). tools/serialshot.py
// decodes it.
//
// "#crash <kind>": breaks one of the memory protection rules on purpose,
// so tests/memprotect.txt can check that the system stops (testcrash.cpp).
//
// "#camera qr <text>", "#camera scene", "#camera none": what the camera
// films. Test builds have a synthetic camera (src/runtime/synthcam.h), so
// QR scanning, decoder included, can be tested in QEMU and timed on a Pi
// without a camera module.
//
// "#camera pi": the real Pi Camera (src/camera/picamera.h) instead, if the
// probe finds one ("#camera synth", or any of the commands above, goes
// back to the synthetic camera). "#camera pattern <n>": the Pi Camera's
// test pattern (0 off, 2 colour bars; docs/camera/SPEC.md 4.7). A switch
// applies from the next scanner start: a running scanner keeps the camera
// it started with.
//
// Production builds never read from the serial port.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _testshot_h
#define _testshot_h

#include <circle/screen.h>
#include <circle/serial.h>
#include "runtime/synthcam.h"
#include "camera/picamera.h"

class CTestShot
{
public:
	CTestShot (CScreenDevice *pScreen, CSerialDevice *pSerial, CZgPiCamera *pPiCamera);

	// Call from the main loop: looks for a command on the serial line.
	void Update (void);

private:
	void Send (void);
	void Camera (const char *pArgs);

private:
	CScreenDevice *m_pScreen;
	CSerialDevice *m_pSerial;
	CZgSynthCamera m_Camera;
	CZgPiCamera *m_pPiCamera;
	char m_Line[1024];
	unsigned m_nLine;
};

#endif
