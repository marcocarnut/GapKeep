//
// appstore.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "appstore.h"
#include "apphost.h"
#include "clock.h"
#include "settings.h"
#include "i18n.h"
#include "textcheck.h"
#include "../crypto/sha256.h"
#include <circle/logger.h>
#include <circle/util.h>
#include <circle/string.h>
#include <circle/timer.h>
#include <assert.h>

#ifndef GK_SEALED
#include "cardfs.h"			// FatFs (read-only), at boot only
#endif

static const char From[] = "appstore";

// Limits for apps on the card. Generous for real apps, but a card full of
// junk must not exhaust memory or stall the boot.
static const unsigned MaxCardApps = 64;
static const unsigned MaxFiles = 256;			// per app
static const unsigned MaxFileSize = 4 * 1024 * 1024;
static const unsigned MaxAppSize = 16 * 1024 * 1024;	// all files of one app
// all the apps' files read from the card, those of refused apps too (their
// memory may not come back: Circle's heap keeps blocks larger than 512 KB),
// so a card can't take the memory the system needs at boot
static const unsigned MaxCardAppBytes = 64 * 1024 * 1024;
static const unsigned MaxDepth = 8;			// folder levels inside an app
static const unsigned MaxNameLength = 64;		// of one file or folder name
static const unsigned MaxProblems = 16;
static const unsigned MaxSuites = 16;

// Limits for data folders (data/<name>, gk:data); docs/APPS.md, "Data files"
static const unsigned MaxDataFiles = 256;		// per folder
static const unsigned MaxDataFileSize = 4 * 1024 * 1024;
static const unsigned MaxDataSize = 8 * 1024 * 1024;	// all files of one folder
static const unsigned MaxDataNameLength = 128;		// of one file or folder name
static const unsigned MaxDataFolders = 32;		// read (at boot, kept until power-off)
static const unsigned MaxDataEntries = 64;		// read or refused
static const unsigned MaxDataTotal = 32 * 1024 * 1024;	// all folders read
static const unsigned MaxDataBytesRead = 48 * 1024 * 1024; // all files read, refused folders' too

static const gk_app_t **s_ppApps = 0;
static unsigned s_nApps = 0;
static const gk_app_t *s_pSuites[MaxSuites];
static unsigned s_nSuites = 0;
static TGkCardStatus s_CardStatus = GkCardDisabled;

static void CloseCard (void);		// at the end of boot

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

const gk_app_t *CAppStore::Get (unsigned nIndex)
{
	return nIndex < s_nApps ? s_ppApps[nIndex] : 0;
}

boolean CAppStore::IsAvailable (const gk_app_t *pApp)
{
	return !pApp->experimental || CGkSettings::IsExperimental ();
}

const gk_app_t *CAppStore::Find (const char *pID)
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

unsigned CAppStore::GetSuiteCount (void)
{
	return s_nSuites;
}

const gk_app_t *CAppStore::GetSuite (unsigned nIndex)
{
	return nIndex < s_nSuites ? s_pSuites[nIndex] : 0;
}

const gk_app_t *CAppStore::FindSuite (const char *pID)
{
	for (unsigned i = 0; i < s_nSuites; i++)
	{
		if (strcmp (s_pSuites[i]->id, pID) == 0)
		{
			return s_pSuites[i];
		}
	}

	return 0;
}

TGkCardStatus CAppStore::GetCardStatus (void)
{
	return s_CardStatus;
}

