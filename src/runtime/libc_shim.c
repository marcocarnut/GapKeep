/*
 * libc_shim.c - the few hosted C library functions QuickJS needs that
 * neither Circle, newlib's libm nor libgcc provide.
 *
 * Kept deliberately tiny so it can be audited at a glance. The C++ side
 * (logging, clock) is reached through zg_bridge.h.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* newlib exposes struct tm's GMT offset only under this name */
#define __TM_GMTOFF tm_gmtoff
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include "zg_bridge.h"

/* LVGL's built-in printf (LV_USE_STDLIB_SPRINTF = LV_STDLIB_BUILTIN). It
 * supports everything QuickJS formats (%d %u %x %s %.*s, ll modifiers).
 * Must not be switched to LV_STDLIB_CLIB, or vsnprintf would recurse. */
int lv_vsnprintf (char *buffer, size_t count, const char *format, va_list va);

int vsnprintf (char *buf, size_t size, const char *fmt, va_list ap)
{
	return lv_vsnprintf (buf, size, fmt, ap);
}

int snprintf (char *buf, size_t size, const char *fmt, ...)
{
	va_list ap;
	va_start (ap, fmt);
	int n = lv_vsnprintf (buf, size, fmt, ap);
	va_end (ap);
	return n;
}

/* stdio: QuickJS only writes diagnostics (memory dumps, fatal errors). All
 * streams go to the system log, one line at a time. */
static char s_line[256];
static size_t s_len;

static void put_char (char c)
{
	if (c == '\n' || s_len == sizeof s_line - 1)
	{
		s_line[s_len] = '\0';
		zg_log_line ("qjs", s_line);
		s_len = 0;
		if (c == '\n')
			return;
	}
	s_line[s_len++] = c;
}

int fputc (int c, FILE *stream)
{
	(void) stream;
	put_char ((char) c);
	return (unsigned char) c;
}

size_t fwrite (const void *ptr, size_t size, size_t nmemb, FILE *stream)
{
	(void) stream;
	const char *p = ptr;
	for (size_t i = 0; i < size * nmemb; i++)
		put_char (p[i]);
	return nmemb;
}

int fprintf (FILE *stream, const char *fmt, ...)
{
	char buf[256];
	va_list ap;
	va_start (ap, fmt);
	int n = lv_vsnprintf (buf, sizeof buf, fmt, ap);
	va_end (ap);
	fwrite (buf, 1, strlen (buf), stream);
	return n;
}

void abort (void)
{
	zg_fatal ("abort() called");
}

int abs (int x)
{
	return x < 0 ? -x : x;
}

long labs (long x)		/* used by LVGL's QR code encoder */
{
	return x < 0 ? -x : x;
}

void *memchr (const void *s, int c, size_t n)
{
	const unsigned char *p = s;
	for (; n > 0; n--, p++)
		if (*p == (unsigned char) c)
			return (void *) p;
	return NULL;
}

char *strrchr (const char *s, int c)
{
	const char *last = NULL;
	do
	{
		if (*s == (char) c)
			last = s;
	}
	while (*s++);
	return (char *) last;
}

/* Circle's allocator does not expose block sizes. QuickJS only uses this
 * for memory accounting, and documents 0 as acceptable. */
size_t malloc_usable_size (void *ptr)
{
	(void) ptr;
	return 0;
}

/* Time: zerogap's clock (clock.cpp). A Pi Zero has no real-time clock and
 * zerogap has no network, so it counts from the Unix epoch at boot until
 * the clock app sets it. */
int gettimeofday (struct timeval *tv, void *tz)
{
	(void) tz;
	unsigned sec, usec;
	zg_time_now (&sec, &usec);
	tv->tv_sec = sec;
	tv->tv_usec = usec;
	return 0;
}

int clock_gettime (int clock_id, struct timespec *tp)
{
	(void) clock_id;
	unsigned sec, usec;
	zg_time_now (&sec, &usec);
	tp->tv_sec = sec;
	tp->tv_nsec = (long) usec * 1000;
	return 0;
}

/* Local time: UTC plus the clock's fixed offset (no time zone database, no
 * daylight saving rules). */
struct tm *localtime_r (const time_t *t, struct tm *tm)
{
	long nOffset = (long) zg_utc_offset_minutes () * 60;
	long long secs = *t + nOffset;
	long long days = secs / 86400;
	long rem = (long) (secs % 86400);
	if (rem < 0)
	{
		rem += 86400;
		days--;
	}
	tm->tm_hour = rem / 3600;
	tm->tm_min = (rem % 3600) / 60;
	tm->tm_sec = rem % 60;
	tm->tm_wday = (int) ((days + 4) % 7 + 7) % 7;	/* 1970-01-01 was a Thursday */

	/* civil-from-days, Howard Hinnant's algorithm */
	long long z = days + 719468;
	long long era = (z >= 0 ? z : z - 146096) / 146097;
	unsigned doe = (unsigned) (z - era * 146097);
	unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	long long y = (long long) yoe + era * 400;
	unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	unsigned mp = (5 * doy + 2) / 153;
	unsigned d = doy - (153 * mp + 2) / 5 + 1;
	unsigned m = mp < 10 ? mp + 3 : mp - 9;
	y += m <= 2;

	tm->tm_year = (int) (y - 1900);
	tm->tm_mon = (int) m - 1;
	tm->tm_mday = (int) d;
	int leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
	static const short cum[12] = {0,31,59,90,120,151,181,212,243,273,304,334};
	tm->tm_yday = cum[m - 1] + (int) d - 1 + (leap && m > 2);
	tm->tm_isdst = 0;
	tm->tm_gmtoff = nOffset;
	return tm;
}
