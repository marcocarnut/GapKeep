//
// zg_bridge.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "zg_bridge.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/startup.h>

void zg_log_line (const char *source, const char *line)
{
	CLogger::Get ()->Write (source, LogNotice, "%s", line);
}

void zg_fatal (const char *message)
{
	CLogger::Get ()->Write ("zerogap", LogPanic, "%s", message);	// LogPanic halts
	halt ();
}