const char *CAppStore::GetCardStatusName (void)
{
	switch (s_CardStatus)
	{
	case GkCardDisabled:	return "disabled";
	case GkCardNone:	return "none";
	case GkCardUnreadable:	return "unreadable";
	case GkCardNoApps:	return "no-apps";
	case GkCardOK:		return "ok";
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

// --- checks shared with tools/bundle_apps.py --------------------------------

boolean CAppStore::IsValidID (const char *p)
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

#ifndef GK_SEALED

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

// Names in a data folder: printable ASCII but '/' and '\' (any file type,
// so "alice@example.org.asc" and "Bob's key.pgp" are fine). Those starting
// with '.' are skipped, as in apps.
static boolean IsValidDataName (const char *p)
{
	if (*p == '\0' || strlen (p) > MaxDataNameLength)
	{
		return FALSE;
	}
	for (; *p; p++)
	{
		if (*p < 0x20 || *p > 0x7E || *p == '/' || *p == '\\')
		{
			return FALSE;
		}
	}

	return TRUE;
}

#endif	// !GK_SEALED

// Strict UTF-8, as Python's bytes.decode('utf-8'): no overlong forms, no
// surrogates, nothing above U+10FFFF. NUL bytes are rejected too.
boolean CAppStore::IsValidUTF8 (const u8 *p, unsigned n)
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

// --- data folders: what was read at boot -------------------------------------

// Each data folder some app lists, read at boot (from the kernel image or
// the card), or the reason it could not be. A folder no app lists, or that
// isn't there, has no entry: gk:data finds nothing (GkDataMissing).
struct TDataFolder
{
	const char *pName;
	TGkDataStatus Status;		// GkDataOK or GkDataError
	const gk_file_t *pFiles;	// GkDataOK: sorted by path
	unsigned nCount;
	unsigned nSize;
	const char *pHash;		// GkDataOK
	const char *pError;		// GkDataError
};

static TDataFolder s_Data[MaxDataEntries];
static unsigned s_nData = 0;
static unsigned s_nDataOK = 0;		// of them, read
static unsigned s_nDataBytes = 0;	// all folders read

static TDataFolder *FindData (const char *pName)
{
	for (unsigned i = 0; i < s_nData; i++)
	{
		if (strcmp (s_Data[i].pName, pName) == 0)
		{
			return &s_Data[i];
		}
	}

	return 0;
}

// The data folders built into the kernel (sealed builds with DATA=dir)
static void AddBuiltinData (void)
{
	for (unsigned i = 0; i < gk_builtin_data_count && s_nData < MaxDataEntries; i++)
	{
		const gk_data_t *pBuiltin = &gk_builtin_data[i];
		TDataFolder *pData = &s_Data[s_nData++];
		pData->pName = pBuiltin->name;
		pData->Status = GkDataOK;
		pData->pFiles = pBuiltin->files;
		pData->nCount = pBuiltin->file_count;
		pData->nSize = pBuiltin->size;
		pData->pHash = pBuiltin->hash;
		pData->pError = 0;
		s_nDataOK++;
		s_nDataBytes += pBuiltin->size;
		// names and sizes only: the contents may be private
		CLogger::Get ()->Write (From, LogNotice, "data/%s (built in): %u files, %u bytes, sha256 %s",
					pData->pName, pData->nCount, pData->nSize, pData->pHash);
	}
}

#ifndef GK_SEALED

// A refused folder: kept, so gk:data and the launcher can say why
static void AddDataError (const char *pName, const char *pError)
{
	CLogger::Get ()->Write (From, LogWarning, "data/%s: %s", pName, pError);
	if (s_nData < MaxDataEntries)
	{
		TDataFolder *pData = &s_Data[s_nData++];
		memset (pData, 0, sizeof *pData);
		pData->pName = StrDup (pName);
		pData->Status = GkDataError;
		pData->pError = StrDup (pError);
	}
}

static void AddProblem (const char *pFolder, const char *pText)
{
	// shown by the launcher, and logged: a folder's or file's name from
	// the card could hold anything FAT allows (control characters, bidi
	// controls, invisible characters): those become '?'
	char *pShownFolder = StrDup (pFolder);
	char *pShownText = StrDup (pText);
	gk_text_sanitise (pShownFolder);
	gk_text_sanitise (pShownText);

	CLogger::Get ()->Write (From, LogWarning, "apps/%s not loaded: %s", pShownFolder, pShownText);

	if (s_nProblems < MaxProblems)
	{
		s_Problems[s_nProblems].pFolder = pShownFolder;
		s_Problems[s_nProblems].pText = pShownText;
		s_nProblems++;
	}
	else
	{
		delete [] pShownFolder;
		delete [] pShownText;
	}
}

// --- reading an app or data folder ------------------------------------------

// What a folder may hold
struct TReadRules
{
	boolean bData;			// a data folder: any file, binary, IsValidDataName
	unsigned nMaxFiles;
	unsigned nMaxFileSize;
	unsigned nMaxTotal;
	const char *pWhat;		// "app" or "folder", for the messages
	unsigned *pnRead;		// bytes read so far by all folders of this kind
	unsigned nMaxRead;		// ... at most
	const char *pAll;		// what that is, for the message
};

static unsigned s_nCardAppBytes = 0;
static unsigned s_nDataBytesRead = 0;
static const TReadRules AppRules = {FALSE, MaxFiles, MaxFileSize, MaxAppSize, "app",
				    &s_nCardAppBytes, MaxCardAppBytes, "the apps on the card"};
static const TReadRules DataRules = {TRUE, MaxDataFiles, MaxDataFileSize, MaxDataSize, "folder",
				     &s_nDataBytesRead, MaxDataBytesRead, "the data folders"};

struct TFileList
{
	const TReadRules *pRules;
	gk_file_t *pFiles;		// pRules->nMaxFiles entries
	unsigned nCount;
	unsigned nTotalSize;
};

static void InitFiles (TFileList *pList, const TReadRules *pRules)
{
	pList->pRules = pRules;
	pList->pFiles = new gk_file_t[pRules->nMaxFiles];
	pList->nCount = 0;
	pList->nTotalSize = 0;
}

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

static boolean ReadFile (const char *pFullPath, const char *pRelPath, FSIZE_t nFileSize,
			 TFileList *pList, CString *pError)
{
	const TReadRules *pRules = pList->pRules;
	if (pList->nCount >= pRules->nMaxFiles)
	{
		pError->Format ("more than %u files", pRules->nMaxFiles);
		return FALSE;
	}
	if (   nFileSize > pRules->nMaxFileSize
	    || pList->nTotalSize + (unsigned) nFileSize > pRules->nMaxTotal)
	{
		pError->Format ("%s: too large (at most %u MB per file, %u MB per %s)",
				pRelPath, pRules->nMaxFileSize >> 20, pRules->nMaxTotal >> 20,
				pRules->pWhat);
		return FALSE;
	}
	if (*pRules->pnRead + (unsigned) nFileSize > pRules->nMaxRead)
	{
		pError->Format ("%s: %s would take more than %u MB in all", pRelPath,
				pRules->pAll, pRules->nMaxRead >> 20);
		return FALSE;
	}
	unsigned nSize = (unsigned) nFileSize;
	*pRules->pnRead += nSize;		// counted even if this folder is refused

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

	if (!pRules->bData && !CAppStore::IsValidUTF8 ((const u8 *) pData, nSize))
	{
		delete [] pData;
		pError->Format ("%s: not valid UTF-8 text", pRelPath);
		return FALSE;
	}

	gk_file_t *pFile = &pList->pFiles[pList->nCount++];
	pFile->path = StrDup (pRelPath);
	pFile->data = pData;
	pFile->size = nSize;
	pList->nTotalSize += nSize;

	return TRUE;
}

// Reads the files in pDir (on the card) and below, as pList's rules say:
// an app's (.js, .json, .txt) or a data folder's (all); pRel is pDir
// relative to the app or data folder ("" at the top).
static boolean ReadFolder (const char *pDir, const char *pRel, unsigned nDepth,
			   TFileList *pList, CString *pError)
{
	boolean bData = pList->pRules->bData;

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
		if (!bDir && !bData && !IsAppFile (Info.fname))
		{
			continue;	// not part of the app
		}

		CString Rel;
		Rel.Format ("%s%s%s", pRel, *pRel ? "/" : "", Info.fname);
		if (bData ? !IsValidDataName (Info.fname) : !IsValidName (Info.fname))
		{
			pError->Format (bData ? "%s: names may only be printable ASCII, without / and \\"
					      : "%s: name may only contain A-Z a-z 0-9 . _ -", (const char *) Rel);
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
			bOK = ReadFile (Full, Rel, Info.fsize, pList, pError);
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
		gk_file_t Tmp = pList->pFiles[i];
		unsigned j = i;
		for (; j > 0 && strcmp (pList->pFiles[j - 1].path, Tmp.path) > 0; j--)
		{
			pList->pFiles[j] = pList->pFiles[j - 1];
		}
		pList->pFiles[j] = Tmp;
	}
}

static const gk_file_t *FindFile (const TFileList *pList, const char *pPath)
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
// wrong type, is empty or too long, or, if bShown (what the launcher shows:
// name, version, description), holds a line break or another character
// that could change how the text around it reads (textcheck.h); *ppValue
// stays 0 if it is absent.
static boolean GetString (JSContext *ctx, JSValueConst Obj, const char *pKey, unsigned nMaxLength,
			  boolean bRequired, char **ppValue, CString *pError, boolean bShown = FALSE)
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
			if (bShown && !gk_text_is_clean (p, nLength, 0))
			{
				pError->Format ("manifest.json: \"%s\" must be text on one line, without"
						" control, bidi or invisible characters", pKey);
				JS_FreeCString (ctx, p);
				JS_FreeValue (ctx, Value);
				return FALSE;
			}
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
		      && f >= 1 && f <= GK_ICON_MAX_SIDE && f == (double) (unsigned) f;
	JS_FreeValue (ctx, Value);
	*pSide = bOK ? (unsigned) f : 0;
	return bOK;
}

// A picture icon: { "width", "height", "rgba" } (docs/APPS.md)
static boolean ParseIconPicture (JSContext *ctx, JSValueConst Icon, gk_app_t *pApp, CString *pError)
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
				GK_ICON_MAX_SIDE);
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

