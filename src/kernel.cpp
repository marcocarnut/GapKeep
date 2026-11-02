//
// kernel.cpp
//
// zerogap kernel: brings up the hardware (HDMI framebuffer, USB keyboard and
// mouse), LVGL, and the app host, then runs the main loop.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "kernel.h"
#include "runtime/version.h"

static const char FromKernel[] = "kernel";

CKernel::CKernel (void)
:	m_Screen (m_Options.GetWidth (), m_Options.GetHeight ()),
	m_Timer (&m_Interrupt),
	m_Logger (m_Options.GetLogLevel (), &m_Timer),
	m_USBHCI (&m_Interrupt, &m_Timer, TRUE),	// TRUE: plug-and-play
	m_GUI (&m_Screen),
	m_AppHost (&m_Keyboard)
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

	if (bOK)
	{
		bOK = m_Serial.Initialize (115200);
	}

	if (bOK)
	{
		// Log to the serial port: the screen belongs to LVGL.
		// "logdev=tty1" in cmdline.txt sends logs to the screen instead.
		CDevice *pTarget = m_DeviceNameService.GetDevice (m_Options.GetLogDevice (), FALSE);
		if (pTarget == 0 || pTarget == &m_Screen)
		{
			pTarget = &m_Serial;
		}

		bOK = m_Logger.Initialize (pTarget);
	}

	if (bOK)
	{
		bOK = m_Interrupt.Initialize ();
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
		bOK = m_GUI.Initialize ();
	}

	if (bOK)
	{
		m_Keyboard.Initialize ();

		m_Logger.Write (FromKernel, LogNotice, "zerogap " ZEROGAP_VERSION ", built " __DATE__ " " __TIME__);

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
		m_AppHost.Update ();			// JS jobs, deferred work, app switches
	}

	return ShutdownHalt;
}
