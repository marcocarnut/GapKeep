//
// i18n.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "i18n.h"
#include "apphost.h"
#include "appstore.h"
#include "clock.h"
#include "markup.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/string.h>
#include <circle/util.h>
#include <assert.h>

static const char From[] = "i18n";

static const unsigned MaxCatalogSize = 256 * 1024;
static const unsigned MaxNames = 32;		// {names} in one message

#ifndef GK_LANGUAGE
#define GK_LANGUAGE "en"
#endif

// src/runtime/i18n.js, embedded by tools/embed_js.py
extern "C" const char gk_i18n_js[];
extern "C" const unsigned gk_i18n_js_size;

char CGkI18n::s_Language[16] = "en";
char CGkI18n::s_Decimal[4] = ".";
char CGkI18n::s_Group[4] = ",";
char CGkI18n::s_SetDecimal[4] = "";
char CGkI18n::s_SetGroup[4] = "";
boolean CGkI18n::s_bDecimalSet = FALSE;
boolean CGkI18n::s_bGroupSet = FALSE;

struct TGkI18nState
{
	JSValue Messages;	// the app's: a null-prototype object, or null
	JSValue System;		// the launcher's, once asked for (undefined until then)
};

// --- languages ----------------------------------------------------------------

// BCP 47 as we use it: "en", "pt-BR", "sr-Latn-RS"
static boolean IsTag (const char *p)
{
	size_t n = strlen (p);
	if (n < 2 || n > 15)
	{
		return FALSE;
	}
	unsigned nPart = 0, nLen = 0;
	for (; ; p++)
	{
		if (*p == '-' || *p == '\0')
		{
			if (nPart == 0 ? nLen < 2 || nLen > 3 : nLen < 2 || nLen > 8)
			{
				return FALSE;
			}
			if (*p == '\0')
			{
				return TRUE;
			}
			nPart++;
			nLen = 0;
		}
		else if (   (*p >= 'a' && *p <= 'z')
			 || (nPart > 0 && ((*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9'))))
		{
			nLen++;
		}
		else
		{
			return FALSE;
		}
	}
}

static const gk_file_t *FindFile (const gk_app_t *pApp, const char *pPath)
{
	for (unsigned i = 0; pApp != 0 && i < pApp->file_count; i++)
	{
		if (strcmp (pApp->files[i].path, pPath) == 0)
		{
			return &pApp->files[i];
		}
	}
	return 0;
}

static const gk_file_t *CatalogFile (const gk_app_t *pApp, const char *pTag)
{
	char Path[32];
	if (strlen (pTag) + 11 > sizeof Path)
	{
		return 0;
	}
	strcpy (Path, "lang/");
	strcat (Path, pTag);
	strcat (Path, ".json");
	return FindFile (pApp, Path);
}

boolean CGkI18n::IsKnown (const char *pTag)
{
	return    strcmp (pTag, "en") == 0
	       || strcmp (pTag, "qps") == 0
	       || (IsTag (pTag) && CatalogFile (CAppStore::Find ("launcher"), pTag) != 0);
}

void CGkI18n::Initialize (void)
{
	if (strcmp (GK_LANGUAGE, "en") != 0 && !SetLanguage (GK_LANGUAGE, "build"))
	{
		CLogger::Get ()->Write (From, LogWarning, "the build's language \"%s\" is unknown: English",
					GK_LANGUAGE);
	}
}

boolean CGkI18n::SetLanguage (const char *pTag, const char *pFrom)
{
	if (!IsKnown (pTag))
	{
		CLogger::Get ()->Write (From, LogWarning, "no language \"%.16s\" (%s)", pTag, pFrom);
		return FALSE;
	}
	strcpy (s_Language, pTag);
	ResolveMarks ();
	CLogger::Get ()->Write (From, LogNotice, "language %s, numbers 1%s234%s5 (%s)",
				s_Language, s_Group, s_Decimal, pFrom);
	return TRUE;
}

// --- marks --------------------------------------------------------------------

static boolean IsDecimalMark (const char *p)	{ return strcmp (p, ".") == 0 || strcmp (p, ",") == 0; }
static boolean IsGroupMark (const char *p)	{ return IsDecimalMark (p) || *p == '\0'; }

void CGkI18n::ResolveMarks (void)
{
	// the language's own: Portuguese writes 1.234,5; the others we have, 1,234.5
	boolean bComma = strcmp (s_Language, "pt") == 0 || strncmp (s_Language, "pt-", 3) == 0;
	strcpy (s_Decimal, s_bDecimalSet ? s_SetDecimal : bComma ? "," : ".");
	strcpy (s_Group, s_bGroupSet ? s_SetGroup : bComma ? "." : ",");

	// one mark set, and the language's other one the same: the other mark
	if (strcmp (s_Decimal, s_Group) == 0)
	{
		if (s_bDecimalSet)
		{
			strcpy (s_Group, strcmp (s_Decimal, ".") == 0 ? "," : ".");
		}
		else
		{
			strcpy (s_Decimal, strcmp (s_Group, ".") == 0 ? "," : ".");
		}
	}
}

boolean CGkI18n::SetMarks (const char *pDecimal, const char *pGroup, const char *pFrom)
{
	if (   (pDecimal != 0 && !IsDecimalMark (pDecimal))
	    || (pGroup != 0 && !IsGroupMark (pGroup))
	    || (pDecimal != 0 && pGroup != 0 && strcmp (pDecimal, pGroup) == 0))
	{
		return FALSE;
	}
	s_bDecimalSet = pDecimal != 0;
	strcpy (s_SetDecimal, pDecimal ? pDecimal : "");
	s_bGroupSet = pGroup != 0;
	strcpy (s_SetGroup, pGroup ? pGroup : "");
	ResolveMarks ();
	CLogger::Get ()->Write (From, LogNotice, "numbers 1%s234%s5 (%s)", s_Group, s_Decimal, pFrom);
	return TRUE;
}

boolean CGkI18n::Configure (const char *pKey, const char *pValue, unsigned nLine)
{
	CLogger *pLogger = CLogger::Get ();
	if (strcmp (pKey, "language") == 0)
	{
		if (!SetLanguage (pValue, "gapkeep.txt"))
		{
			pLogger->Write (From, LogWarning, "gapkeep.txt:%u: language: English instead", nLine);
		}
		return TRUE;
	}

	boolean bDecimal = strcmp (pKey, "decimal_mark") == 0;
	if (!bDecimal && strcmp (pKey, "group_mark") != 0)
	{
		return FALSE;
	}
	if (bDecimal ? !IsDecimalMark (pValue) : !IsGroupMark (pValue))
	{
		pLogger->Write (From, LogWarning, bDecimal ? "gapkeep.txt:%u: decimal_mark: . or , expected"
						  : "gapkeep.txt:%u: group_mark: . or , or nothing expected", nLine);
		return TRUE;
	}
	const char *pDecimal = bDecimal ? pValue : s_bDecimalSet ? s_SetDecimal : 0;
	const char *pGroup = !bDecimal ? pValue : s_bGroupSet ? s_SetGroup : 0;
	char Decimal[4], Group[4];		// SetMarks copies onto s_Set*
	if (pDecimal != 0) { strcpy (Decimal, pDecimal); pDecimal = Decimal; }
	if (pGroup != 0) { strcpy (Group, pGroup); pGroup = Group; }
	if (!SetMarks (pDecimal, pGroup, "gapkeep.txt"))
	{
		pLogger->Write (From, LogWarning, "gapkeep.txt:%u: decimal_mark and group_mark must differ", nLine);
	}
	return TRUE;
}

// --- checking translations ------------------------------------------------------

// The next code point of UTF-8 text, or -1 if it is malformed
static int NextCodePoint (const u8 **pp, const u8 *pEnd)
{
	const u8 *p = *pp;
	unsigned c = *p++;
	unsigned nMore = c < 0x80 ? 0 : (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2 : (c & 0xF8) == 0xF0 ? 3 : 9;
	if (nMore == 9 || p + nMore > pEnd)
	{
		*pp = pEnd;
		return -1;
	}
	if (nMore > 0)
	{
		c &= 0x3F >> nMore;
	}
	while (nMore--)
	{
		if ((*p & 0xC0) != 0x80)
		{
			*pp = pEnd;
			return -1;
		}
		c = c << 6 | (*p++ & 0x3F);
	}
	*pp = p;
	return (int) c;
}

// Control characters (C0 but the line feed, DEL, C1), the bidi controls and
// the line and paragraph separators: what could change how the text around
// reads (the set GapWallet, the companion web wallet, removes). Lone
// surrogates too.
static boolean IsForbidden (int c)
{
	return    c < 0
	       || (c < 0x20 && c != '\n')
	       || (c >= 0x7F && c <= 0x9F)
	       || c == 0x061C || c == 0x200E || c == 0x200F
	       || (c >= 0x2028 && c <= 0x202E)
	       || (c >= 0x2066 && c <= 0x2069)
	       || (c >= 0xD800 && c <= 0xDFFF);
}

struct TNames
{
	unsigned nCount;
	const char *pName[MaxNames];
	unsigned nLength[MaxNames];
};

static boolean IsWordChar (char c)
{
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

// The {names} of a message, as i18n.js finds them ({{ and }} are braces).
// FALSE if there are too many.
static boolean GetNames (const char *p, const char *pEnd, TNames *pNames)
{
	pNames->nCount = 0;
	while (p < pEnd)
	{
		if (p + 1 < pEnd && ((p[0] == '{' && p[1] == '{') || (p[0] == '}' && p[1] == '}')))
		{
			p += 2;
			continue;
		}
		if (*p == '{')
		{
			const char *q = p + 1;
			while (q < pEnd && IsWordChar (*q))
			{
				q++;
			}
			if (q > p + 1 && q < pEnd && *q == '}')
			{
				unsigned i;
				for (i = 0; i < pNames->nCount; i++)
				{
					if (   pNames->nLength[i] == (unsigned) (q - p - 1)
					    && memcmp (pNames->pName[i], p + 1, q - p - 1) == 0)
					{
						break;
					}
				}
				if (i == pNames->nCount)
				{
					if (i == MaxNames)
					{
						return FALSE;
					}
					pNames->pName[i] = p + 1;
					pNames->nLength[i] = q - p - 1;
					pNames->nCount++;
				}
				p = q + 1;
				continue;
			}
		}
		p++;
	}
	return TRUE;
}

static boolean Contains (const TNames &rNames, const char *pName, unsigned nLength)
{
	for (unsigned i = 0; i < rNames.nCount; i++)
	{
		if (rNames.nLength[i] == nLength && memcmp (rNames.pName[i], pName, nLength) == 0)
		{
			return TRUE;
		}
	}
	return FALSE;
}

// 0 if the translation may be shown, else why not
static const char *CheckTranslation (const char *pKey, size_t nKey, const char *pText, size_t nText)
{
	for (const u8 *p = (const u8 *) pText; p < (const u8 *) pText + nText; )
	{
		if (IsForbidden (NextCodePoint (&p, (const u8 *) pText + nText)))
		{
			return "has a control or bidi character";
		}
	}

	// the key's text, after its context ("verb\4Open")
	const char *pSep = (const char *) memchr (pKey, '\4', nKey);
	if (pSep != 0)
	{
		nKey -= pSep + 1 - pKey;
		pKey = pSep + 1;
	}
	static TNames KeyNames, TextNames;		// big for the stack
	if (   !GetNames (pKey, pKey + nKey, &KeyNames)
	    || !GetNames (pText, pText + nText, &TextNames))
	{
		return "has too many {names}";
	}
	boolean bSame = KeyNames.nCount == TextNames.nCount;
	for (unsigned i = 0; bSame && i < KeyNames.nCount; i++)
	{
		bSame = Contains (TextNames, KeyNames.pName[i], KeyNames.nLength[i]);
	}
	if (!bSame)
	{
		return "hasn't the same {names} as its key";
	}

	// tags (markup.h): a key's tags kept, as a multiset, in a valid nesting;
	// a key without tags stays without
	return GkMarkupCheckTranslation (pKey, nKey, pText, nText);
}

// --- loading catalogs -----------------------------------------------------------

// A key for the log: at most 40 bytes, cut between characters
static void LogKey (char *pOut, const char *pKey, size_t nKey)
{
	size_t n = nKey;
	if (n > 40)
	{
		n = 40;
		while (n > 0 && ((u8) pKey[n] & 0xC0) == 0x80)
		{
			n--;
		}
	}
	unsigned k = 0;
	for (size_t i = 0; i < n; i++)
	{
		pOut[k++] = (u8) pKey[i] < 0x20 ? '|' : pKey[i];	// the context's \4
	}
	strcpy (pOut + k, n < nKey ? "..." : "");
}

static void Problem (const char *pApp, const char *pPath, const char *pWhat)
{
	CLogger::Get ()->Write (From, LogWarning, "%s %s: %s", pApp, pPath, pWhat);
}

// Adds the checked translations of one catalog file to Messages
static void LoadFile (JSContext *ctx, JSValueConst Messages, const gk_app_t *pApp, const gk_file_t *pFile,
		      const char *pTag)
{
	if (pFile->size > MaxCatalogSize)
	{
		Problem (pApp->id, pFile->path, "larger than 256 KB, not loaded");
		return;
	}

	JSValue Obj = JS_ParseJSON (ctx, pFile->data, pFile->size, pFile->path);
	if (JS_IsException (Obj))
	{
		JSValue Exc = JS_GetException (ctx);
		const char *pMsg = JS_ToCString (ctx, Exc);
		Problem (pApp->id, pFile->path, pMsg ? pMsg : "not JSON");
		JS_FreeCString (ctx, pMsg);
		JS_FreeValue (ctx, Exc);
		return;
	}

	JSValue Lang = JS_UNDEFINED, App = JS_UNDEFINED, Table = JS_UNDEFINED;
	const char *pLang = 0, *pAppID = 0;
	do
	{
		if (!JS_IsObject (Obj) || JS_IsArray (ctx, Obj))
		{
			Problem (pApp->id, pFile->path, "not a JSON object, not loaded");
			break;
		}
		Lang = JS_GetPropertyStr (ctx, Obj, "$language");
		pLang = JS_IsString (Lang) ? JS_ToCString (ctx, Lang) : 0;
		if (!JS_IsUndefined (Lang) && (pLang == 0 || strcmp (pLang, pTag) != 0))
		{
			Problem (pApp->id, pFile->path, "its \"$language\" is not the file's, not loaded");
			break;
		}
		App = JS_GetPropertyStr (ctx, Obj, "$app");
		pAppID = JS_IsString (App) ? JS_ToCString (ctx, App) : 0;
		if (!JS_IsUndefined (App) && (pAppID == 0 || strcmp (pAppID, pApp->id) != 0))
		{
			Problem (pApp->id, pFile->path, "its \"$app\" is another app's, not loaded");
			break;
		}
		Table = JS_GetPropertyStr (ctx, Obj, "messages");
		if (!JS_IsObject (Table) || JS_IsArray (ctx, Table))
		{
			Problem (pApp->id, pFile->path, "no \"messages\" object, not loaded");
			break;
		}

		JSPropertyEnum *pProps;
		uint32_t nProps;
		if (JS_GetOwnPropertyNames (ctx, &pProps, &nProps, Table,
					    JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
		{
			JS_FreeValue (ctx, JS_GetException (ctx));
			break;
		}
		unsigned nTaken = 0, nRefused = 0;
		for (uint32_t i = 0; i < nProps; i++)
		{
			JSValue Value = JS_GetProperty (ctx, Table, pProps[i].atom);
			size_t nKey = 0, nText = 0;
			const char *pKey = JS_AtomToCStringLen (ctx, &nKey, pProps[i].atom);
			const char *pText = JS_IsString (Value) ? JS_ToCStringLen (ctx, &nText, Value) : 0;
			const char *pWhy = pKey == 0 ? "unreadable"
					 : !JS_IsString (Value) ? "is not a string"
					 : pText == 0 ? "unreadable"
					 : CheckTranslation (pKey, nKey, pText, nText);
			if (pWhy == 0 && nText > 0)
			{
				JS_DefinePropertyValue (ctx, Messages, JS_DupAtom (ctx, pProps[i].atom),
							JS_DupValue (ctx, Value), JS_PROP_C_W_E);
				nTaken++;
			}
			else if (pWhy != 0)
			{
				char Key[48];
				LogKey (Key, pKey ? pKey : "?", pKey ? nKey : 1);
				CLogger::Get ()->Write (From, LogWarning, "%s %s: \"%s\": the translation %s:"
							" ignored, English shown", pApp->id, pFile->path, Key, pWhy);
				nRefused++;
			}
			// else "": not translated yet (tools/i18n.py extract), English shown
			JS_FreeCString (ctx, pKey);
			JS_FreeCString (ctx, pText);
			JS_FreeValue (ctx, Value);
		}
		JS_FreePropertyEnum (ctx, pProps, nProps);
		JS_FreeValue (ctx, JS_GetException (ctx));	// none expected, but never leave one pending

		CLogger::Get ()->Write (From, nRefused ? LogWarning : LogNotice, "%s %s: %u translations, %u ignored",
					pApp->id, pFile->path, nTaken, nRefused);
	}
	while (0);

	JS_FreeCString (ctx, pLang);
	JS_FreeCString (ctx, pAppID);
	JS_FreeValue (ctx, Lang);
	JS_FreeValue (ctx, App);
	JS_FreeValue (ctx, Table);
	JS_FreeValue (ctx, Obj);
}

// An app's translations into the language: lang/pt.json, then lang/pt-BR.json
// over it. null if there is nothing to translate (English, qps, no catalog).
static JSValue LoadMessages (JSContext *ctx, const gk_app_t *pApp, const char *pTag)
{
	if (pApp == 0 || strcmp (pTag, "en") == 0 || strcmp (pTag, "qps") == 0)
	{
		return JS_NULL;
	}

	char Base[16];
	strcpy (Base, pTag);
	char *pDash = strchr (Base, '-');
	if (pDash != 0)
	{
		*pDash = '\0';
	}
	const gk_file_t *pBase = pDash != 0 ? CatalogFile (pApp, Base) : 0;
	const gk_file_t *pFile = CatalogFile (pApp, pTag);
	if (pBase == 0 && pFile == 0)
	{
		return JS_NULL;
	}

	JSValue Messages = JS_NewObjectProto (ctx, JS_NULL);	// no "__proto__", "toString"...
	if (pBase != 0)
	{
		LoadFile (ctx, Messages, pApp, pBase, Base);
	}
	if (pFile != 0)
	{
		LoadFile (ctx, Messages, pApp, pFile, pTag);
	}
	return Messages;
}

// --- app names and descriptions ----------------------------------------------------

// The translation of each key, or 0, from one catalog file. Only these
// keys are looked at (the launcher asks for every app's), with the checks
// of LoadFile; a refused one is logged.
static void LookupFile (JSContext *ctx, const gk_app_t *pApp, const gk_file_t *pFile, const char *pTag,
			const char *pKeys[], char *pOut[], unsigned nKeys)
{
	if (pFile == 0 || pFile->size > MaxCatalogSize)
	{
		return;		// (LoadFile logs it when the app starts)
	}
	JSValue Obj = JS_ParseJSON (ctx, pFile->data, pFile->size, pFile->path);
	if (JS_IsException (Obj))
	{
		JS_FreeValue (ctx, JS_GetException (ctx));
		return;
	}
	JSValue Lang = JS_GetPropertyStr (ctx, Obj, "$language");
	JSValue App = JS_GetPropertyStr (ctx, Obj, "$app");
	const char *pLang = JS_IsString (Lang) ? JS_ToCString (ctx, Lang) : 0;
	const char *pAppID = JS_IsString (App) ? JS_ToCString (ctx, App) : 0;
	JSValue Table = JS_GetPropertyStr (ctx, Obj, "messages");
	if (   (JS_IsUndefined (Lang) || (pLang != 0 && strcmp (pLang, pTag) == 0))
	    && (JS_IsUndefined (App) || (pAppID != 0 && strcmp (pAppID, pApp->id) == 0))
	    && JS_IsObject (Table) && !JS_IsArray (ctx, Table))
	{
		for (unsigned i = 0; i < nKeys; i++)
		{
			if (pKeys[i] == 0 || *pKeys[i] == '\0')
			{
				continue;
			}
			JSValue Value = JS_GetPropertyStr (ctx, Table, pKeys[i]);
			size_t nText = 0;
			const char *pText = JS_IsString (Value) ? JS_ToCStringLen (ctx, &nText, Value) : 0;
			if (pText != 0 && nText > 0)
			{
				const char *pWhy = CheckTranslation (pKeys[i], strlen (pKeys[i]), pText, nText);
				if (pWhy == 0 && memchr (pText, '\n', nText) != 0)
				{
					pWhy = "has a line break";
				}
				if (pWhy == 0)
				{
					delete [] pOut[i];
					pOut[i] = new char[nText + 1];
					memcpy (pOut[i], pText, nText + 1);
				}
				else
				{
					char Key[48];
					LogKey (Key, pKeys[i], strlen (pKeys[i]));
					CLogger::Get ()->Write (From, LogWarning, "%s %s: \"%s\": the translation %s:"
								" ignored, English shown", pApp->id, pFile->path, Key, pWhy);
				}
			}
			JS_FreeCString (ctx, pText);
			JS_FreeValue (ctx, Value);
		}
	}
	JS_FreeCString (ctx, pLang);
	JS_FreeCString (ctx, pAppID);
	JS_FreeValue (ctx, Table);
	JS_FreeValue (ctx, Lang);
	JS_FreeValue (ctx, App);
	JS_FreeValue (ctx, Obj);
}

struct TAppText
{
	const gk_app_t *pApp;
	char Language[16];	// what these are in
	char *pName;		// 0: the manifest's
	char *pDescription;
};

static const unsigned MaxAppTexts = 256;
static TAppText s_AppTexts[MaxAppTexts];

static TAppText *AppText (JSContext *ctx, const gk_app_t *pApp, const char *pLanguage)
{
	TAppText *pFree = 0;
	for (unsigned i = 0; i < MaxAppTexts; i++)
	{
		if (s_AppTexts[i].pApp == pApp)
		{
			pFree = &s_AppTexts[i];
			if (strcmp (pFree->Language, pLanguage) == 0)
			{
				return pFree;
			}
			break;
		}
		if (pFree == 0 && s_AppTexts[i].pApp == 0)
		{
			pFree = &s_AppTexts[i];
		}
	}
	if (pFree == 0)
	{
		return 0;
	}

	TAppText *p = pFree;
	p->pApp = pApp;
	strcpy (p->Language, pLanguage);
	delete [] p->pName;
	delete [] p->pDescription;
	p->pName = p->pDescription = 0;
	if (strcmp (pLanguage, "en") == 0 || strcmp (pLanguage, "qps") == 0)
	{
		return p;
	}

	char Base[16];
	strcpy (Base, pLanguage);
	char *pDash = strchr (Base, '-');
	const char *pKeys[2] = {pApp->name, pApp->description};
	char *pOut[2] = {0, 0};
	if (pDash != 0)
	{
		*pDash = '\0';
		LookupFile (ctx, pApp, CatalogFile (pApp, Base), Base, pKeys, pOut, 2);
	}
	LookupFile (ctx, pApp, CatalogFile (pApp, pLanguage), pLanguage, pKeys, pOut, 2);
	p->pName = pOut[0];
	p->pDescription = pOut[1];
	return p;
}

// qps, as i18n.js's pseudo() makes it: accented, about 40% longer, in brackets
static const char *Accented (char c)
{
	static const char *Lower[26] = {"å", 0, "ç", "ď", "é", 0, "ĝ", "ĥ", "î", "ĵ", "ķ", "ĺ", 0, "ñ", "ö",
					0, 0, "ŕ", "š", "ţ", "û", 0, "ŵ", 0, "ý", "ž"};
	static const char *Upper[26] = {"Å", 0, "Ç", "Ď", "É", 0, "Ĝ", "Ĥ", "Î", "Ĵ", "Ķ", "Ĺ", 0, "Ñ", "Ö",
					0, 0, "Ŕ", "Š", "Ţ", "Û", 0, "Ŵ", 0, "Ý", "Ž"};
	return c >= 'a' && c <= 'z' ? Lower[c - 'a'] : c >= 'A' && c <= 'Z' ? Upper[c - 'A'] : 0;
}

static const char *Pseudo (const char *pText, char **ppCache)
{
	if (*ppCache == 0)
	{
		size_t n = strlen (pText), nChars = 0;
		for (const char *p = pText; *p; p++)
		{
			nChars += ((u8) *p & 0xC0) != 0x80;
		}
		size_t nDots = (nChars * 4 + 9) / 10;
		nDots = nDots ? nDots : 1;
		char *q = *ppCache = new char[1 + n * 2 + 1 + nDots * 2 + 2];	// accents: 2 bytes
		*q++ = '[';
		for (const char *p = pText; *p; p++)
		{
			const char *a = Accented (*p);
			if (a != 0)
			{
				strcpy (q, a);
				q += strlen (a);
			}
			else
			{
				*q++ = *p;
			}
		}
		*q++ = ' ';
		for (size_t i = 0; i < nDots; i++)
		{
			*q++ = (char) 0xC2;	// U+00B7
			*q++ = (char) 0xB7;
		}
		*q++ = ']';
		*q = '\0';
	}
	return *ppCache;
}

const char *CGkI18n::GetAppName (JSContext *ctx, const gk_app_t *pApp)
{
	TAppText *p = AppText (ctx, pApp, s_Language);
	if (p != 0 && strcmp (s_Language, "qps") == 0)
	{
		return Pseudo (pApp->name, &p->pName);
	}
	return p != 0 && p->pName != 0 ? p->pName : pApp->name;
}

const char *CGkI18n::GetAppDescription (JSContext *ctx, const gk_app_t *pApp)
{
	TAppText *p = AppText (ctx, pApp, s_Language);
	if (p != 0 && strcmp (s_Language, "qps") == 0)
	{
		return *pApp->description ? Pseudo (pApp->description, &p->pDescription) : "";
	}
	return p != 0 && p->pDescription != 0 ? p->pDescription : pApp->description;
}

unsigned CGkI18n::LoadCatalog (TGkApp *pApp)
{
	unsigned nStart = CTimer::Get ()->GetClockTicks ();

	JSContext *ctx = pApp->pContext;
	if (pApp->pI18n == 0)
	{
		pApp->pI18n = new TGkI18nState;
		pApp->pI18n->Messages = JS_NULL;
		pApp->pI18n->System = JS_UNDEFINED;
	}
	JS_FreeValue (ctx, pApp->pI18n->Messages);
	JS_FreeValue (ctx, pApp->pI18n->System);
	pApp->pI18n->System = JS_UNDEFINED;
	pApp->pI18n->Messages = LoadMessages (ctx, pApp->pBundle, s_Language);

	return CTimer::Get ()->GetClockTicks () - nStart;
}

void CGkI18n::FreeApp (TGkApp *pApp)
{
	if (pApp->pI18n != 0)
	{
		JS_FreeValue (pApp->pContext, pApp->pI18n->Messages);
		JS_FreeValue (pApp->pContext, pApp->pI18n->System);
		delete pApp->pI18n;
		pApp->pI18n = 0;
	}
}

// --- "gk:i18n-native" -------------------------------------------------------------

static TGkI18nState *State (JSContext *ctx)
{
	TGkApp *pApp = CAppHost::GetApp (ctx);
	assert (pApp != 0 && pApp->pI18n != 0);
	return pApp->pI18n;
}

static boolean MayChange (JSContext *ctx, const char *pFunction)
{
	if (CAppHost::GetApp (ctx)->pBundle->permissions & GK_PERM_SETTINGS)
	{
		return TRUE;
	}
	JS_ThrowTypeError (ctx, "%s needs \"permissions\": [\"settings\"] in manifest.json", pFunction);
	return FALSE;
}

static JSValue js_i18n_state (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValue Obj = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, Obj, "language", JS_NewString (ctx, CGkI18n::GetLanguage ()));
	JS_SetPropertyStr (ctx, Obj, "decimal", JS_NewString (ctx, CGkI18n::GetDecimal ()));
	JS_SetPropertyStr (ctx, Obj, "group", JS_NewString (ctx, CGkI18n::GetGroup ()));
	JS_SetPropertyStr (ctx, Obj, "keyboard", JS_NewString (ctx, CGkI18n::GetKeyboard ()));
	return Obj;
}

static JSValue js_i18n_messages (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return JS_DupValue (ctx, State (ctx)->Messages);
}

static JSValue js_i18n_system_messages (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	TGkI18nState *pState = State (ctx);
	if (JS_IsUndefined (pState->System))
	{
		pState->System = LoadMessages (ctx, CAppStore::Find ("launcher"), CGkI18n::GetLanguage ());
	}
	return JS_DupValue (ctx, pState->System);
}

// [{ tag, name }]: English, then each language the launcher has a catalog for,
// named in itself (its catalog's "$name")
static JSValue js_i18n_languages (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValue List = JS_NewArray (ctx);
	unsigned n = 0;

	JSValue English = JS_NewObject (ctx);
	JS_SetPropertyStr (ctx, English, "tag", JS_NewString (ctx, "en"));
	JS_SetPropertyStr (ctx, English, "name", JS_NewString (ctx, "English"));
	JS_SetPropertyUint32 (ctx, List, n++, English);

	const gk_app_t *pLauncher = CAppStore::Find ("launcher");
	for (unsigned i = 0; pLauncher != 0 && i < pLauncher->file_count; i++)
	{
		const gk_file_t *pFile = &pLauncher->files[i];
		size_t nPath = strlen (pFile->path);
		char Tag[16];
		if (   strncmp (pFile->path, "lang/", 5) != 0 || nPath < 5 + 5 || nPath - 10 >= sizeof Tag
		    || strcmp (pFile->path + nPath - 5, ".json") != 0)
		{
			continue;
		}
		memcpy (Tag, pFile->path + 5, nPath - 10);
		Tag[nPath - 10] = '\0';
		if (!IsTag (Tag) || strcmp (Tag, "en") == 0 || pFile->size > MaxCatalogSize)
		{
			continue;
		}

		JSValue Name = JS_UNDEFINED;
		JSValue Obj = JS_ParseJSON (ctx, pFile->data, pFile->size, pFile->path);
		if (JS_IsException (Obj))
		{
			JS_FreeValue (ctx, JS_GetException (ctx));
		}
		else if (JS_IsObject (Obj))
		{
			Name = JS_GetPropertyStr (ctx, Obj, "$name");
		}
		JS_FreeValue (ctx, Obj);

		// a name that is text on one line, and nothing else
		size_t nName = 0;
		const char *pName = JS_IsString (Name) ? JS_ToCStringLen (ctx, &nName, Name) : 0;
		boolean bOK = pName != 0 && nName > 0 && nName <= 64 && memchr (pName, '\n', nName) == 0;
		for (const u8 *p = (const u8 *) pName; bOK && p < (const u8 *) pName + nName; )
		{
			bOK = !IsForbidden (NextCodePoint (&p, (const u8 *) pName + nName));
		}
		JSValue Entry = JS_NewObject (ctx);
		JS_SetPropertyStr (ctx, Entry, "tag", JS_NewString (ctx, Tag));
		JS_SetPropertyStr (ctx, Entry, "name", JS_NewString (ctx, bOK ? pName : Tag));
		JS_SetPropertyUint32 (ctx, List, n++, Entry);
		JS_FreeCString (ctx, pName);
		JS_FreeValue (ctx, Name);
	}
	return List;
}

static JSValue js_i18n_keyboards (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	JSValue List = JS_NewArray (ctx);
	const char *const *ppLayouts = GkKeyLayouts ();
	for (unsigned i = 0; ppLayouts[i] != 0; i++)
	{
		JS_SetPropertyUint32 (ctx, List, i, JS_NewString (ctx, ppLayouts[i]));
	}
	return List;
}

static JSValue js_i18n_set_language (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!MayChange (ctx, "setLanguage"))
	{
		return JS_EXCEPTION;
	}
	const char *pTag = JS_ToCString (ctx, argv[0]);
	if (pTag == 0)
	{
		return JS_EXCEPTION;
	}
	TGkApp *pApp = CAppHost::GetApp (ctx);
	CString Who;
	Who.Format ("app %s", pApp->pBundle->id);
	boolean bOK = CGkI18n::SetLanguage (pTag, Who);
	JSValue Result = JS_UNDEFINED;
	if (!bOK)
	{
		Result = JS_ThrowRangeError (ctx, "setLanguage: no language \"%.16s\" (languages() lists them)", pTag);
	}
	else
	{
		unsigned nUs = CGkI18n::LoadCatalog (pApp);
		CLogger::Get ()->Write (From, LogNotice, "%s: catalog reloaded, %u us", pApp->pBundle->id, nUs);
	}
	JS_FreeCString (ctx, pTag);
	return Result;
}

// undefined: the language's own; a string: "." or "," (decimal), and "" too
// (group). 0 and TRUE, or FALSE with an exception thrown.
static boolean GetMark (JSContext *ctx, JSValueConst Value, char *pOut)
{
	if (JS_IsUndefined (Value) || JS_IsNull (Value))
	{
		*pOut = '\0';
		return TRUE;
	}
	if (!JS_IsString (Value))
	{
		JS_ThrowTypeError (ctx, "setMarks: marks are strings");
		return FALSE;
	}
	size_t n;
	const char *p = JS_ToCStringLen (ctx, &n, Value);
	if (p == 0)
	{
		return FALSE;
	}
	boolean bOK = n < 2;
	if (bOK)
	{
		strcpy (pOut, p);
	}
	JS_FreeCString (ctx, p);
	if (!bOK)
	{
		JS_ThrowRangeError (ctx, "setMarks: decimal \".\" or \",\"; group \".\", \",\" or \"\"; not the same");
	}
	return bOK;
}

static JSValue js_i18n_set_marks (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!MayChange (ctx, "setMarks"))
	{
		return JS_EXCEPTION;
	}
	char Decimal[4], Group[4];
	if (!GetMark (ctx, argv[0], Decimal) || !GetMark (ctx, argv[1], Group))
	{
		return JS_EXCEPTION;
	}
	boolean bDecimal = JS_IsString (argv[0]), bGroup = JS_IsString (argv[1]);
	if (bDecimal && Decimal[0] == '\0')
	{
		return JS_ThrowRangeError (ctx, "setMarks: decimal \".\" or \",\"; group \".\", \",\" or \"\"; not the same");
	}
	CString Who;
	Who.Format ("app %s", CAppHost::GetApp (ctx)->pBundle->id);
	if (!CGkI18n::SetMarks (bDecimal ? Decimal : 0, bGroup ? Group : 0, Who))
	{
		return JS_ThrowRangeError (ctx, "setMarks: decimal \".\" or \",\"; group \".\", \",\" or \"\"; not the same");
	}
	return JS_UNDEFINED;
}

static JSValue js_i18n_set_keyboard (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	if (!MayChange (ctx, "setKeyboard"))
	{
		return JS_EXCEPTION;
	}
	const char *pLayout = JS_ToCString (ctx, argv[0]);
	if (pLayout == 0)
	{
		return JS_EXCEPTION;
	}
	// the keyboard's layout switch (keylayout.h): at once, for every app,
	// until power-off; logged, never what is typed
	CString Who;
	Who.Format ("app %s", CAppHost::GetApp (ctx)->pBundle->id);
	boolean bOK = GkKeyLayoutSet (pLayout, Who);
	JS_FreeCString (ctx, pLayout);
	if (!bOK)
	{
		return JS_ThrowRangeError (ctx, "setKeyboard: no such layout (keyboards() lists them)");
	}
	return JS_UNDEFINED;
}

static JSValue js_i18n_utc_offset (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	return JS_NewInt32 (ctx, CGkClock::GetUtcOffset ());
}

static const JSCFunctionListEntry NativeFunctions[] =
{
	JS_CFUNC_DEF ("state", 0, js_i18n_state),
	JS_CFUNC_DEF ("messages", 0, js_i18n_messages),
	JS_CFUNC_DEF ("systemMessages", 0, js_i18n_system_messages),
	JS_CFUNC_DEF ("languages", 0, js_i18n_languages),
	JS_CFUNC_DEF ("keyboards", 0, js_i18n_keyboards),
	JS_CFUNC_DEF ("setLanguage", 1, js_i18n_set_language),
	JS_CFUNC_DEF ("setMarks", 2, js_i18n_set_marks),
	JS_CFUNC_DEF ("setKeyboard", 1, js_i18n_set_keyboard),
	JS_CFUNC_DEF ("utcOffset", 0, js_i18n_utc_offset),
};

static int NativeModuleInit (JSContext *ctx, JSModuleDef *m)
{
	return JS_SetModuleExportList (ctx, m, NativeFunctions, sizeof NativeFunctions / sizeof NativeFunctions[0]);
}

JSModuleDef *GkInitI18nNativeModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, NativeModuleInit);
	if (m == 0)
	{
		return 0;
	}
	JS_AddModuleExportList (ctx, m, NativeFunctions, sizeof NativeFunctions / sizeof NativeFunctions[0]);
	return m;
}

// "gk:i18n": compiled from its JavaScript when an app imports it
JSModuleDef *GkInitI18nModule (JSContext *ctx, const char *pName)
{
	JSValue Func = JS_Eval (ctx, gk_i18n_js, gk_i18n_js_size, pName,
				JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
	if (JS_IsException (Func))
	{
		return 0;
	}
	JSModuleDef *m = (JSModuleDef *) JS_VALUE_GET_PTR (Func);
	JS_FreeValue (ctx, Func);
	return m;
}
