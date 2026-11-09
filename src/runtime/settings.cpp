//
// settings.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "settings.h"
#include "clock.h"
#include "i18n.h"
#include "keylayout.h"
#include <circle/logger.h>
#include <circle/util.h>
#ifndef GK_SEALED
#include <ff.h>
#endif

static const char From[] = "settings";

boolean CGkSettings::s_bExperimental = FALSE;

void CGkSettings::SetExperimental (boolean bOn, const char *pFrom)
{
	s_bExperimental = bOn;
	CLogger::Get ()->Write (From, bOn ? LogWarning : LogNotice, "experimental features %s (%s)",
				bOn ? "on" : "off", pFrom);
}

void CGkSettings::Load (void)
{
#ifndef GK_SEALED
	FIL File;
	if (f_open (&File, "SD:/zerogap.txt", FA_READ) != FR_OK)
	{
		return;
	}

	static char Text[4096];
	UINT nRead = 0;
	FRESULT Result = f_read (&File, Text, sizeof Text - 1, &nRead);
	char Extra;
	UINT nExtra = 0;
	boolean bWhole = Result == FR_OK && f_read (&File, &Extra, 1, &nExtra) == FR_OK && nExtra == 0;
	f_close (&File);
	if (Result != FR_OK || !bWhole)
	{
		CLogger::Get ()->Write (From, LogWarning, "zerogap.txt: unreadable or larger than %u bytes",
					(unsigned) sizeof Text - 1);
		return;
	}
	Text[nRead] = '\0';

	unsigned nLine = 0;
	for (char *pLine = Text; pLine != 0 && *pLine != '\0'; )
	{
		nLine++;
		char *pNext = strchr (pLine, '\n');
		if (pNext != 0)
		{
			*pNext++ = '\0';
		}

		// strip spaces, CR and a comment
		char Clean[128];
		unsigned n = 0;
		for (char *p = pLine; *p != '\0' && *p != '#'; p++)
		{
			if (*p != ' ' && *p != '\t' && *p != '\r' && n < sizeof Clean - 1)
			{
				Clean[n++] = *p;
			}
		}
		Clean[n] = '\0';
		pLine = pNext;
		if (n == 0)
		{
			continue;
		}

		char *pValue = strchr (Clean, '=');
		if (pValue == 0)
		{
			CLogger::Get ()->Write (From, LogWarning, "zerogap.txt:%u: \"key = value\" expected", nLine);
			continue;
		}
		*pValue++ = '\0';

		if (CGkClock::Configure (Clean, pValue, nLine))
		{
			continue;
		}
		if (CGkI18n::Configure (Clean, pValue, nLine))	// language, decimal_mark, group_mark
		{
			continue;
		}
		if (GkKeyLayoutConfigure (Clean, pValue, nLine))
		{
			continue;
		}
		if (strcmp (Clean, "experimental") == 0)
		{
			if (strcmp (pValue, "yes") == 0 || strcmp (pValue, "no") == 0)
			{
				SetExperimental (strcmp (pValue, "yes") == 0, "zerogap.txt");
			}
			else
			{
				CLogger::Get ()->Write (From, LogWarning,
					"zerogap.txt:%u: experimental: yes or no expected", nLine);
			}
			continue;
		}
		CLogger::Get ()->Write (From, LogWarning, "zerogap.txt:%u: unknown key \"%s\"", nLine, Clean);
	}
#endif
}
