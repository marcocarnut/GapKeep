//
// kernel.cpp
//
// GapKeep kernel: brings up the hardware (HDMI framebuffer, USB keyboard and
// mouse), LVGL, and the app host, then runs the main loop.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "kernel.h"
#include <circle/bcmpropertytags.h>
#include <circle/machineinfo.h>
#include <circle/gpiopin.h>
#include <circle/pagetable.h>
#include <circle/string.h>
#include <circle/util.h>
#include "runtime/version.h"
#include "runtime/appstore.h"
#include "runtime/cursor.h"
#include "runtime/wheel.h"
#include "crypto/wipe.h"

// same rate as the serial bootloader (FLASHBAUD), so one terminal setting
// covers both
#ifndef GK_SERIAL_BAUD
#define GK_SERIAL_BAUD	921600
#endif

static const char FromKernel[] = "kernel";

// What the log keeps. Circle's logger copies every line it writes into a
// 16 KB ring buffer in RAM, whatever its target, and queues every message
// as an event (the last 50, on the heap) for whoever reads them. Builds
// without a serial log write nothing (LogPanic: only a panic, which stops
// the system, gets that far), so the ring buffer stays empty, whatever
// cmdline.txt's "loglevel" says. Builds with one keep it: their log leaves
// the device anyway (docs/ARCHITECTURE.md, "Security model").
#ifdef GK_SERIAL_LOG
#define GK_LOG_LEVEL	m_Options.GetLogLevel ()
#else
#define GK_LOG_LEVEL	LogPanic
#endif

// ... and nothing reads the events: each is taken off the queue as soon as
// it is queued, and its copy here wiped (the event itself is freed, which
// zeroes it: patches/circle/0011). Every build.
static void DropLogEvents (void)
{
	TLogSeverity Severity;
	char Source[LOG_MAX_SOURCE];
	char Message[LOG_MAX_MESSAGE];
	time_t Time;
	unsigned nHundredthTime;
	int nTimeZone;
	CLogger *pLogger = CLogger::Get ();
	while (pLogger->ReadEvent (&Severity, Source, Message, &Time, &nHundredthTime, &nTimeZone))
	{
	}
	gk_wipe (Source, sizeof Source);
	gk_wipe (Message, sizeof Message);
}

CKernel::CKernel (void)
:	m_Screen (m_Options.GetWidth (), m_Options.GetHeight ()),
	m_Timer (&m_Interrupt),
	m_Logger (GK_LOG_LEVEL, &m_Timer),
	m_CPUThrottle (CPUSpeedMaximum),
	m_USBHCI (&m_Interrupt, &m_Timer, TRUE),	// TRUE: plug-and-play
#ifndef GK_SEALED
	m_EMMC (&m_Interrupt, &m_Timer, &m_ActLED),
#endif
	m_GUI (&m_Screen),
	m_AppHost (&m_Keyboard)
#ifdef GK_TEST
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

	if (bOK)
	{
		ShowLoading ();
	}

