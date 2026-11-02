//
// testshot.h
//
// Test builds only (make TEST=1): screenshots over the serial line, for
// testing on real hardware without an HDMI capture device.
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
// Production builds never read from the serial port.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _testshot_h
#define _testshot_h

#include <circle/screen.h>
#include <circle/serial.h>

class CTestShot
{
public:
	CTestShot (CScreenDevice *pScreen, CSerialDevice *pSerial);

	// Call from the main loop: looks for a command on the serial line.
	void Update (void);

private:
	void Send (void);

private:
	CScreenDevice *m_pScreen;
	CSerialDevice *m_pSerial;
	char m_Line[16];
	unsigned m_nLine;
};

#endif
