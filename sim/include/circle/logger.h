// Stand-in for Circle's logger: lines go to stdout as Circle formats them
// ("00:00:02.90 apphost: Starting dice39 0.1.0"), so the same tests match.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_logger_h
#define _circle_logger_h
#include <stdarg.h>
enum TLogSeverity
{
	LogPanic, LogError, LogWarning, LogNotice, LogDebug, LogTrace
};
class CLogger
{
public:
	static CLogger *Get (void);
	void Write (const char *pSource, TLogSeverity Severity, const char *pMessage, ...)
		__attribute__ ((format (printf, 4, 5)));
	void WriteV (const char *pSource, TLogSeverity Severity, const char *pMessage, va_list Args);
};
#endif
