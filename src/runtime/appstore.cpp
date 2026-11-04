//
// appstore.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "appstore.h"
#include "apphost.h"
#include "../crypto/sha256.h"
#include <circle/logger.h>
#include <circle/util.h>
#include <circle/string.h>
#include <assert.h>

#ifndef ZG_SEALED
#include <ff.h>				// lib/fatfs: read-only FatFs
#endif

static const char From[] = "appstore";

// Limits for apps on the card. Generous for real apps, but a card full of
// junk must not exhaust memory or stall the boot.
static const unsigned MaxCardApps = 64;
static const unsigned MaxFiles = 256;			// per app
static const unsigned MaxFileSize = 4 * 1024 * 1024;
static const unsigned MaxAppSize = 16 * 1024 * 1024;	// all files of one app
static const unsigned MaxDepth = 8;			// folder levels inside an app
static const unsigned MaxNameLength = 64;		// of one file or folder name
static const unsigned MaxProblems = 16;

static const zg_app_t **s_ppApps = 0;
static unsigned s_nApps = 0;
static TZgCardStatus s_CardStatus = ZgCardDisabled;

struct TProblem
{
	char *pFolder;
	char *pText;
};
static TProblem s_Problems[MaxProblems];
static unsigned s_nProblems = 0;

static char *StrDup (const char *p)
{
	size_t n = strlen (p) + 1;
	char *q = new char[n];
	memcpy (q, p, n);
	return q;
}

unsigned CAppStore::GetCount (void)
{
	return s_nApps;
}

const zg_app_t *CAppStore::Get (unsigned nIndex)
{
	return nIndex < s_nApps ? s_ppApps[nIndex] : 0;
}

const zg_app_t *CAppStore::Find (const char *pID)
{
	for (unsigned i = 0; i < s_nApps; i++)
	{
		if (strcmp (s_ppApps[i]->id, pID) == 0)
		{
			return s_ppApps[i];
		}
	}

	return 0;
}

TZgCardStatus CAppStore::GetCardStatus (void)
{
	return s_CardStatus;
}

const char *CAppStore::GetCardStatusName (void)
{
	switch (s_CardStatus)
	{
	case ZgCardDisabled:	return "disabled";
	case ZgCardNone:	return "none";
	case ZgCardUnreadable:	return "unreadable";
	case ZgCardNoApps:	return "no-apps";
	case ZgCardOK:		return "ok";
	}

	return "?";
}

unsigned CAppStore::GetProblemCount (void)
{
	return s_nProblems;
}

const char *CAppStore::GetProblemFolder (unsigned nIndex)
{
	return nIndex < s_nProblems ? s_Problems[nIndex].pFolder : 0;
}

const char *CAppStore::GetProblemText (unsigned nIndex)
{
	return nIndex < s_nProblems ? s_Problems[nIndex].pText : 0;
}

#ifndef ZG_SEALED

static void AddProblem (const char *pFolder, const char *pText)
{
	CLogger::Get ()->Write (From, LogWarning, "apps/%s not loaded: %s", pFolder, pText);

	if (s_nProblems < MaxProblems)
	{
		s_Problems[s_nProblems].pFolder = StrDup (pFolder);
		s_Problems[s_nProblems].pText = StrDup (pText);
		s_nProblems++;
	}
}

// --- checks shared with tools/bundle_apps.py --------------------------------

static boolean IsValidID (const char *p)
{
	// ^[a-z0-9][a-z0-9-]{0,31}$
	size_t n = strlen (p);
	if (n < 1 || n > 32 || *p == '-')
	{
		return FALSE;
	}
	for (; *p; p++)
	{
		if (!(('a' <= *p && *p <= 'z') || ('0' <= *p && *p <= '9') || *p == '-'))
		{
			return FALSE;
		}
	}

	return TRUE;
}

// Names of the folders and files that are loaded: [A-Za-z0-9._-], not
// starting with '.' (those are skipped: macOS litters cards with "._x.js").
static boolean IsValidName (const char *p)
{
	if (*p == '\0' || strlen (p) > MaxNameLength)
	{
		return FALSE;
	}
	for (; *p; p++)
	{
		char c = *p;
		if (!(   ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
		      || ('0' <= c && c <= '9') || c == '.' || c == '_' || c == '-'))
		{
			return FALSE;
		}
	}

	return TRUE;
}

