/*
 * bundle.h - the description of an app, and the apps built into the kernel.
 *
 * Apps come from two places: built into the kernel image at build time by
 * tools/bundle_apps.py (src/generated/apps_bundle.c), or loaded from the SD
 * card's /apps folder at boot (appstore.cpp). Both check manifest.json the
 * same way and describe the app with a gk_app_t; CAppStore lists them all.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_BUNDLE_H
#define GK_BUNDLE_H

#ifdef __cplusplus
extern "C" {
#endif

/* at most this many data folders per app (manifest "data") */
#define GK_MAX_APP_DATA	8

/* at most this many USB devices per app (manifest "usb": "vvvv:pppp" ids) */
#define GK_MAX_APP_USB	8

/* permission bits, granted by "permissions" in manifest.json */
#define GK_PERM_APPS	(1u << 0)	/* gk:apps - list and launch other apps */
#define GK_PERM_RTC	(1u << 2)	/* gk:clock's set, setTrim, setUtcOffset */
#define GK_PERM_CAMERA	(1u << 1)	/* ui.Scanner - the camera, for QR codes and such */
#define GK_PERM_SETTINGS (1u << 3)	/* gk:i18n's setLanguage, setMarks, setKeyboard */
#define GK_PERM_EPAPER	(1u << 4)	/* ui.epaper - write to an e-paper panel (docs/EPAPER.md) */

typedef struct
{
	const char *path;		/* relative to the app directory, e.g. "main.js" */
	const char *data;		/* NUL-terminated */
	unsigned size;			/* without the NUL */
}
gk_file_t;

typedef struct
{
	const char *id;			/* unique, [a-z0-9-]+ */
	const char *name;		/* shown in the launcher */
	const char *version;
	const char *description;
	const char *icon;		/* UTF-8 symbol (resolved from the manifest; "file" if
					   the manifest gives a picture) */
	const char *entry;		/* path of the entry module */
	unsigned permissions;		/* GK_PERM_* */
	int hidden;			/* not listed in the launcher */
	int experimental;		/* only with "experimental = yes" (settings.h) */
	const gk_file_t *files;		/* sorted by path */
	unsigned file_count;
	const char *hash;		/* SHA-256 of the files, 64 hex digits (docs/APPS.md) */
	int source;			/* GK_APP_BUILTIN or GK_APP_SDCARD */
	const unsigned char *icon_rgba;	/* picture icon (manifest "icon": { width, height,
					   rgba }): width * height * 4 bytes, or 0 */
	unsigned icon_width, icon_height;
	const char *const *data;	/* manifest "data": the data folders (data/<name>) the
					   app may read with gk:data; data_count names */
	unsigned data_count;
	const char *suite;		/* the suite's id (apps/<suite>/<id>), or 0 */
	const unsigned *usb;		/* manifest "usb": the USB devices it may use with
					   gk:usb, vid << 16 | pid; usb_count of them */
	unsigned usb_count;
}
gk_app_t;

/* A suite (docs/APPS.md, "Suites"), apps/<id>/suite.json, is described with
   a gk_app_t too: id, name, description, icon (and icon_rgba), and files
   (suite.json and lang/<tag>.json, for its translated name); the rest is 0. */

#define GK_APP_BUILTIN	0
#define GK_APP_SDCARD	1

/* picture icons: 1 to GK_ICON_MAX_SIDE px wide and high */
#define GK_ICON_MAX_SIDE	128

extern const gk_app_t gk_builtin_apps[];
extern const unsigned gk_builtin_app_count;

/* A data folder built into the kernel image (sealed builds: make SEALED=1
   DATA=dir, docs/APPS.md, "Data files"), served by gk:data as one read from
   the card's data/<name> would be. */
typedef struct
{
	const char *name;		/* the folder's name, an id */
	const gk_file_t *files;		/* sorted by path; binary (each still NUL-terminated) */
	unsigned file_count;
	unsigned size;			/* all files */
	const char *hash;		/* as tools/bundle_apps.py --data-hash computes it */
}
gk_data_t;

extern const gk_data_t gk_builtin_data[];
extern const unsigned gk_builtin_data_count;

#ifdef __cplusplus
}
#endif

#endif
