//
// clock.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "clock.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>
#include <stdlib.h>

static const char From[] = "clock";

boolean CGkClock::s_bSet = FALSE;
s64 CGkClock::s_nBase = 0;
u64 CGkClock::s_nBaseTicks = 0;
double CGkClock::s_fTrim = 0;
int CGkClock::s_nUtcOffset = 0;
unsigned CGkClock::s_nSerial = 0;
s64 CGkClock::s_nLastSet = 0;
u64 CGkClock::s_nLastSetTicks = 0;
TGkDrift CGkClock::s_Drift = {FALSE, 0, 0, 0, 0};

// Below this, a measured drift says more about the hand that set the time
// than about the crystal: setting it by hand is right to about half a
// second, so two settings an hour apart measure the rate to ±278 ppm, a
// day apart to ±12 ppm, a week apart to ±1.7 ppm.
static const double MinDriftSeconds = 3600;
static const double SettingError = 0.5;		// s, each setting

s64 CGkClock::Now (void)
{
	u64 nElapsed = CTimer::GetClockTicks64 () - s_nBaseTicks;	// µs (CLOCKHZ = 1 MHz)
	return s_nBase + (s64) nElapsed + (s64) ((double) nElapsed * s_fTrim * 1e-6);
}

// The time so far becomes the base: what follows is counted with the
// current trim (so a new trim never makes the time jump).
void CGkClock::Rebase (void)
{
	s64 nNow = Now ();
	s_nBaseTicks = CTimer::GetClockTicks64 ();
	s_nBase = nNow;
}

void CGkClock::Set (s64 nUnixMicros)
{
	u64 nTicks = CTimer::GetClockTicks64 ();

	s_Drift.bValid = FALSE;
	if (s_bSet)
	{
		// how far the clock was off, and what the timer did meanwhile
		double fTrue = (double) (nUnixMicros - s_nLastSet) * 1e-6;	// s
		double fRaw = (double) (nTicks - s_nLastSetTicks) * 1e-6;	// s, untrimmed
		s64 nWas = Now ();
		if (fTrue >= MinDriftSeconds && fRaw > 0)
		{
			s_Drift.bValid = TRUE;
			s_Drift.fCorrection = (double) (nWas - nUnixMicros) * 1e-6;
			s_Drift.fOver = fTrue;
			s_Drift.fTrim = (fTrue / fRaw - 1) * 1e6;
			s_Drift.fUncertainty = 2 * SettingError / fTrue * 1e6;
		}
	}

	s_nBase = nUnixMicros;
	s_nBaseTicks = nTicks;
	s_nLastSet = nUnixMicros;
	s_nLastSetTicks = nTicks;
	s_bSet = TRUE;
	s_nSerial++;

	CLogger::Get ()->Write (From, LogNotice, "set%s", s_Drift.bValid ? "; drift measured" : "");
}

boolean CGkClock::SetTrim (double fPPM)
{
	if (!(fPPM >= -MaxTrim && fPPM <= MaxTrim))	// also NaN
	{
		return FALSE;
	}

	Rebase ();
	s_fTrim = fPPM;
	s_nSerial++;

	int nMilli = (int) (fPPM * 1000 + (fPPM < 0 ? -0.5 : 0.5));
	int nAbs = nMilli < 0 ? -nMilli : nMilli;
	CLogger::Get ()->Write (From, LogNotice, "trim %s%d.%03d ppm",
				nMilli < 0 ? "-" : "", nAbs / 1000, nAbs % 1000);
	return TRUE;
}

boolean CGkClock::SetUtcOffset (int nMinutes)
{
	if (nMinutes < MinUtcOffset || nMinutes > MaxUtcOffset)
	{
		return FALSE;
	}

	s_nUtcOffset = nMinutes;
	s_nSerial++;

	int nAbs = nMinutes < 0 ? -nMinutes : nMinutes;
	CLogger::Get ()->Write (From, LogNotice, "UTC offset %c%02d:%02d",
				nMinutes < 0 ? '-' : '+', nAbs / 60, nAbs % 60);
	return TRUE;
}

// --- gapkeep.txt --------------------------------------------------------------

// "[+-]HH:MM" -> minutes. FALSE if malformed.
static boolean ParseOffset (const char *p, int *pMinutes)
{
	int nSign = 1;
	if (*p == '+' || *p == '-')
	{
		nSign = *p++ == '-' ? -1 : 1;
	}
	if (   p[0] < '0' || p[0] > '9' || p[1] < '0' || p[1] > '9' || p[2] != ':'
	    || p[3] < '0' || p[3] > '5' || p[4] < '0' || p[4] > '9' || p[5] != '\0')
	{
		return FALSE;
	}
	*pMinutes = nSign * (((p[0] - '0') * 10 + (p[1] - '0')) * 60 + (p[3] - '0') * 10 + (p[4] - '0'));
	return TRUE;
}

// A decimal number, optionally signed, with at most 3 decimals: no
// exponents, no hex, nothing else on the line. FALSE if malformed.
static boolean ParseDecimal (const char *p, double *pValue)
{
	boolean bNegative = FALSE;
	if (*p == '+' || *p == '-')
	{
		bNegative = *p++ == '-';
	}
	long nWhole = 0, nFraction = 0, nScale = 1;
	unsigned nDigits = 0, nDecimals = 0;
	for (; *p >= '0' && *p <= '9' && nDigits < 6; p++, nDigits++)
	{
		nWhole = nWhole * 10 + (*p - '0');
	}
	if (*p == '.')
	{
		for (p++; *p >= '0' && *p <= '9' && nDecimals < 3; p++, nDecimals++)
		{
			nFraction = nFraction * 10 + (*p - '0');
			nScale *= 10;
		}
	}
	if (nDigits == 0 || *p != '\0')
	{
		return FALSE;
	}
	double f = nWhole + (double) nFraction / nScale;
	*pValue = bNegative ? -f : f;
	return TRUE;
}

// A clock setting from gapkeep.txt (settings.cpp): FALSE if the key is not
// the clock's. Logs what it refuses.
boolean CGkClock::Configure (const char *pKey, const char *pValue, unsigned nLine)
{
	double fTrim;
	int nOffset;
	if (strcmp (pKey, "clock_trim_ppm") == 0)
	{
		if (!ParseDecimal (pValue, &fTrim) || !SetTrim (fTrim))
		{
			CLogger::Get ()->Write (From, LogWarning,
				"gapkeep.txt:%u: clock_trim_ppm: a number from -%d to %d expected",
				nLine, MaxTrim, MaxTrim);
		}
		return TRUE;
	}
	if (strcmp (pKey, "utc_offset") == 0)
	{
		if (!ParseOffset (pValue, &nOffset) || !SetUtcOffset (nOffset))
		{
			CLogger::Get ()->Write (From, LogWarning,
				"gapkeep.txt:%u: utc_offset: -12:00 to +14:00 expected", nLine);
		}
		return TRUE;
	}
	return FALSE;
}

// --- for the C library ----------------------------------------------------------

void gk_time_now (unsigned *sec, unsigned *usec)
{
	s64 nNow = CGkClock::Now ();
	if (nNow < 0)
	{
		nNow = 0;
	}
	*sec = (unsigned) (nNow / 1000000);
	*usec = (unsigned) (nNow % 1000000);
}

int gk_utc_offset_minutes (void)
{
	return CGkClock::GetUtcOffset ();
}