static boolean EndsWith (const char *p, const char *pSuffix)
{
	size_t n = strlen (p), m = strlen (pSuffix);
	return n >= m && strcmp (p + n - m, pSuffix) == 0;
}

// The files an app consists of; the rest (README.md, images, ...) is ignored.
static boolean IsAppFile (const char *pName)
{
	return    (EndsWith (pName, ".js") || EndsWith (pName, ".json") || EndsWith (pName, ".txt"))
	       && strcmp (pName, "package.json") != 0;
}

// Strict UTF-8, as Python's bytes.decode('utf-8'): no overlong forms, no
// surrogates, nothing above U+10FFFF. NUL bytes are rejected too.
static boolean IsValidUTF8 (const u8 *p, unsigned n)
{
	unsigned i = 0;
	while (i < n)
	{
		u8 c = p[i];
		unsigned nMore;
		u32 nMin, nCode;
		if (c == 0)
		{
			return FALSE;
		}
		else if (c < 0x80)
		{
			i++;
			continue;
		}
		else if ((c & 0xE0) == 0xC0)
		{
			nMore = 1, nMin = 0x80, nCode = c & 0x1F;
		}
		else if ((c & 0xF0) == 0xE0)
		{
			nMore = 2, nMin = 0x800, nCode = c & 0x0F;
		}
		else if ((c & 0xF8) == 0xF0)
		{
			nMore = 3, nMin = 0x10000, nCode = c & 0x07;
		}
		else
		{
			return FALSE;
		}

		if (n - i <= nMore)
		{
			return FALSE;
		}
		for (unsigned k = 1; k <= nMore; k++)
		{
			if ((p[i + k] & 0xC0) != 0x80)
			{
				return FALSE;
			}
			nCode = (nCode << 6) | (p[i + k] & 0x3F);
		}
		if (   nCode < nMin || nCode > 0x10FFFF
		    || (0xD800 <= nCode && nCode <= 0xDFFF))
		{
			return FALSE;
		}

		i += nMore + 1;
	}

	return TRUE;
}

// --- reading an app folder --------------------------------------------------

struct TFileList
{
	zg_file_t *pFiles;		// MaxFiles entries
	unsigned nCount;
	unsigned nTotalSize;
};

static void FreeFiles (TFileList *pList)
{
	for (unsigned i = 0; i < pList->nCount; i++)
	{
		delete [] (char *) pList->pFiles[i].path;
		delete [] (char *) pList->pFiles[i].data;
	}
	delete [] pList->pFiles;
	pList->pFiles = 0;
	pList->nCount = 0;
}

static boolean ReadFile (const char *pFullPath, const char *pRelPath, unsigned nSize,
			 TFileList *pList, CString *pError)
{
	if (pList->nCount >= MaxFiles)
	{
		pError->Format ("more than %u files", MaxFiles);
		return FALSE;
	}
	if (nSize > MaxFileSize || pList->nTotalSize + nSize > MaxAppSize)
	{
		pError->Format ("%s: too large (at most %u MB per file, %u MB per app)",
				pRelPath, MaxFileSize >> 20, MaxAppSize >> 20);
		return FALSE;
	}

	FIL File;
	if (f_open (&File, pFullPath, FA_READ) != FR_OK)
	{
		pError->Format ("%s: cannot open", pRelPath);
		return FALSE;
	}

	char *pData = new char[nSize + 1];
	UINT nRead = 0;
	FRESULT Result = f_read (&File, pData, nSize, &nRead);
	f_close (&File);
	if (Result != FR_OK || nRead != nSize)
	{
		delete [] pData;
		pError->Format ("%s: read error", pRelPath);
		return FALSE;
	}
	pData[nSize] = '\0';

	if (!IsValidUTF8 ((const u8 *) pData, nSize))
	{
		delete [] pData;
		pError->Format ("%s: not valid UTF-8 text", pRelPath);
		return FALSE;
	}

	zg_file_t *pFile = &pList->pFiles[pList->nCount++];
	pFile->path = StrDup (pRelPath);
	pFile->data = pData;
	pFile->size = nSize;
	pList->nTotalSize += nSize;

	return TRUE;
}