// The manifest's "data": at most GK_MAX_APP_DATA different folder names
static boolean ParseData (JSContext *ctx, JSValueConst Obj, gk_app_t *pApp, CString *pError)
{
	JSValue Data = JS_GetPropertyStr (ctx, Obj, "data");
	if (JS_IsUndefined (Data))
	{
		return TRUE;
	}

	boolean bOK = JS_IsArray (ctx, Data);
	uint32_t nLength = 0;
	if (bOK)
	{
		JSValue Length = JS_GetPropertyStr (ctx, Data, "length");
		bOK = JS_ToUint32 (ctx, &nLength, Length) == 0 && nLength <= GK_MAX_APP_DATA;
		JS_FreeValue (ctx, Length);
	}
	char **ppNames = new char *[GK_MAX_APP_DATA];
	unsigned nNames = 0;
	for (uint32_t i = 0; bOK && i < nLength; i++)
	{
		JSValue Name = JS_GetPropertyUint32 (ctx, Data, i);
		const char *p = JS_IsString (Name) ? JS_ToCString (ctx, Name) : 0;
		bOK = p != 0 && CAppStore::IsValidID (p);
		for (unsigned k = 0; bOK && k < nNames; k++)
		{
			bOK = strcmp (ppNames[k], p) != 0;
		}
		if (bOK)
		{
			ppNames[nNames++] = StrDup (p);
		}
		JS_FreeCString (ctx, p);
		JS_FreeValue (ctx, Name);
	}
	JS_FreeValue (ctx, Data);

	if (!bOK)
	{
		for (unsigned k = 0; k < nNames; k++)
		{
			delete [] ppNames[k];
		}
		delete [] ppNames;
		pError->Format ("manifest.json: \"data\" must be a list of at most %u different folder"
				" names (a-z, 0-9 and -, at most 32)", GK_MAX_APP_DATA);
		return FALSE;
	}

	pApp->data = ppNames;
	pApp->data_count = nNames;

	return TRUE;
}

