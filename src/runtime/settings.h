//
// settings.h
//
// The card's gapkeep.txt: "key = value" lines, read once at boot while the
// card is mounted (appstore.cpp), "#" comments, spaces ignored. Sealed
// builds don't read the card, so they have none of these.
//
//   clock_trim_ppm = <ppm>      the clock's (clock.h, docs/CLOCK.md)
//   utc_offset = [+-]HH:MM
//   keyboard = us | br-abnt2    the keyboard layout (keylayout.h)
//   experimental = yes | no     experimental features (docs/EXPERIMENTAL.md):
//                               the scanner's "qr-color" detector and the
//                               apps whose manifest says "experimental"
//   language = pt-BR            the language, and the marks numbers are
//   decimal_mark = ,            written with, if not the language's own
//   group_mark = .              (i18n.h, docs/DESIGN.md)
//
// What it takes and what it refuses is logged, never silently ignored.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _settings_h
#define _settings_h

#include <circle/types.h>

class CGkSettings
{
public:
	static void Load (void);	// from the mounted card, if there is one

	static boolean IsExperimental (void)	{ return s_bExperimental; }
	// pFrom: where the setting comes from, for the log
	static void SetExperimental (boolean bOn, const char *pFrom);

private:
	static boolean s_bExperimental;
};

#endif