// Reads the app files in pDir (on the card) and below; pRel is pDir relative
// to the app folder ("" at the top).
static boolean ReadFolder (const char *pDir, const char *pRel, unsigned nDepth,
			   TFileList *pList, CString *pError)
{
	DIR Dir;
	if (f_opendir (&Dir, pDir) != FR_OK)
	{
		pError->Format ("%s: cannot open folder", *pRel ? pRel : ".");
		return FALSE;
	}

	boolean bOK = TRUE;
	FILINFO Info;
	while (bOK)
	{
		if (f_readdir (&Dir, &Info) != FR_OK)
		{
			pError->Format ("%s: read error", *pRel ? pRel : ".");
			bOK = FALSE;
			break;
		}
		if (Info.fname[0] == '\0')
		{
			break;		// end of folder
		}
		if (Info.fname[0] == '.')
		{
			continue;	// hidden, or macOS metadata
		}

		boolean bDir = !!(Info.fattrib & AM_DIR);
		if (!bDir && !IsAppFile (Info.fname))
		{
			continue;	// not part of the app
		}

		CString Rel;
		Rel.Format ("%s%s%s", pRel, *pRel ? "/" : "", Info.fname);
		if (!IsValidName (Info.fname))
		{
			pError->Format ("%s: name may only contain A-Z a-z 0-9 . _ -", (const char *) Rel);
			bOK = FALSE;
			break;
		}

		CString Full;
		Full.Format ("%s/%s", pDir, Info.fname);
		if (bDir)
		{
			if (nDepth >= MaxDepth)
			{
				pError->Format ("%s: folders nested too deeply", (const char *) Rel);
				bOK = FALSE;
			}
			else
			{
				bOK = ReadFolder (Full, Rel, nDepth + 1, pList, pError);
			}
		}
		else
		{
			bOK = ReadFile (Full, Rel, (unsigned) Info.fsize, pList, pError);
		}
	}

	f_closedir (&Dir);

	return bOK;
}

static void SortFiles (TFileList *pList)
{
	// insertion sort by path (byte order, like the bundler); n is small
	for (unsigned i = 1; i < pList->nCount; i++)
	{
		zg_file_t Tmp = pList->pFiles[i];
		unsigned j = i;
		for (; j > 0 && strcmp (pList->pFiles[j - 1].path, Tmp.path) > 0; j--)
		{
			pList->pFiles[j] = pList->pFiles[j - 1];
		}
		pList->pFiles[j] = Tmp;
	}
}

static const zg_file_t *FindFile (const TFileList *pList, const char *pPath)
{
	for (unsigned i = 0; i < pList->nCount; i++)
	{
		if (strcmp (pList->pFiles[i].path, pPath) == 0)
		{
			return &pList->pFiles[i];
		}
	}

	return 0;
}

// --- manifest.json ----------------------------------------------------------

// A string property of the manifest: FALSE and *pError set if it has the
// wrong type, is empty or too long; *ppValue stays 0 if it is absent.
static boolean GetString (JSContext *ctx, JSValueConst Obj, const char *pKey, unsigned nMaxLength,
			  boolean bRequired, char **ppValue, CString *pError)
{
	*ppValue = 0;

	JSValue Value = JS_GetPropertyStr (ctx, Obj, pKey);
	if (JS_IsUndefined (Value))
	{
		if (bRequired)
		{
			pError->Format ("manifest.json: \"%s\" is required", pKey);
			return FALSE;
		}
		return TRUE;
	}

	boolean bOK = FALSE;
	if (JS_IsString (Value))
	{
		size_t nLength;
		const char *p = JS_ToCStringLen (ctx, &nLength, Value);
		if (p != 0 && nLength > 0 && nLength <= nMaxLength && strlen (p) == nLength)
		{
			*ppValue = StrDup (p);
			bOK = TRUE;
		}
		JS_FreeCString (ctx, p);
	}
	JS_FreeValue (ctx, Value);

	if (!bOK)
	{
		pError->Format ("manifest.json: \"%s\" must be a non-empty string of at most %u bytes",
				pKey, nMaxLength);
	}

	return bOK;
}

