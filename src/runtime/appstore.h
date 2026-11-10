//
// appstore.h
//
// The list of apps: those built into the kernel image (bundle.h), followed
// by those found in the SD card's /apps folder at boot; and the card's data
// folders (/data/<name>, read by apps through gk:data).
//
// SD card apps are laid out exactly like apps/ in the repository: one
// folder per app, named after its id, with a manifest.json. They are read
// once, at boot, into memory, checked like tools/bundle_apps.py checks the
// built-in ones, and hashed (docs/APPS.md, "App hashes"). The card is never
// written: FatFs is compiled read-only (lib/fatfs/ffconf.h).
//
// A folder in /apps with a suite.json instead of a manifest.json is a
// suite (docs/APPS.md, "Suites"): a group of apps the launcher shows as one
// tile, apps/<suite>/<app>/. Each of its apps is an app like any other,
// with its own hash; the suite only gives them a name and an icon.
//
// An app whose id is already taken (by a built-in app, in particular the
// launcher, by an app loaded before it, or by a suite) is not loaded.
// Neither is an app that fails a check; each such problem is kept, for the
// launcher to show.
//
// Data folders (docs/APPS.md, "Data files") are read on first use, all
// their files at once, and kept in memory until power-off: what an app
// reads is always what was hashed, even if the card were swapped while
// running. They are not part of any app's hash.
//
// Sealed builds (make SEALED=1) have every app built in and no SD card
// code at all: no suites and no data folders.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _appstore_h
#define _appstore_h

#include <circle/types.h>
#include "bundle.h"

enum TGkCardStatus
{
	GkCardDisabled,		// sealed build: the card is not read
	GkCardNone,		// no card, or the card did not initialize
	GkCardUnreadable,	// no FAT file system
	GkCardNoApps,		// no /apps folder
	GkCardOK		// /apps was read (see the problems for apps not loaded)
};

enum TGkDataStatus
{
	GkDataOK,		// the folder was read
	GkDataMissing,		// no such folder (or no card, or a sealed build)
	GkDataError		// it could not be read: see the error
};

class CAppStore
{
public:
	// Registers the built-in apps, then loads /apps from the SD card if
	// bCardPresent (the card's device "emmc1" was initialized).
	static void Initialize (boolean bCardPresent);

	static unsigned GetCount (void);
	static const gk_app_t *Get (unsigned nIndex);
	static const gk_app_t *Find (const char *pID);
	// FALSE for an experimental app without "experimental = yes" (settings.h):
	// not listed, not launched
	static boolean IsAvailable (const gk_app_t *pApp);

	// suites (apps/<id>/suite.json), in the order of their folders
	static unsigned GetSuiteCount (void);
	static const gk_app_t *GetSuite (unsigned nIndex);
	static const gk_app_t *FindSuite (const char *pID);

	static TGkCardStatus GetCardStatus (void);
	static const char *GetCardStatusName (void);	// "none", "ok", ...

	// apps in /apps that were not loaded
	static unsigned GetProblemCount (void);
	static const char *GetProblemFolder (unsigned nIndex);
	static const char *GetProblemText (unsigned nIndex);

	// The data folder /data/<pName> (pName: a valid id): its files, sorted
	// by path (binary, each NUL-terminated after its size), and their hash
	// (64 hex digits, the app hash's scheme). Read on the first call, then
	// kept. GkDataError: *ppError says why. Access is checked by the caller
	// (gk:data: the app's manifest; gk:apps: the "apps" permission).
	static TGkDataStatus GetData (const char *pName, const gk_file_t **ppFiles, unsigned *pCount,
				      const char **ppHash, const char **ppError);

	// ^[a-z0-9][a-z0-9-]{0,31}$: app, suite and data folder names
	static boolean IsValidID (const char *pID);
	// strict UTF-8 without NUL (as Python's bytes.decode('utf-8'))
	static boolean IsValidUTF8 (const u8 *pData, unsigned nSize);
};

#endif
