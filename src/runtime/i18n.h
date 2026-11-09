//
// i18n.h
//
// Languages (docs/plans/I18N.md): the system's language and number marks,
// and each app's catalog of translations, apps/<id>/lang/<language>.json.
//
// The language is "en" (English, the text in the code), "qps" (a
// pseudo-language for testing, i18n.js) or one the launcher has a catalog
// for (apps/launcher/lang/<tag>.json: the launcher holds the system's own
// text). It comes from the build (make LANGUAGE=pt-BR, the only way for
// sealed builds), then gapkeep.txt ("language = pt-BR"), and can be
// changed while running, until reboot, by an app with the "settings"
// permission (gk:i18n's setLanguage).
//
// A catalog is data: parsed with JSON.parse (QuickJS's JS_ParseJSON), never
// evaluated, at most 256 KB, and each translation is checked before it is
// used: same {names} as its key, no control or bidi characters. A
// translation that fails is logged and the English shown instead. LVGL's
// recolor ("#ff0000 red#") is never on for gk:ui's labels, so a "#" in a
// translation is just a "#".
//
// The JavaScript side is src/runtime/i18n.js (the module "gk:i18n"); the
// functions it needs are the module "gk:i18n-native", which only it may
// import.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _i18n_h
#define _i18n_h

#include <circle/types.h>
#include "keylayout.h"

extern "C" {
#include <quickjs.h>
}

struct TGkApp;
#include "bundle.h"

class CGkI18n
{
public:
	// After the built-in apps are registered, before gapkeep.txt: the
	// build's language (make LANGUAGE=..., default English)
	static void Initialize (void);

	// A gapkeep.txt line: TRUE if the key is one of ours ("language",
	// "decimal_mark", "group_mark"); problems are logged
	static boolean Configure (const char *pKey, const char *pValue, unsigned nLine);

	// FALSE (and logged) if the system has no such language. pFrom: where
	// the change comes from, for the log
	static boolean SetLanguage (const char *pTag, const char *pFrom);
	static const char *GetLanguage (void)	{ return s_Language; }

	// The marks numbers are written with: the language's, or those set
	// (gapkeep.txt, setMarks). 0: the language's own. FALSE if refused.
	static boolean SetMarks (const char *pDecimal, const char *pGroup, const char *pFrom);
	static const char *GetDecimal (void)	{ return s_Decimal; }
	static const char *GetGroup (void)	{ return s_Group; }

	// The keyboard layout: keylayout.h's, which also lists the layouts and
	// switches them (GkKeyLayouts, GkKeyLayoutSet)
	static const char *GetKeyboard (void)	{ return GkKeyLayoutGet (); }

	// The app's catalog, at its start and when the language changes;
	// returns the time it took, in microseconds
	static unsigned LoadCatalog (TGkApp *pApp);
	static void FreeApp (TGkApp *pApp);

	// An app's name or description in the language: the manifest's English
	// is the key in the app's own catalog, checked as any translation.
	// Cached until the language changes (a catalog is parsed once for both).
	static const char *GetAppName (JSContext *pContext, const gk_app_t *pApp);
	static const char *GetAppDescription (JSContext *pContext, const gk_app_t *pApp);

private:
	static boolean IsKnown (const char *pTag);
	static void ResolveMarks (void);

	static char s_Language[16];
	static char s_Decimal[4], s_Group[4];
	static char s_SetDecimal[4], s_SetGroup[4];	// "": the language's
	static boolean s_bDecimalSet, s_bGroupSet;
};

JSModuleDef *GkInitI18nModule (JSContext *pContext, const char *pName);		// "gk:i18n"
JSModuleDef *GkInitI18nNativeModule (JSContext *pContext, const char *pName);	// "gk:i18n-native"

#endif