// Strict base64 (RFC 4648, with padding, canonical: unused bits zero), as
// Python's b64decode(validate=True) plus re-encoding checks it in
// tools/bundle_apps.py. Returns the number of bytes, or -1.
static int DecodeBase64 (const char *pIn, size_t nInLength, u8 *pOut, size_t nOutSize)
{
	if (nInLength % 4 != 0)
	{
		return -1;
	}

	size_t nOut = 0;
	for (size_t i = 0; i < nInLength; i += 4)
	{
		boolean bLast = i + 4 == nInLength;
		u32 nBits = 0;
		unsigned nPad = 0;
		for (unsigned k = 0; k < 4; k++)
		{
			char c = pIn[i + k];
			int v;
			if (c >= 'A' && c <= 'Z')	v = c - 'A';
			else if (c >= 'a' && c <= 'z')	v = c - 'a' + 26;
			else if (c >= '0' && c <= '9')	v = c - '0' + 52;
			else if (c == '+')		v = 62;
			else if (c == '/')		v = 63;
			else if (c == '=' && bLast && k >= 2)
			{
				v = 0;
				nPad++;
			}
			else
			{
				return -1;
			}
			if (nPad > 0 && c != '=')	// "=" only at the very end
			{
				return -1;
			}
			nBits = nBits << 6 | v;
		}
		if (   (nPad == 1 && (nBits & 0xFF) != 0)		// canonical: unused bits 0
		    || (nPad == 2 && (nBits & 0xFFFF) != 0))
		{
			return -1;
		}

		unsigned nBytes = 3 - nPad;
		if (nOut + nBytes > nOutSize)
		{
			return -1;
		}
		for (unsigned k = 0; k < nBytes; k++)
		{
			pOut[nOut++] = (u8) (nBits >> (16 - 8 * k));
		}
	}

	return (int) nOut;
}

static boolean GetIconSide (JSContext *ctx, JSValueConst Icon, const char *pKey, unsigned *pSide)
{
	JSValue Value = JS_GetPropertyStr (ctx, Icon, pKey);
	double f;
	boolean bOK =    JS_IsNumber (Value) && JS_ToFloat64 (ctx, &f, Value) == 0
		      && f >= 1 && f <= ZG_ICON_MAX_SIDE && f == (double) (unsigned) f;
	JS_FreeValue (ctx, Value);
	*pSide = bOK ? (unsigned) f : 0;
	return bOK;
}