// One "vvvv:pppp" of the manifest's "usb": four lowercase hex digits each
static boolean ParseUSBID (const char *p, unsigned *pID)
{
	if (strlen (p) != 9 || p[4] != ':')
	{
		return FALSE;
	}
	unsigned nID = 0;
	for (unsigned i = 0; i < 9; i++)
	{
		if (i == 4)
		{
			continue;
		}
		char c = p[i];
		unsigned d;
		if (c >= '0' && c <= '9')
		{
			d = c - '0';
		}
		else if (c >= 'a' && c <= 'f')
		{
			d = c - 'a' + 10;
		}
		else
		{
			return FALSE;
		}
		nID = nID << 4 | d;
	}
	*pID = nID;
	return TRUE;
}

// The manifest's "usb": 1 to GK_MAX_APP_USB different device ids
static boolean ParseUSB (JSContext *ctx, JSValueConst Obj, gk_app_t *pApp, CString *pError)
{
	JSValue USB = JS_GetPropertyStr (ctx, Obj, "usb");
	if (JS_IsUndefined (USB))
	{
		return TRUE;
	}

	boolean bOK = JS_IsArray (ctx, USB);
	uint32_t nLength = 0;
	if (bOK)
	{
		JSValue Length = JS_GetPropertyStr (ctx, USB, "length");
		bOK = JS_ToUint32 (ctx, &nLength, Length) == 0 && nLength <= GK_MAX_APP_USB;
		JS_FreeValue (ctx, Length);
	}
	unsigned *pIDs = new unsigned[GK_MAX_APP_USB];
	unsigned nIDs = 0;
	for (uint32_t i = 0; bOK && i < nLength; i++)
	{
		JSValue ID = JS_GetPropertyUint32 (ctx, USB, i);
		const char *p = JS_IsString (ID) ? JS_ToCString (ctx, ID) : 0;
		unsigned nID = 0;
		bOK = p != 0 && ParseUSBID (p, &nID) && nID != 0;
		for (unsigned k = 0; bOK && k < nIDs; k++)
		{
			bOK = pIDs[k] != nID;
		}
		if (bOK)
		{
			pIDs[nIDs++] = nID;
		}
		JS_FreeCString (ctx, p);
		JS_FreeValue (ctx, ID);
	}
	JS_FreeValue (ctx, USB);

	if (!bOK || nIDs == 0)
	{
		delete [] pIDs;
		pError->Format ("manifest.json: \"usb\" must be a list of 1 to %u different USB device"
				" ids, \"vvvv:pppp\" in lowercase hex (\"16c0:27db\")", GK_MAX_APP_USB);
		return FALSE;
	}

	pApp->usb = pIDs;
	pApp->usb_count = nIDs;

	return TRUE;
}

// What ParseManifest allocated (pApp itself is the caller's)
static void FreeMetadata (gk_app_t *pApp)
{
	delete [] (char *) pApp->id;
	delete [] (char *) pApp->name;
	delete [] (char *) pApp->version;
	delete [] (char *) pApp->description;
	delete [] (char *) pApp->entry;
	delete [] pApp->icon_rgba;
	for (unsigned i = 0; i < pApp->data_count; i++)
	{
		delete [] (char *) pApp->data[i];
	}
	delete [] pApp->data;
	delete [] pApp->usb;
	pApp->usb = 0;
	pApp->usb_count = 0;
	pApp->id = pApp->name = pApp->version = pApp->description = pApp->entry = 0;
	pApp->icon_rgba = 0;
	pApp->data = 0;
	pApp->data_count = 0;
}

