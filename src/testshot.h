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
// test pattern (0 off, 2 colour bars; docs/camera/SPEC.md 4.7). "#camera
// mode <name>": the Pi Camera's mode from its next start (detail, centre,
// full, wide, mid: docs/camera/IMPLEMENTATION.md), whatever the scanner's
// field asks for; it sticks until "#camera mode auto" or "#camera synth",
// after which the field decides again (center: detail, full: full). A switch
// applies from the next scanner start: a running scanner keeps the camera
// it started with.
//
// "#camera picture <name>": a test picture (testpictures.h: the colour QR
// codes of tests/colorqr, by their PNG's name without ".png") for the
// synthetic camera, as the simulator's "camera picture <file>".
//
// "#fonts": the bold and italic fonts made so far, with the glyph bitmaps
// drawn and the time it took (runtime/ttfstyles.h). "#redraw": the whole
// screen drawn again at once, logged with the time it took.
//
// "#keyboard <layout>": the keyboard layout (runtime/keylayout.h), as
// "keyboard = <layout>" in gapkeep.txt would, or a settings app.
//
// "#experimental on": experimental features on (runtime/settings.h), as
// "experimental = yes" in gapkeep.txt would, for the rig, whose card never
// changes. The launcher lists the experimental apps from its next start.
//
// "#camera grey": the grey frame the running Pi Camera made last, at once, for
// aiming it (tools/rig/camview.py): as "#camera raw" below, stride = width and
// no exposure or gains; 640x480 takes 3.4 s at 921600 baud.
//
// "#camera raw": the next raw frame of the running Pi Camera (RAW8 Bayer,
// as the sensor sends it: for checking colours), answered with
//
//   \nZGRAW1 <width> <height> <stride> <exposure> <analogue> <digital>
//   <payload-bytes> <crc32-hex>\n<payload>\nZGEND\n
//
// (one header line; the payload is stride * height bytes, uncompressed:
// about 13 s at 921600 baud). tools/serialshot.py reads it.
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
	CTestShot (CScreenDevice *pScreen, CSerialDevice *pSerial, CGkPiCamera *pPiCamera);

	// Call from the main loop: looks for a command on the serial line.
	void Update (void);

private:
	void Send (void);
	void SendRaw (void);
	void SendGrey (void);
	void SendBinary (const CString &rHeader, const u8 *pData, unsigned nLength);
	void Camera (const char *pArgs);

private:
	CScreenDevice *m_pScreen;
	CSerialDevice *m_pSerial;
	CGkSynthCamera m_Camera;
	CGkPiCamera *m_pPiCamera;
	char m_Line[1024];
	unsigned m_nLine;
	boolean m_bRawPending;
};

#endif
