//
// clock.h
//
// The wall clock, kept by the kernel whatever app runs. A Pi Zero has no
// real-time clock (and zerogap no network), so the time is lost at every
// power-off: until an app with the "rtc" permission sets it, the clock
// counts from the Unix epoch at boot, as before. Set, it counts UTC from
// the system timer, corrected by a trim for its crystal's error.
//
// The trim (parts per million, + makes the clock run faster) and the UTC
// offset of local time come from the card's zerogap.txt at boot (see
// docs/CLOCK.md), and can be changed while running. The card is never
// written: the clock app shows the line to copy there.
//
// Each Set() after the first also measures the clock against the time
// given: over hours, that is the crystal's error, and the trim that would
// cancel it (GetDrift).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _clock_h
#define _clock_h

#include <circle/types.h>

struct TZgDrift
{
	boolean bValid;			// measured at the last Set()
	double fCorrection;		// seconds the clock was off (+: it was fast)
	double fOver;			// over this many seconds since the Set() before
	double fTrim;			// ppm: the trim that would have kept it right
	double fUncertainty;		// ppm: from half a second's error in each Set()
};

class CZgClock
{
public:
	static const int MaxTrim = 500;			// ppm, either way
	static const int MinUtcOffset = -12 * 60;	// minutes
	static const int MaxUtcOffset = 14 * 60;

	// Microseconds since 1970-01-01 00:00 UTC (since boot if not set).
	static s64 Now (void);
	static boolean IsSet (void)			{ return s_bSet; }

	// To nUnixMicros. Measures the drift if it was set before.
	static void Set (s64 nUnixMicros);

	static double GetTrim (void)			{ return s_fTrim; }
	static boolean SetTrim (double fPPM);		// FALSE: out of range

	static int GetUtcOffset (void)			{ return s_nUtcOffset; }
	static boolean SetUtcOffset (int nMinutes);	// FALSE: out of range

	static const TZgDrift *GetDrift (void)		{ return &s_Drift; }

	// Bumped by every change (time, trim, offset): alarms reschedule.
	static unsigned GetSerial (void)		{ return s_nSerial; }

	// A setting from the card's zerogap.txt (settings.h): "clock_trim_ppm =
	// <ppm>" or "utc_offset = [+-]HH:MM". FALSE: not a clock setting. Logs
	// what it takes and what it refuses.
	static boolean Configure (const char *pKey, const char *pValue, unsigned nLine);

private:
	static void Rebase (void);

private:
	static boolean s_bSet;
	static s64 s_nBase;			// µs since the epoch at s_nBaseTicks
	static u64 s_nBaseTicks;		// timer ticks (1 MHz)
	static double s_fTrim;
	static int s_nUtcOffset;
	static unsigned s_nSerial;

	static s64 s_nLastSet;			// the last Set()'s time ...
	static u64 s_nLastSetTicks;		// ... and the timer then
	static TZgDrift s_Drift;
};

#ifdef __cplusplus
extern "C" {
#endif
// for the C library (libc_shim.c, the simulator's): UTC now, and the
// offset of local time in minutes
void zg_time_now (unsigned *sec, unsigned *usec);
int zg_utc_offset_minutes (void);
#ifdef __cplusplus
}
#endif

#endif