// Fills pApp's metadata from manifest.json, with the checks of
// tools/bundle_apps.py; or, if bSuite, from a suite's suite.json (id, name,
// description, icon).
static boolean ParseManifest (const gk_file_t *pManifest, const char *pFolder,
			      gk_app_t *pApp, CString *pError, boolean bSuite = FALSE)
{
	static const char *AppKeys[] = {"id", "name", "version", "description", "icon", "entry",
					"permissions", "hidden", "experimental", "data", "usb", 0};
	static const char *SuiteKeys[] = {"id", "name", "description", "icon", 0};
	const char **Known = bSuite ? SuiteKeys : AppKeys;

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
			for (unsigned k = 0; pKey && Known[k] != 0; k++)
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
		    || !GetString (ctx, Obj, "name", 64, TRUE, &pName, pError, TRUE)
		    || !GetString (ctx, Obj, "version", 32, !bSuite, &pVersion, pError, TRUE)
		    || !GetString (ctx, Obj, "description", 256, FALSE, &pDescription, pError, TRUE)
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

		const char *pSymbol = GkSymbolByName (pIcon ? pIcon : "file");
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
					pApp->permissions |= GK_PERM_APPS;
				}
				else if (p != 0 && strcmp (p, "camera") == 0)
				{
					pApp->permissions |= GK_PERM_CAMERA;
				}
				else if (p != 0 && strcmp (p, "rtc") == 0)
				{
					pApp->permissions |= GK_PERM_RTC;
				}
				else if (p != 0 && strcmp (p, "settings") == 0)
				{
					pApp->permissions |= GK_PERM_SETTINGS;
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
			*pError = "manifest.json: \"permissions\" must be a list drawn from [\"apps\", \"camera\", \"rtc\", \"settings\"]";
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

		JSValue Experimental = JS_GetPropertyStr (ctx, Obj, "experimental");
		boolean bExperimentalOK = JS_IsUndefined (Experimental) || JS_IsBool (Experimental);
		pApp->experimental = JS_IsBool (Experimental) && JS_ToBool (ctx, Experimental);
		JS_FreeValue (ctx, Experimental);
		if (!bExperimentalOK)
		{
			*pError = "manifest.json: \"experimental\" must be true or false";
			break;
		}

		if (!ParseData (ctx, Obj, pApp, pError))
		{
			break;
		}

		if (!ParseUSB (ctx, Obj, pApp, pError))
		{
			break;
		}

		bOK = TRUE;
	}
	while (0);

	JS_FreeValue (ctx, Obj);
	JS_FreeContext (ctx);
	JS_FreeRuntime (rt);

	delete [] pIcon;
	pApp->id = pID;
	pApp->entry = pEntry ? pEntry : StrDup (bSuite ? "" : "main.js");
	pApp->description = pDescription ? pDescription : StrDup ("");
	if (pApp->version == 0)
	{
		pApp->version = StrDup ("");		// a suite has none
	}
	if (!bOK)
	{
		FreeMetadata (pApp);
	}

	if (!bOK && bSuite && strncmp (*pError, "manifest.json:", 14) == 0)
	{
		// the messages above name the app's file
		CString Error;
		Error.Format ("suite.json:%s", (const char *) *pError + 14);
		*pError = Error;
	}

	return bOK;
}

// --- loading ----------------------------------------------------------------

static char *HashApp (const gk_file_t *pFiles, unsigned nCount)
{
	// docs/APPS.md, "App hashes"; also tools/bundle_apps.py app_hash()
	gk_sha256_t Ctx;
	gk_sha256_init (&Ctx);
	for (unsigned i = 0; i < nCount; i++)
	{
		CString Size;
		Size.Format ("%u", pFiles[i].size);
		gk_sha256_update (&Ctx, pFiles[i].path, strlen (pFiles[i].path) + 1);
		gk_sha256_update (&Ctx, (const char *) Size, Size.GetLength () + 1);
		gk_sha256_update (&Ctx, pFiles[i].data, pFiles[i].size);
	}
	u8 Digest[GK_SHA256_DIGEST_SIZE];
	gk_sha256_final (&Ctx, Digest);

	char *pHex = new char[2 * GK_SHA256_DIGEST_SIZE + 1];
	static const char Digits[] = "0123456789abcdef";
	for (unsigned i = 0; i < GK_SHA256_DIGEST_SIZE; i++)
	{
		pHex[2 * i] = Digits[Digest[i] >> 4];
		pHex[2 * i + 1] = Digits[Digest[i] & 15];
	}
	pHex[2 * GK_SHA256_DIGEST_SIZE] = '\0';

	return pHex;
}

// Reads, checks and hashes the app in pDir (e.g. "SD:/apps/hello"), whose
// id must be pFolder; pLabel names it in the log. Returns 0 and the reason
// in *pError if it fails.
static gk_app_t *ReadApp (const char *pDir, const char *pLabel, const char *pFolder,
			  CString *pError)
{
	TFileList List;
	InitFiles (&List, &AppRules);

	if (!ReadFolder (pDir, "", 1, &List, pError))
	{
		FreeFiles (&List);
		return 0;
	}
	SortFiles (&List);

	const gk_file_t *pManifest = FindFile (&List, "manifest.json");
	if (pManifest == 0)
	{
		*pError = "no manifest.json";
		FreeFiles (&List);
		return 0;
	}

	gk_app_t *pApp = new gk_app_t;
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
		FreeMetadata (pApp);
		delete pApp;
		FreeFiles (&List);
		return 0;
	}

	pApp->files = List.pFiles;
	pApp->file_count = List.nCount;
	pApp->hash = HashApp (List.pFiles, List.nCount);
	pApp->source = GK_APP_SDCARD;

	CLogger::Get ()->Write (From, LogNotice, "%s: %s %s, %u files, %u bytes, sha256 %s",
				pLabel, pApp->id, pApp->version, List.nCount, List.nTotalSize,
				pApp->hash);

	return pApp;
}