#ifdef GK_SERIAL_LOG
	if (bOK)
	{
		// GK_SERIAL_BAUD needs a fast enough UART clock (the Pi firmware
		// gives 48 MHz, see init_uart_clock in config.txt); QEMU's is slower
		unsigned nBaud = GK_SERIAL_BAUD;
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
		m_Logger.RegisterEventNotificationHandler (DropLogEvents);
		DropLogEvents ();		// those queued before
	}

	if (bOK)
	{
		bOK = m_Interrupt.Initialize ();
	}

	if (bOK)
	{
		// the exception and interrupt vectors are in place: no more writes
		// to the vector page (circle/lib/pagetable.cpp, GapKeep's W^X map)
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
		// a failing RNG is reported and disables gk:crypto's random
		// functions, but does not stop the system
		m_Random.Initialize ();
	}

	if (bOK)
	{
		// apps: built in, then from the SD card (no card: built-in only)
#ifndef GK_SEALED
		CAppStore::Initialize (m_EMMC.Initialize ());
#else
		CAppStore::Initialize (FALSE);
#endif
	}

	if (bOK)
	{
		bOK = m_GUI.Initialize ();
		GkInstallCursor ();
	}

	if (bOK)
	{
		m_Keyboard.Initialize ();

		m_Logger.Write (FromKernel, LogNotice, "gapkeep " GAPKEEP_VERSION ", built " __DATE__ " " __TIME__);
		m_Logger.Write (FromKernel, LogNotice, "Screen %ux%u", m_Screen.GetWidth (), m_Screen.GetHeight ());
		LogClocks ();

#ifndef GK_TEST
		// A Pi Camera on the connector? The probe powers it for a moment
		// only. Test builds keep their synthetic camera (the tests depend
		// on it) and switch with "#camera pi" (testshot.h).
		if (m_PiCamera.Probe ())
		{
			CGkCamera::Set (&m_PiCamera);
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
		int nWheel = m_GUI.TakeWheelMove ();	// USB: > 0 is up (patches/circle/0006)
		if (nWheel != 0)
		{
			GkWheel (-nWheel);		// scrolls what is under the pointer
		}
		if (bUpdated)
		{
			GkInstallCursor ();		// a mouse may have turned up
		}
		m_AppHost.Update ();			// JS jobs, deferred work, app switches
		m_CPUThrottle.Update ();		// down to the minimum when hot
#ifdef GK_TEST
		m_TestShot.Update ();			// serial screenshots
#endif
	}

	return ShutdownHalt;
}

// Between the firmware's rainbow and the launcher there are about two and a
// half seconds of setup (USB, the SD card, LVGL, QuickJS): a line in the
// middle of the screen says what is happening, instead of a lone blinking
// cursor. LVGL draws over it. ASCII only: the screen's font has nothing else.
void CKernel::ShowLoading (void)
{
	static const char *Lines[] = {
		"GapKeep is loading.",
		"It will come up in a few seconds."
	};
	const unsigned nLines = sizeof Lines / sizeof Lines[0];

	m_Screen.Write ("\x1b[?25l", 6);		// no cursor
	unsigned nRow = m_Screen.GetRows () / 2 - nLines / 2;
	for (unsigned i = 0; i < nLines; i++)
	{
		size_t nLength = strlen (Lines[i]);
		unsigned nColumns = m_Screen.GetColumns ();
		unsigned nColumn = nLength < nColumns ? (nColumns - nLength) / 2 : 0;

		CString Move;
		Move.Format ("\x1b[%u;%uH", nRow + i + 1, nColumn + 1);	// 1-based
		m_Screen.Write ((const char *) Move, Move.GetLength ());
		m_Screen.Write (Lines[i], nLength);
	}
}

// The ARM's clock as the firmware has it: the Pi Zero boots at its minimum
// (700 MHz; config.txt has no turbo), and m_CPUThrottle asks for the
// maximum (1 GHz). The firmware's turbo mode raises the core clock too:
// logged, for the peripherals that derive their clocks from it.
void CKernel::LogClocks (void)
{
	CBcmPropertyTags Tags;
	unsigned Rates[2];
	static const u32 Clocks[2] = {CLOCK_ID_ARM, CLOCK_ID_CORE};
	for (unsigned i = 0; i < 2; i++)
	{
		TPropertyTagClockRate Tag;
		Tag.nClockId = Clocks[i];
		Tag.nRate = 0;
		Rates[i] = Tags.GetTag (PROPTAG_GET_CLOCK_RATE, &Tag, sizeof Tag, 4) ? Tag.nRate / 1000000 : 0;
	}
	m_Logger.Write (FromKernel, LogNotice, "ARM %u MHz (%s, %u..%u), core %u MHz, %u C",
			Rates[0], m_CPUThrottle.IsDynamic () ? "throttled when hot" : "fixed",
			m_CPUThrottle.GetMinClockRate () / 1000000, m_CPUThrottle.GetMaxClockRate () / 1000000,
			Rates[1], m_CPUThrottle.GetTemperature ());
}
