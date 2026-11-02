/*
 * bundle.h - apps compiled into the kernel image.
 *
 * zerogap has no writable storage for code: every app is bundled into the
 * kernel image at build time by tools/bundle_apps.py, which also validates
 * each app's manifest.json. The generated table lives in
 * src/generated/apps_bundle.c.
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
	const char *icon;		/* UTF-8 symbol (resolved from the manifest) */
	const char *entry;		/* path of the entry module */
	unsigned permissions;		/* ZG_PERM_* */
	int hidden;			/* not listed in the launcher */
	const zg_file_t *files;
	unsigned file_count;
}
zg_app_t;

extern const zg_app_t zg_apps[];
extern const unsigned zg_app_count;

#ifdef __cplusplus
}
#endif

#endif