// Why the id pID can't be used for an app or suite, or 0 if it can
static const char *TakenBecause (const char *pID, CString *pWhy)
{
	const gk_app_t *pOther = CAppStore::Find (pID);
	if (pOther != 0 && pOther->source != GK_APP_SDCARD)
	{
		*pWhy = "an app with this id is built in";
	}
	else if (pOther != 0)
	{
		pWhy->Format ("an app with this id was loaded from apps/%s%s%s",
			      pOther->suite ? pOther->suite : "", pOther->suite ? "/" : "", pID);
	}
	else if (CAppStore::FindSuite (pID) != 0)
	{
		pWhy->Format ("apps/%s is a suite with this id", pID);
	}
	else
	{
		return 0;
	}

	return *pWhy;
}

// Loads apps/<pFolder>, or apps/<pSuite>/<pFolder> for an app of a suite.
static void LoadApp (const gk_app_t *pSuite, const char *pFolder)
{
	CString Where;		// relative to /apps
	Where.Format ("%s%s%s", pSuite ? pSuite->id : "", pSuite ? "/" : "", pFolder);

	CString Why;
	if (!CAppStore::IsValidID (pFolder))
	{
		AddProblem (Where, "the folder name must be an app id: a-z, 0-9 and -, at most 32");
		return;
	}
	if (TakenBecause (pFolder, &Why) != 0)
	{
		AddProblem (Where, Why);
		return;
	}
	if (s_nApps >= gk_builtin_app_count + MaxCardApps)
	{
		AddProblem (Where, "too many apps on the card");
		return;
	}

	CString Dir, Label;
	Dir.Format ("SD:/apps/%s", (const char *) Where);
	Label.Format ("apps/%s", (const char *) Where);
	CString Error;
	gk_app_t *pApp = ReadApp (Dir, Label, pFolder, &Error);
	if (pApp == 0)
	{
		AddProblem (Where, Error);
		return;
	}
	pApp->suite = pSuite ? pSuite->id : 0;

	s_ppApps[s_nApps++] = pApp;
}

// The names of the folders in pDir, sorted (the launcher lists apps in this
// order), at most nMax; those starting with '.' and pSkip are left out.
// pWhere: pDir relative to /apps, for the problems ("" at the top).
static unsigned ListFolders (const char *pDir, const char *pWhere, const char *pSkip,
			     char **ppFolders, unsigned nMax)
{
	DIR Dir;
	if (f_opendir (&Dir, pDir) != FR_OK)
	{
		return 0;
	}

	unsigned nFolders = 0;
	FILINFO Info;
	while (f_readdir (&Dir, &Info) == FR_OK && Info.fname[0] != '\0')
	{
		if (   !(Info.fattrib & AM_DIR) || Info.fname[0] == '.'
		    || (pSkip != 0 && strcmp (Info.fname, pSkip) == 0))
		{
			continue;
		}
		if (nFolders == nMax)
		{
			CString Where;
			Where.Format ("%s%s%s", pWhere, *pWhere ? "/" : "", Info.fname);
			AddProblem (Where, "too many apps on the card");
			continue;
		}

		char *pName = StrDup (Info.fname);
		unsigned j = nFolders++;
		for (; j > 0 && strcmp (ppFolders[j - 1], pName) > 0; j--)
		{
			ppFolders[j] = ppFolders[j - 1];
		}
		ppFolders[j] = pName;
	}
	f_closedir (&Dir);

	return nFolders;
}

// The entry pName in the folder pDir (exact name), FALSE if none
static boolean FindEntry (const char *pDir, const char *pName, FILINFO *pInfo)
{
	DIR Dir;
	if (f_opendir (&Dir, pDir) != FR_OK)
	{
		return FALSE;
	}
	boolean bFound = FALSE;
	while (!bFound && f_readdir (&Dir, pInfo) == FR_OK && pInfo->fname[0] != '\0')
	{
		bFound = strcmp (pInfo->fname, pName) == 0;
	}
	f_closedir (&Dir);

	return bFound;
}

static boolean HasFile (const char *pDir, const char *pName)
{
	FILINFO Info;
	return FindEntry (pDir, pName, &Info) && !(Info.fattrib & AM_DIR);
}