// A picture icon: { "width", "height", "rgba" } (docs/APPS.md)
static boolean ParseIconPicture (JSContext *ctx, JSValueConst Icon, zg_app_t *pApp, CString *pError)
{
	JSPropertyEnum *pProps;
	uint32_t nProps;
	if (JS_GetOwnPropertyNames (ctx, &pProps, &nProps, Icon, JS_GPN_STRING_MASK) < 0)
	{
		*pError = "manifest.json: cannot read \"icon\"";
		return FALSE;
	}
	boolean bKeysOK = nProps == 3;
	for (uint32_t i = 0; i < nProps && bKeysOK; i++)
	{
		const char *pKey = JS_AtomToCString (ctx, pProps[i].atom);
		bKeysOK =    pKey != 0
			  && (   strcmp (pKey, "width") == 0 || strcmp (pKey, "height") == 0
			      || strcmp (pKey, "rgba") == 0);
		JS_FreeCString (ctx, pKey);
	}
	JS_FreePropertyEnum (ctx, pProps, nProps);
	if (!bKeysOK)
	{
		*pError = "manifest.json: a picture \"icon\" has exactly the keys \"width\", \"height\" and \"rgba\"";
		return FALSE;
	}

	unsigned nWidth, nHeight;
	if (   !GetIconSide (ctx, Icon, "width", &nWidth)
	    || !GetIconSide (ctx, Icon, "height", &nHeight))
	{
		pError->Format ("manifest.json: icon width and height must be whole numbers from 1 to %u",
				ZG_ICON_MAX_SIDE);
		return FALSE;
	}
	size_t nPixelBytes = nWidth * nHeight * 4;

	JSValue RGBA = JS_GetPropertyStr (ctx, Icon, "rgba");
	size_t nLength = 0;
	const char *p = JS_IsString (RGBA) ? JS_ToCStringLen (ctx, &nLength, RGBA) : 0;
	JS_FreeValue (ctx, RGBA);
	if (p == 0)
	{
		*pError = "manifest.json: icon \"rgba\" must be a base64 string";
		return FALSE;
	}

	// base64 of n bytes is 4 * ceil(n / 3) characters: refuse a length that
	// cannot be right before decoding anything
	size_t nMaxBytes = nLength / 4 * 3;
	if (nMaxBytes > nPixelBytes + 2)
	{
		JS_FreeCString (ctx, p);
		pError->Format ("manifest.json: icon \"rgba\" must hold width * height * 4 = %u bytes",
				(unsigned) nPixelBytes);
		return FALSE;
	}
	u8 *pPixels = new u8[nMaxBytes + 1];
	int nDecoded = DecodeBase64 (p, nLength, pPixels, nMaxBytes);
	JS_FreeCString (ctx, p);
	if (nDecoded < 0)
	{
		*pError = "manifest.json: icon \"rgba\" is not valid base64";
		delete [] pPixels;
		return FALSE;
	}
	if ((size_t) nDecoded != nPixelBytes)
	{
		pError->Format ("manifest.json: icon \"rgba\" must hold width * height * 4 = %u bytes",
				(unsigned) nPixelBytes);
		delete [] pPixels;
		return FALSE;
	}

	pApp->icon_rgba = pPixels;
	pApp->icon_width = nWidth;
	pApp->icon_height = nHeight;

	return TRUE;
}

