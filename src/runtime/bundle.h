/*
 * bundle.h - the description of an app, and the apps built into the kernel.
 *
 * Apps come from two places: built into the kernel image at build time by
 * tools/bundle_apps.py (src/generated/apps_bundle.c), or loaded from the SD
 * card's /apps folder at boot (appstore.cpp). Both check manifest.json the
 * same way and describe the app with a zg_app_t; CAppStore lists them all.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_BUNDLE_H
#define ZG_BUNDLE_H

#ifdef __cplusplus
extern "C" {
#endif

/* permission bits, granted by "permissions" in manifest.json */
#define ZG_PERM_APPS	(1u << 0)	/* zg:apps - list and launch other apps */

typedef struct
{
	const char *path;		/* relative to the app directory, e.g. "main.js" */
	const char *data;		/* NUL-terminated */
	unsigned size;			/* without the NUL */
}
zg_file_t;

typedef struct
{
	const char *id;			/* unique, [a-z0-9-]+ */
	const char *name;		/* shown in the launcher */
	const char *version;
	const char *description;
	const char *icon;		/* UTF-8 symbol (resolved from the manifest; "file" if
					   the manifest gives a picture) */
	const char *entry;		/* path of the entry module */
	unsigned permissions;		/* ZG_PERM_* */
	int hidden;			/* not listed in the launcher */
	const zg_file_t *files;		/* sorted by path */
	unsigned file_count;
	const char *hash;		/* SHA-256 of the files, 64 hex digits (docs/APPS.md) */
	int source;			/* ZG_APP_BUILTIN or ZG_APP_SDCARD */
	const unsigned char *icon_rgba;	/* picture icon (manifest "icon": { width, height,
					   rgba }): width * height * 4 bytes, or 0 */
	unsigned icon_width, icon_height;
}
zg_app_t;

#define ZG_APP_BUILTIN	0
#define ZG_APP_SDCARD	1

/* picture icons: 1 to ZG_ICON_MAX_SIDE px wide and high */
#define ZG_ICON_MAX_SIDE	128

extern const zg_app_t zg_builtin_apps[];
extern const unsigned zg_builtin_app_count;

#ifdef __cplusplus
}
#endif

#endif