// apps/<pFolder>, which has a suite.json: the suite, then each of its apps
// (its sub-folders but lang/, which holds the suite's translations)
static void LoadSuite (const char *pFolder)
{
	CString Why;
	if (!CAppStore::IsValidID (pFolder))
	{
		AddProblem (pFolder, "the folder name must be a suite id: a-z, 0-9 and -, at most 32");
		return;
	}
	if (TakenBecause (pFolder, &Why) != 0)
	{
		AddProblem (pFolder, Why);
		return;
	}
	if (s_nSuites == MaxSuites)
	{
		AddProblem (pFolder, "too many suites on the card");
		return;
	}

	// suite.json and lang/*.json: what the launcher shows
	TFileList List;
	InitFiles (&List, &AppRules);
	CString Dir, Path, Error;
	Dir.Format ("SD:/apps/%s", pFolder);
	Path.Format ("%s/suite.json", (const char *) Dir);
	FILINFO Info;
	boolean bOK = FindEntry (Dir, "suite.json", &Info);
	if (!bOK)
	{
		Error = "suite.json: cannot open";
	}
	bOK = bOK && ReadFile (Path, "suite.json", Info.fsize, &List, &Error);
	Path.Format ("%s/lang", (const char *) Dir);
	DIR Probe;
	if (bOK && f_opendir (&Probe, Path) == FR_OK)
	{
		f_closedir (&Probe);
		bOK = ReadFolder (Path, "lang", 2, &List, &Error);
	}
	gk_app_t *pSuite = 0;
	if (bOK)
	{
		SortFiles (&List);
		pSuite = new gk_app_t;
		memset (pSuite, 0, sizeof *pSuite);
		bOK = ParseManifest (FindFile (&List, "suite.json"), pFolder, pSuite, &Error, TRUE);
	}
	if (!bOK)
	{
		delete pSuite;
		FreeFiles (&List);
		AddProblem (pFolder, Error);
		return;
	}
	pSuite->files = List.pFiles;
	pSuite->file_count = List.nCount;
	pSuite->source = GK_APP_SDCARD;
	s_pSuites[s_nSuites++] = pSuite;

	char *Folders[MaxCardApps];
	unsigned nFolders = ListFolders (Dir, pFolder, "lang", Folders, MaxCardApps);
	CLogger::Get ()->Write (From, LogNotice, "apps/%s: suite %s, %u app folder(s)",
				pFolder, pSuite->id, nFolders);
	for (unsigned i = 0; i < nFolders; i++)
	{
		LoadApp (pSuite, Folders[i]);
		delete [] Folders[i];
	}
}

static void LoadCard (void)
{
	static FATFS FileSystem;		// stays mounted: f_open needs it
	if (f_mount (&FileSystem, "SD:", 1) != FR_OK)
	{
		s_CardStatus = GkCardUnreadable;
		CLogger::Get ()->Write (From, LogWarning, "SD card: no FAT file system");
		return;
	}

	CGkSettings::Load ();		// gapkeep.txt, while the card is mounted

	DIR Dir;
	if (f_opendir (&Dir, "SD:/apps") != FR_OK)
	{
		s_CardStatus = GkCardNoApps;
		CLogger::Get ()->Write (From, LogNotice, "SD card: no /apps folder");
		return;
	}
	f_closedir (&Dir);

	char *Folders[MaxCardApps];
	unsigned nFolders = ListFolders ("SD:/apps", "", 0, Folders, MaxCardApps);

	s_CardStatus = GkCardOK;
	for (unsigned i = 0; i < nFolders; i++)
	{
		// a folder with a suite.json (and no manifest.json) is a suite
		CString Dir;
		Dir.Format ("SD:/apps/%s", Folders[i]);
		if (HasFile (Dir, "suite.json") && !HasFile (Dir, "manifest.json"))
		{
			LoadSuite (Folders[i]);
		}
		else
		{
			LoadApp (0, Folders[i]);
		}
		delete [] Folders[i];
	}
}

// --- data folders on the card -----------------------------------------------

// Reads data/<pName> from the card, whole, at boot (ReadAllData)
static void ReadData (const char *pName)
{
	CString Dir;
	Dir.Format ("SD:/data/%s", pName);
	DIR Probe;
	if (   (s_CardStatus != GkCardOK && s_CardStatus != GkCardNoApps)	// not mounted
	    || f_opendir (&Probe, Dir) != FR_OK)
	{
		CLogger::Get ()->Write (From, LogNotice, "data/%s: not on the card", pName);
		return;
	}
	f_closedir (&Probe);

	if (s_nDataOK == MaxDataFolders)
	{
		CString Error;
		Error.Format ("more than %u data folders", MaxDataFolders);
		AddDataError (pName, Error);
		return;
	}

	CString Error;
	TFileList List;
	InitFiles (&List, &DataRules);
	boolean bOK = ReadFolder (Dir, "", 1, &List, &Error);
	if (bOK && s_nDataBytes + List.nTotalSize > MaxDataTotal)
	{
		Error.Format ("the data folders would hold more than %u MB", MaxDataTotal >> 20);
		bOK = FALSE;
	}
	if (!bOK || s_nData == MaxDataEntries)
	{
		FreeFiles (&List);
		AddDataError (pName, Error);
		return;
	}

	SortFiles (&List);
	TDataFolder *pData = &s_Data[s_nData++];
	pData->pName = StrDup (pName);
	pData->Status = GkDataOK;
	pData->pFiles = List.pFiles;
	pData->nCount = List.nCount;
	pData->nSize = List.nTotalSize;
	pData->pHash = HashApp (List.pFiles, List.nCount);
	pData->pError = 0;
	s_nDataOK++;
	s_nDataBytes += List.nTotalSize;
	// names and sizes only: the contents may be private
	CLogger::Get ()->Write (From, LogNotice, "data/%s: %u files, %u bytes, sha256 %s",
				pName, pData->nCount, pData->nSize, pData->pHash);
}