// Fills pApp's metadata from manifest.json, with the checks of
// tools/bundle_apps.py.
static boolean ParseManifest (const zg_file_t *pManifest, const char *pFolder,
			      zg_app_t *pApp, CString *pError)
{
	static const char *Known[] = {"id", "name", "version", "description", "icon", "entry",
				      "permissions", "hidden"};

	JSRuntime *rt = CAppHost::NewRuntime ();
	JSContext *ctx = JS_NewContext (rt);
	assert (ctx != 0);

	boolean bOK = FALSE;
	char *pID = 0, *pIcon = 0, *pEntry = 0, *pDescription = 0;
	JSValue Obj = JS_ParseJSON (ctx, pManifest->data, pManifest->size, "manifest.json");
	do
	{
		if (JS_IsException (Obj))
		{
			JSValue Exc = JS_GetException (ctx);
			const char *pMsg = JS_ToCString (ctx, Exc);
			pError->Format ("manifest.json: %s", pMsg ? pMsg : "invalid JSON");
			JS_FreeCString (ctx, pMsg);
			JS_FreeValue (ctx, Exc);
			break;
		}
		if (!JS_IsObject (Obj) || JS_IsArray (ctx, Obj) || JS_IsFunction (ctx, Obj))
		{
			*pError = "manifest.json: must be a JSON object";
			break;
		}

		JSPropertyEnum *pProps;
		uint32_t nProps;
		if (JS_GetOwnPropertyNames (ctx, &pProps, &nProps, Obj, JS_GPN_STRING_MASK) < 0)
		{
			*pError = "manifest.json: cannot read";
			break;
		}
		boolean bKnown = TRUE;
		for (uint32_t i = 0; i < nProps && bKnown; i++)
		{
			const char *pKey = JS_AtomToCString (ctx, pProps[i].atom);
			bKnown = FALSE;
			for (unsigned k = 0; pKey && k < sizeof Known / sizeof Known[0]; k++)
			{
				bKnown = bKnown || strcmp (pKey, Known[k]) == 0;
			}
			if (!bKnown)
			{
				pError->Format ("manifest.json: unknown key \"%s\"", pKey ? pKey : "?");
			}
			JS_FreeCString (ctx, pKey);
		}
		JS_FreePropertyEnum (ctx, pProps, nProps);
		if (!bKnown)
		{
			break;
		}

		// "icon" is a symbol name or a picture
		JSValue Icon = JS_GetPropertyStr (ctx, Obj, "icon");
		boolean bPicture = JS_IsObject (Icon) && !JS_IsArray (ctx, Icon) && !JS_IsFunction (ctx, Icon);
		JS_FreeValue (ctx, Icon);

		char *pName = 0, *pVersion = 0;
		if (   !GetString (ctx, Obj, "id", 32, TRUE, &pID, pError)
		    || !GetString (ctx, Obj, "name", 64, TRUE, &pName, pError)
		    || !GetString (ctx, Obj, "version", 32, TRUE, &pVersion, pError)
		    || !GetString (ctx, Obj, "description", 256, FALSE, &pDescription, pError)
		    || (!bPicture && !GetString (ctx, Obj, "icon", 32, FALSE, &pIcon, pError))
		    || !GetString (ctx, Obj, "entry", 255, FALSE, &pEntry, pError))
		{
			delete [] pName;
			delete [] pVersion;
			break;
		}
		pApp->name = pName;
		pApp->version = pVersion;

		if (strcmp (pID, pFolder) != 0)
		{
			pError->Format ("manifest.json: id \"%s\" must match the folder name", pID);
			break;
		}

		const char *pSymbol = ZgSymbolByName (pIcon ? pIcon : "file");
		if (pSymbol == 0)
		{
			pError->Format ("manifest.json: unknown icon \"%s\"", pIcon);
			break;
		}
		pApp->icon = pSymbol;

		Icon = JS_GetPropertyStr (ctx, Obj, "icon");
		boolean bIconOK = !bPicture || ParseIconPicture (ctx, Icon, pApp, pError);
		JS_FreeValue (ctx, Icon);
		if (!bIconOK)
		{
			break;
		}

		pApp->permissions = 0;
		JSValue Perms = JS_GetPropertyStr (ctx, Obj, "permissions");
		boolean bPermsOK = TRUE;
		if (!JS_IsUndefined (Perms))
		{
			bPermsOK = JS_IsArray (ctx, Perms);
			uint32_t nLength = 0;
			if (bPermsOK)
			{
				JSValue Length = JS_GetPropertyStr (ctx, Perms, "length");
				bPermsOK = JS_ToUint32 (ctx, &nLength, Length) == 0 && nLength <= 8;
				JS_FreeValue (ctx, Length);
			}
			for (uint32_t i = 0; bPermsOK && i < nLength; i++)
			{
				JSValue Perm = JS_GetPropertyUint32 (ctx, Perms, i);
				const char *p = JS_IsString (Perm) ? JS_ToCString (ctx, Perm) : 0;
				if (p != 0 && strcmp (p, "apps") == 0)
				{
					pApp->permissions |= ZG_PERM_APPS;
				}
				else
				{
					bPermsOK = FALSE;
				}
				JS_FreeCString (ctx, p);
				JS_FreeValue (ctx, Perm);
			}
		}
		JS_FreeValue (ctx, Perms);
		if (!bPermsOK)
		{
			*pError = "manifest.json: \"permissions\" must be a list drawn from [\"apps\"]";
			break;
		}

		JSValue Hidden = JS_GetPropertyStr (ctx, Obj, "hidden");
		boolean bHiddenOK = JS_IsUndefined (Hidden) || JS_IsBool (Hidden);
		pApp->hidden = JS_IsBool (Hidden) && JS_ToBool (ctx, Hidden);
		JS_FreeValue (ctx, Hidden);
		if (!bHiddenOK)
		{
			*pError = "manifest.json: \"hidden\" must be true or false";
			break;
		}

		bOK = TRUE;
	}
	while (0);

	JS_FreeValue (ctx, Obj);
	JS_FreeContext (ctx);
	JS_FreeRuntime (rt);

	delete [] pIcon;
	if (bOK)
	{
		pApp->id = pID;
		pApp->entry = pEntry ? pEntry : StrDup ("main.js");
		pApp->description = pDescription ? pDescription : StrDup ("");
	}
	else
	{
		delete [] pID;
		delete [] pEntry;
		delete [] pDescription;
		delete [] (char *) pApp->name;
		delete [] (char *) pApp->version;
		delete [] pApp->icon_rgba;
		pApp->name = pApp->version = 0;
		pApp->icon_rgba = 0;
	}

	return bOK;
}

