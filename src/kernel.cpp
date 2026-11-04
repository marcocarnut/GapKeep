//
// kernel.cpp
//
// zerogap kernel: brings up the hardware (HDMI framebuffer, USB keyboard and
// mouse), LVGL, and the app host, then runs the main loop.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "kernel.h"
#include <circle/machineinfo.h>
#include <circle/gpiopin.h>
#include <circle/pagetable.h>
#include "runtime/version.h"
#include "runtime/appstore.h"
#include "runtime/cursor.h"

// same rate as the serial bootloader (FLASHBAUD), so one terminal setting
// covers both
#ifndef ZG_SERIAL_BAUD
#define ZG_SERIAL_BAUD	921600
#endif

static const char FromKernel[] = "kernel";

CKernel::CKernel (void)
:	m_Screen (m_Options.GetWidth (), m_Options.GetHeight ()),
	m_Timer (&m_Interrupt),
	m_Logger (m_Options.GetLogLevel (), &m_Timer),
	m_USBHCI (&m_Interrupt, &m_Timer, TRUE),	// TRUE: plug-and-play
#ifndef ZG_SEALED
	m_EMMC (&m_Interrupt, &m_Timer, &m_ActLED),
#endif
	m_GUI (&m_Screen),
	m_AppHost (&m_Keyboard)
#ifdef ZG_TEST
	, m_TestShot (&m_Screen, &m_Serial, &m_PiCamera)
#endif
{
	m_ActLED.Blink (5);	// show we are alive
}

CKernel::~CKernel (void)
{
}

boolean CKernel::Initialize (void)
{
	boolean bOK = TRUE;

	if (bOK)
	{
		bOK = m_Screen.Initialize ();
	}

#ifdef ZG_SERIAL_LOG
	if (bOK)
	{
		// ZG_SERIAL_BAUD needs a fast enough UART clock (the Pi firmware
		// gives 48 MHz, see init_uart_clock in config.txt); QEMU's is slower
		unsigned nBaud = ZG_SERIAL_BAUD;
		if (CMachineInfo::Get ()->GetClockRate (CLOCK_ID_UART) / (16 * nBaud) < 1)
		{
			nBaud = 115200;
		}
		bOK = m_Serial.Initialize (nBaud);
	}

	if (bOK)
	{
		// Log to the serial port (the screen belongs to LVGL), or to
		// another device named with "logdev=" in cmdline.txt.
		CDevice *pTarget = m_DeviceNameService.GetDevice (m_Options.GetLogDevice (), FALSE);
		if (pTarget == 0 || pTarget == &m_Screen)
		{
			pTarget = &m_Serial;
		}

		bOK = m_Logger.Initialize (pTarget);
	}
#else
	if (bOK)
	{
		// No serial port at all: the UART is never set up, and its pins
		// (GPIO 14 TXD, 15 RXD), which the firmware leaves on the UART,
		// become inputs. The log is discarded.
		CGPIOPin TxD (14, GPIOModeInputPullDown);
		CGPIOPin RxD (15, GPIOModeInputPullDown);

		bOK = m_Logger.Initialize (&m_NullLog);
	}
#endif

	if (bOK)
	{
		bOK = m_Interrupt.Initialize ();
	}

	if (bOK)
	{
		// the exception and interrupt vectors are in place: no more writes
		// to the vector page (circle/lib/pagetable.cpp, zerogap's W^X map)
		CPageTable::ProtectVectorPage ();
	}

	if (bOK)
	{
		bOK = m_Timer.Initialize ();
	}

	if (bOK)
	{
		bOK = m_USBHCI.Initialize ();
	}

	if (bOK)
	{
		// a failing RNG is reported and disables zg:crypto's random
		// functions, but does not stop the system
		m_Random.Initialize ();
	}

	if (bOK)
	{
		// apps: built in, then from the SD card (no card: built-in only)
#ifndef ZG_SEALED
		CAppStore::Initialize (m_EMMC.Initialize ());
#else
		CAppStore::Initialize (FALSE);
#endif
	}

	if (bOK)
	{
		bOK = m_GUI.Initialize ();
		ZgInstallCursor ();
	}

	if (bOK)
	{
		m_Keyboard.Initialize ();

		m_Logger.Write (FromKernel, LogNotice, "zerogap " ZEROGAP_VERSION ", built " __DATE__ " " __TIME__);
		m_Logger.Write (FromKernel, LogNotice, "Screen %ux%u", m_Screen.GetWidth (), m_Screen.GetHeight ());

#ifndef ZG_TEST
		// A Pi Camera on the connector? The probe powers it for a moment
		// only. Test builds keep their synthetic camera (the tests depend
		// on it) and switch with "#camera pi" (testshot.h).
		if (m_PiCamera.Probe ())
		{
			CZgCamera::Set (&m_PiCamera);
		}
#endif

		bOK = m_AppHost.Initialize ();
	}

	return bOK;
}

TShutdownMode CKernel::Run (void)
{
	while (1)
	{
		boolean bUpdated = m_USBHCI.UpdatePlugAndPlay ();

		m_Keyboard.Update (bUpdated);
		m_GUI.Update (bUpdated);		// runs LVGL: input, timers, drawing
		if (bUpdated)
		{
			ZgInstallCursor ();		// a mouse may have turned up
		}
		m_AppHost.Update ();			// JS jobs, deferred work, app switches
#ifdef ZG_TEST
		m_TestShot.Update ();			// serial screenshots
#endif
	}

	return ShutdownHalt;
}