// Every data folder an installed app (built in or on the card) lists,
// read at boot: afterwards nothing reads the card
static void ReadAllData (void)
{
	unsigned nStart = CTimer::Get ()->GetClockTicks ();
	unsigned nBytes = s_nDataBytes;
	for (unsigned i = 0; i < s_nApps; i++)
	{
		const gk_app_t *pApp = s_ppApps[i];
		for (unsigned k = 0; k < pApp->data_count; k++)
		{
			if (FindData (pApp->data[k]) == 0)
			{
				ReadData (pApp->data[k]);
			}
		}
	}
	unsigned nMicros = CTimer::Get ()->GetClockTicks () - nStart;
	CLogger::Get ()->Write (From, LogNotice, "data folders: %u read, %u bytes from the card in %u.%03u ms",
				s_nDataOK, s_nDataBytes - nBytes, nMicros / 1000, nMicros % 1000);
}

#ifdef GK_SIM

// The simulator can replace a built-in app with a folder of the same name
// in its "builtin" folder (gksim --builtin DIR, the IDE's copy of the
// launcher), to work on the launcher without rebuilding. The replacement
// gets the built-in app's rights; if it fails a check, the built-in app
// stays. The Pi has no such folder: built-in apps come only from the
// kernel image.
static const gk_app_t *SimReplacement (const gk_app_t *pBuiltin)
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
	gk_app_t *pApp = ReadApp (Dir, Label, pBuiltin->id, &Error);
	if (pApp == 0)
	{
		CLogger::Get ()->Write (From, LogWarning, "%s not loaded: %s; using the built-in %s",
					(const char *) Label, (const char *) Error, pBuiltin->id);
		return pBuiltin;
	}

	pApp->source = GK_APP_BUILTIN;
	CLogger::Get ()->Write (From, LogNotice, "%s replaces the built-in %s (simulator only)",
				(const char *) Label, pBuiltin->id);
	return pApp;
}

#endif	// GK_SIM

#endif	// !GK_SEALED

void CAppStore::Initialize (boolean bCardPresent)
{
	assert (s_ppApps == 0);
	s_ppApps = new const gk_app_t *[gk_builtin_app_count + MaxCardApps];

	for (unsigned i = 0; i < gk_builtin_app_count; i++)
	{
		const gk_app_t *pApp = &gk_builtin_apps[i];
#if defined (GK_SIM) && !defined (GK_SEALED)
		pApp = SimReplacement (pApp);
#endif
		s_ppApps[s_nApps++] = pApp;
	}
	CLogger::Get ()->Write (From, LogNotice, "%u app(s) built in", gk_builtin_app_count);
	CGkI18n::Initialize ();		// the build's language (it needs the launcher's catalogs)

	AddBuiltinData ();		// sealed builds with DATA=dir

#ifndef GK_SEALED
	if (!bCardPresent)
	{
		s_CardStatus = GkCardNone;
		CLogger::Get ()->Write (From, LogNotice, "No SD card");
	}
	else
	{
		LoadCard ();
		CLogger::Get ()->Write (From, LogNotice, "%u app(s) from the SD card, %u not loaded, %u suite(s)",
					s_nApps - gk_builtin_app_count, s_nProblems, s_nSuites);
	}
	ReadAllData ();			// what the apps list; then the card can go
#else
	s_CardStatus = GkCardDisabled;
#endif
	CloseCard ();
}

TGkDataStatus CAppStore::GetData (const char *pName, const gk_file_t **ppFiles, unsigned *pCount,
				  const char **ppHash, const char **ppError)
{
	*ppFiles = 0;
	*pCount = 0;
	*ppHash = 0;
	*ppError = 0;
	assert (IsValidID (pName));

	// read at boot (ReadAllData): never the card now
	const TDataFolder *pData = FindData (pName);
	if (pData == 0)
	{
		return GkDataMissing;
	}
	if (pData->Status == GkDataOK)
	{
		*ppFiles = pData->pFiles;
		*pCount = pData->nCount;
		*ppHash = pData->pHash;
	}
	*ppError = pData->pError;

	return pData->Status;
}

// --- the card is read at boot only ---------------------------------------------

static boolean s_bCardClosed = FALSE;

#ifndef GK_SEALED
boolean GkCardGuard (const char *pFunction)
{
	if (!s_bCardClosed)
	{
		return TRUE;
	}

	// a bug: nothing may need the card after boot (it may be gone)
	CLogger::Get ()->Write (From, LogError, "%s after boot: the card is read at boot only", pFunction);
	return FALSE;
}
#endif

// After boot: everything is in memory, and the card can be removed
static void CloseCard (void)
{
#ifndef GK_SEALED
	if (s_CardStatus == GkCardOK || s_CardStatus == GkCardNoApps)
	{
		f_mount (0, "SD:", 0);		// unmount: FatFs refuses everything now
	}
#endif
	s_bCardClosed = TRUE;
	CLogger::Get ()->Write (From, LogNotice, "the card is no longer read: it can be removed");
}
