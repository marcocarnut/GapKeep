// Stand-in for Circle's timer: microsecond ticks since start.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_timer_h
#define _circle_timer_h
#include <circle/types.h>
#define CLOCKHZ	1000000
#define HZ	100
class CTimer
{
public:
	static CTimer *Get (void);
	static unsigned GetClockTicks (void);
	static u64 GetClockTicks64 (void);
	unsigned GetTicks (void) const;
	unsigned GetUptime (void) const;
	boolean GetUptime (unsigned *pSeconds, unsigned *pMicroSeconds);
	boolean GetUniversalTime (unsigned *pSeconds, unsigned *pMicroSeconds);
	static void SimpleMsDelay (unsigned nMilliSeconds);
	static void SimpleusDelay (unsigned nMicroSeconds);
};
#endif
