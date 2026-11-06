//
// appstore.h
//
// The list of apps: those built into the kernel image (bundle.h), followed
// by those found in the SD card's /apps folder at boot.
//
// SD card apps are laid out exactly like apps/ in the repository: one
// folder per app, named after its id, with a manifest.json. They are read
// once, at boot, into memory, checked like tools/bundle_apps.py checks the
// built-in ones, and hashed (docs/APPS.md, "App hashes"). The card is never
// written: FatFs is compiled read-only (lib/fatfs/ffconf.h).
//
// An app whose id is already taken (by a built-in app, in particular the
// launcher) is not loaded. Neither is an app that fails a check; each such
// problem is kept, for the launcher to show.
//
// Sealed builds (make SEALED=1) have every app built in and no SD card
// code at all.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _appstore_h
#define _appstore_h

#include <circle/types.h>
#include "bundle.h"

enum TZgCardStatus
{
	ZgCardDisabled,		// sealed build: the card is not read
	ZgCardNone,		// no card, or the card did not initialize
	ZgCardUnreadable,	// no FAT file system
	ZgCardNoApps,		// no /apps folder
	ZgCardOK		// /apps was read (see the problems for apps not loaded)
};

class CAppStore
{
public:
	// Registers the built-in apps, then loads /apps from the SD card if
	// bCardPresent (the card's device "emmc1" was initialized).
	static void Initialize (boolean bCardPresent);

	static unsigned GetCount (void);
	static const zg_app_t *Get (unsigned nIndex);
	static const zg_app_t *Find (const char *pID);
	// FALSE for an experimental app without "experimental = yes" (settings.h):
	// not listed, not launched
	static boolean IsAvailable (const zg_app_t *pApp);

	static TZgCardStatus GetCardStatus (void);
	static const char *GetCardStatusName (void);	// "none", "ok", ...

	// apps in /apps that were not loaded
	static unsigned GetProblemCount (void);
	static const char *GetProblemFolder (unsigned nIndex);
	static const char *GetProblemText (unsigned nIndex);
};

#endif