// --- loading ----------------------------------------------------------------

static char *HashApp (const zg_file_t *pFiles, unsigned nCount)
{
	// docs/APPS.md, "App hashes"; also tools/bundle_apps.py app_hash()
	zg_sha256_t Ctx;
	zg_sha256_init (&Ctx);
	for (unsigned i = 0; i < nCount; i++)
	{
		CString Size;
		Size.Format ("%u", pFiles[i].size);
		zg_sha256_update (&Ctx, pFiles[i].path, strlen (pFiles[i].path) + 1);
		zg_sha256_update (&Ctx, (const char *) Size, Size.GetLength () + 1);
		zg_sha256_update (&Ctx, pFiles[i].data, pFiles[i].size);
	}
	u8 Digest[ZG_SHA256_DIGEST_SIZE];
	zg_sha256_final (&Ctx, Digest);

	char *pHex = new char[2 * ZG_SHA256_DIGEST_SIZE + 1];
	static const char Digits[] = "0123456789abcdef";
	for (unsigned i = 0; i < ZG_SHA256_DIGEST_SIZE; i++)
	{
		pHex[2 * i] = Digits[Digest[i] >> 4];
		pHex[2 * i + 1] = Digits[Digest[i] & 15];
	}
	pHex[2 * ZG_SHA256_DIGEST_SIZE] = '\0';

	return pHex;
}

// Reads, checks and hashes the app in pDir (e.g. "SD:/apps/hello"), whose
// id must be pFolder; pLabel names it in the log. Returns 0 and the reason
// in *pError if it fails.
static zg_app_t *ReadApp (const char *pDir, const char *pLabel, const char *pFolder,
			  CString *pError)
{
	TFileList List;
	List.pFiles = new zg_file_t[MaxFiles];
	List.nCount = 0;
	List.nTotalSize = 0;

	if (!ReadFolder (pDir, "", 1, &List, pError))
	{
		FreeFiles (&List);
		return 0;
	}
	SortFiles (&List);

	const zg_file_t *pManifest = FindFile (&List, "manifest.json");
	if (pManifest == 0)
	{
		*pError = "no manifest.json";
		FreeFiles (&List);
		return 0;
	}

	zg_app_t *pApp = new zg_app_t;
	memset (pApp, 0, sizeof *pApp);
	if (!ParseManifest (pManifest, pFolder, pApp, pError))
	{
		delete pApp;
		FreeFiles (&List);
		return 0;
	}
	if (FindFile (&List, pApp->entry) == 0)
	{
		pError->Format ("entry module \"%s\" not found", pApp->entry);
		delete [] (char *) pApp->id;
		delete [] (char *) pApp->name;
		delete [] (char *) pApp->version;
		delete [] (char *) pApp->description;
		delete [] (char *) pApp->entry;
		delete [] pApp->icon_rgba;
		delete pApp;
		FreeFiles (&List);
		return 0;
	}

	pApp->files = List.pFiles;
	pApp->file_count = List.nCount;
	pApp->hash = HashApp (List.pFiles, List.nCount);
	pApp->source = ZG_APP_SDCARD;

	CLogger::Get ()->Write (From, LogNotice, "%s: %s %s, %u files, %u bytes, sha256 %s",
				pLabel, pApp->id, pApp->version, List.nCount, List.nTotalSize,
				pApp->hash);

	return pApp;
}

static void LoadApp (const char *pFolder)
{
	if (!IsValidID (pFolder))
	{
		AddProblem (pFolder, "the folder name must be an app id: a-z, 0-9 and -, at most 32");
		return;
	}
	if (CAppStore::Find (pFolder) != 0)
	{
		AddProblem (pFolder, "an app with this id is built in");
		return;
	}

	CString Dir, Label;
	Dir.Format ("SD:/apps/%s", pFolder);
	Label.Format ("apps/%s", pFolder);
	CString Error;
	zg_app_t *pApp = ReadApp (Dir, Label, pFolder, &Error);
	if (pApp == 0)
	{
		AddProblem (pFolder, Error);
		return;
	}

	s_ppApps[s_nApps++] = pApp;
}

