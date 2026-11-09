//
// gk_bridge.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "gk_bridge.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/startup.h>

void gk_log_line (const char *source, const char *line)
{
	CLogger::Get ()->Write (source, LogNotice, "%s", line);
}

void gk_fatal (const char *message)
{
	CLogger::Get ()->Write ("gapkeep", LogPanic, "%s", message);	// LogPanic halts
	halt ();
}
