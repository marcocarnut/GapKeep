//
// platform.cpp - what Circle provides on the Pi, for the simulator: the
// logger, the timer, the hardware random number generator (from the host's
// random source), the device name service (just the keyboard) and halt().
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/bcmrandom.h>
#include <circle/devicenameservice.h>
#include <circle/startup.h>
#include <circle/usb/usbkeyboard.h>
#include "sim.h"
#include "../../src/runtime/clock.h"
#include <sys/time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/random.h>

// --- clock --------------------------------------------------------------------

static u64 s_nStartUsec;

static u64 NowUsec (void)
{
	struct timespec ts;
	clock_gettime (CLOCK_MONOTONIC, &ts);
	return (u64) ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

void GkSimClockStart (void)
{
	s_nStartUsec = NowUsec ();
}

CTimer *CTimer::Get (void)
{
	static CTimer s_Timer;
	return &s_Timer;
}

unsigned CTimer::GetClockTicks (void)
{
	return (unsigned) (NowUsec () - s_nStartUsec);
}

u64 CTimer::GetClockTicks64 (void)
{
	return NowUsec () - s_nStartUsec;
}

unsigned CTimer::GetTicks (void) const
{
	return (unsigned) (GetClockTicks64 () / (CLOCKHZ / HZ));
}

unsigned CTimer::GetUptime (void) const
{
	return (unsigned) (GetClockTicks64 () / CLOCKHZ);
}

boolean CTimer::GetUptime (unsigned *pSeconds, unsigned *pMicroSeconds)
{
	u64 n = GetClockTicks64 ();
	*pSeconds = (unsigned) (n / CLOCKHZ);
	*pMicroSeconds = (unsigned) (n % CLOCKHZ);
	return TRUE;
}

// The Pi has no real-time clock, and GapKeep sets none: like the device,
// the simulator has no time of day (Date counts from 1970 + uptime).
boolean CTimer::GetUniversalTime (unsigned *pSeconds, unsigned *pMicroSeconds)
{
	(void) pSeconds;
	(void) pMicroSeconds;
	return FALSE;
}

void CTimer::SimpleMsDelay (unsigned nMilliSeconds)
{
	usleep (nMilliSeconds * 1000);
}

// --- logger -------------------------------------------------------------------

CLogger *CLogger::Get (void)
{
	static CLogger s_Logger;
	return &s_Logger;
}

void CLogger::Write (const char *pSource, TLogSeverity Severity, const char *pMessage, ...)
{
	va_list Args;
	va_start (Args, pMessage);
	WriteV (pSource, Severity, pMessage, Args);
	va_end (Args);
}

// As Circle formats log lines: "hh:mm:ss.cc source: message"
void CLogger::WriteV (const char *pSource, TLogSeverity Severity, const char *pMessage, va_list Args)
{
	char Message[2048];
	vsnprintf (Message, sizeof Message, pMessage, Args);

	unsigned nCenti = (unsigned) (CTimer::GetClockTicks64 () / (CLOCKHZ / 100));
	char Line[2200];
	snprintf (Line, sizeof Line, "%02u:%02u:%02u.%02u %s: %s",
		  nCenti / 360000, nCenti / 6000 % 60, nCenti / 100 % 60, nCenti % 100,
		  pSource, Message);
	GkSimLogLine (Line);

	if (Severity == LogPanic)
	{
		halt ();
	}
}

// --- random -------------------------------------------------------------------

u32 CBcmRandomNumberGenerator::GetNumber (void)
{
	u32 n;
	while (getentropy (&n, sizeof n) != 0)
	{
	}
	return n;
}

// --- devices ------------------------------------------------------------------

static CUSBKeyboardDevice s_Keyboard;

CUSBKeyboardDevice *GkSimKeyboard (void)
{
	return &s_Keyboard;
}

CDeviceNameService *CDeviceNameService::Get (void)
{
	static CDeviceNameService s_Service;
	return &s_Service;
}

CDevice *CDeviceNameService::GetDevice (const char *pName, boolean bBlockDevice)
{
	(void) bBlockDevice;
	return strcmp (pName, "ukbd1") == 0 ? &s_Keyboard : 0;
}

// --- halt ---------------------------------------------------------------------

void halt (void)
{
	GkSimLogLine ("(system halted)");
	GkSimHalted ();
	exit (3);
}

// QuickJS's time (sim/Makefile renames its calls): GapKeep's clock, as on
// the device, rather than the host's.
extern "C" int gk_gettimeofday (struct timeval *tv, void *tz)
{
	(void) tz;
	unsigned sec, usec;
	gk_time_now (&sec, &usec);
	tv->tv_sec = sec;
	tv->tv_usec = usec;
	return 0;
}

extern "C" struct tm *gk_localtime_r (const time_t *t, struct tm *tm)
{
	long nOffset = (long) gk_utc_offset_minutes () * 60;
	time_t nLocal = *t + nOffset;
	gmtime_r (&nLocal, tm);
	tm->tm_gmtoff = nOffset;
	return tm;
}