static void LoadCard (void)
{
	static FATFS FileSystem;		// stays mounted: f_open needs it
	if (f_mount (&FileSystem, "SD:", 1) != FR_OK)
	{
		s_CardStatus = ZgCardUnreadable;
		CLogger::Get ()->Write (From, LogWarning, "SD card: no FAT file system");
		return;
	}

	DIR Dir;
	if (f_opendir (&Dir, "SD:/apps") != FR_OK)
	{
		s_CardStatus = ZgCardNoApps;
		CLogger::Get ()->Write (From, LogNotice, "SD card: no /apps folder");
		return;
	}

	// the folder names, sorted: the launcher lists apps in this order
	char *Folders[MaxCardApps];
	unsigned nFolders = 0;
	FILINFO Info;
	while (f_readdir (&Dir, &Info) == FR_OK && Info.fname[0] != '\0')
	{
		if (!(Info.fattrib & AM_DIR) || Info.fname[0] == '.')
		{
			continue;
		}
		if (nFolders == MaxCardApps)
		{
			AddProblem (Info.fname, "too many apps on the card");
			continue;
		}

		char *pName = StrDup (Info.fname);
		unsigned j = nFolders++;
		for (; j > 0 && strcmp (Folders[j - 1], pName) > 0; j--)
		{
			Folders[j] = Folders[j - 1];
		}
		Folders[j] = pName;
	}
	f_closedir (&Dir);

	s_CardStatus = ZgCardOK;
	for (unsigned i = 0; i < nFolders; i++)
	{
		LoadApp (Folders[i]);
		delete [] Folders[i];
	}
}

#ifdef ZG_SIM

// The simulator can replace a built-in app with a folder of the same name
// in its "builtin" folder (zgsim --builtin DIR, the IDE's copy of the
// launcher), to work on the launcher without rebuilding. The replacement
// gets the built-in app's rights; if it fails a check, the built-in app
// stays. The Pi has no such folder: built-in apps come only from the
// kernel image.
static const zg_app_t *SimReplacement (const zg_app_t *pBuiltin)
{
	CString Dir, Label;
	Dir.Format ("SIM:/%s", pBuiltin->id);
	Label.Format ("builtin/%s", pBuiltin->id);

	DIR Probe;
	if (f_opendir (&Probe, Dir) != FR_OK)
	{
		return pBuiltin;
	}
	f_closedir (&Probe);

	CString Error;
	zg_app_t *pApp = ReadApp (Dir, Label, pBuiltin->id, &Error);
	if (pApp == 0)
	{
		CLogger::Get ()->Write (From, LogWarning, "%s not loaded: %s; using the built-in %s",
					(const char *) Label, (const char *) Error, pBuiltin->id);
		return pBuiltin;
	}

	pApp->source = ZG_APP_BUILTIN;
	CLogger::Get ()->Write (From, LogNotice, "%s replaces the built-in %s (simulator only)",
				(const char *) Label, pBuiltin->id);
	return pApp;
}

#endif	// ZG_SIM

#endif	// !ZG_SEALED

void CAppStore::Initialize (boolean bCardPresent)
{
	assert (s_ppApps == 0);
	s_ppApps = new const zg_app_t *[zg_builtin_app_count + MaxCardApps];

	for (unsigned i = 0; i < zg_builtin_app_count; i++)
	{
		const zg_app_t *pApp = &zg_builtin_apps[i];
#if defined (ZG_SIM) && !defined (ZG_SEALED)
		pApp = SimReplacement (pApp);
#endif
		s_ppApps[s_nApps++] = pApp;
	}
	CLogger::Get ()->Write (From, LogNotice, "%u app(s) built in", zg_builtin_app_count);

#ifndef ZG_SEALED
	if (!bCardPresent)
	{
		s_CardStatus = ZgCardNone;
		CLogger::Get ()->Write (From, LogNotice, "No SD card");
		return;
	}

	LoadCard ();

	CLogger::Get ()->Write (From, LogNotice, "%u app(s) from the SD card, %u not loaded",
				s_nApps - zg_builtin_app_count, s_nProblems);
#else
	s_CardStatus = ZgCardDisabled;
#endif
}
