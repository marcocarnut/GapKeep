//
// js_data.cpp
//
// The "gk:data" module: read-only files from the SD card's data folders,
// data/<name>/..., shared by name between apps (docs/APPS.md, "Data
// files"; docs/API.md). An app reads only the folders its manifest lists
// in "data"; nothing can write. The folders are read and hashed by
// appstore.cpp, on first use, and kept: what an app reads is what was
// hashed.
//
// Nothing here logs what the files hold: they may be private (whose keys
// someone has is itself worth hiding).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "apphost.h"
#include "appstore.h"
#include <circle/util.h>
#include <circle/string.h>

static const size_t MaxPathLength = 1024;

// The folder argument, checked against the app's manifest. 0 (exception
// set) if refused; else free with JS_FreeCString.
static const char *GetFolder (JSContext *ctx, int argc, JSValueConst *argv, const char *pFunction)
{
	const char *pName = argc >= 1 && JS_IsString (argv[0]) ? JS_ToCString (ctx, argv[0]) : 0;
	if (pName == 0)
	{
		JS_ThrowTypeError (ctx, "%s: a data folder name expected, as in the manifest's \"data\"",
				   pFunction);
		return 0;
	}
	if (!CAppStore::IsValidID (pName))
	{
		JS_ThrowTypeError (ctx, "%s: \"%.40s\" is not a data folder name (a-z, 0-9 and -, at most 32)",
				   pFunction, pName);
		JS_FreeCString (ctx, pName);
		return 0;
	}

	const gk_app_t *pBundle = CAppHost::GetApp (ctx)->pBundle;
	for (unsigned i = 0; i < pBundle->data_count; i++)
	{
		if (strcmp (pBundle->data[i], pName) == 0)
		{
			return pName;
		}
	}

	JS_ThrowTypeError (ctx, "%s: the data folder \"%s\" is not in the manifest's \"data\"",
			   pFunction, pName);
	JS_FreeCString (ctx, pName);
	return 0;
}

// The folder's files, or the exception (GkDataError) as Result
static TGkDataStatus GetFiles (JSContext *ctx, const char *pFolder, const gk_file_t **ppFiles,
			       unsigned *pCount, const char **ppHash, JSValue *pResult)
{
	const char *pError;
	TGkDataStatus Status = CAppStore::GetData (pFolder, ppFiles, pCount, ppHash, &pError);
	if (Status == GkDataError)
	{
		*pResult = JS_ThrowTypeError (ctx, "data/%s: %s", pFolder, pError);
	}

	return Status;
}

// A path inside the folder: "a/b.asc"; no "..", ".", empty parts, leading
// "/" or "\" anywhere
static boolean IsValidPath (const char *p, size_t nLength)
{
	if (nLength == 0 || nLength > MaxPathLength || strlen (p) != nLength)
	{
		return FALSE;
	}
	if (strchr (p, '\\') != 0)
	{
		return FALSE;
	}

	while (TRUE)
	{
		const char *pEnd = strchr (p, '/');
		size_t n = pEnd ? (size_t) (pEnd - p) : strlen (p);
		if (   n == 0
		    || (n == 1 && p[0] == '.')
		    || (n == 2 && p[0] == '.' && p[1] == '.'))
		{
			return FALSE;
		}
		if (pEnd == 0)
		{
			return TRUE;
		}
		p = pEnd + 1;
	}
}

// read() and readText(): the file, or 0 (exception set)
static const gk_file_t *GetFile (JSContext *ctx, int argc, JSValueConst *argv, const char *pFunction,
				 CString *pPath)
{
	const char *pFolder = GetFolder (ctx, argc, argv, pFunction);
	if (pFolder == 0)
	{
		return 0;
	}

	size_t nLength = 0;
	const char *pName = argc >= 2 && JS_IsString (argv[1]) ? JS_ToCStringLen (ctx, &nLength, argv[1]) : 0;
	const gk_file_t *pFound = 0;
	do
	{
		if (pName == 0)
		{
			JS_ThrowTypeError (ctx, "%s: a file name expected, as list() gives it", pFunction);
			break;
		}
		if (!IsValidPath (pName, nLength))
		{
			JS_ThrowTypeError (ctx, "%s: \"%.64s\" is not a path inside the folder (\"keys/alice.asc\":"
					   " no \"..\" or \".\", no leading \"/\", no \"\\\")", pFunction, pName);
			break;
		}

		const gk_file_t *pFiles;
		unsigned nCount;
		const char *pHash;
		JSValue Exception;
		TGkDataStatus Status = GetFiles (ctx, pFolder, &pFiles, &nCount, &pHash, &Exception);
		if (Status == GkDataError)
		{
			break;
		}
		for (unsigned i = 0; i < nCount && pFound == 0; i++)
		{
			if (strcmp (pFiles[i].path, pName) == 0)
			{
				pFound = &pFiles[i];
			}
		}
		if (pFound == 0)
		{
			JS_ThrowTypeError (ctx, Status == GkDataMissing ? "%s: no file \"%.64s\": data/%s is not on the card"
									: "%s: no file \"%.64s\" in data/%s",
					   pFunction, pName, pFolder);
			break;
		}
		pPath->Format ("data/%s/%s", pFolder, pName);
	}
	while (0);

	JS_FreeCString (ctx, pName);
	JS_FreeCString (ctx, pFolder);

	return pFound;
}

static JSValue js_data_list (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const char *pFolder = GetFolder (ctx, argc, argv, "list");
	if (pFolder == 0)
	{
		return JS_EXCEPTION;
	}

	const gk_file_t *pFiles;
	unsigned nCount;
	const char *pHash;
	JSValue Result = JS_UNDEFINED;
	if (GetFiles (ctx, pFolder, &pFiles, &nCount, &pHash, &Result) != GkDataError)
	{
		Result = JS_NewArray (ctx);
		for (unsigned i = 0; i < nCount; i++)
		{
			JSValue Entry = JS_NewObject (ctx);
			JS_SetPropertyStr (ctx, Entry, "name", JS_NewString (ctx, pFiles[i].path));
			JS_SetPropertyStr (ctx, Entry, "size", JS_NewUint32 (ctx, pFiles[i].size));
			JS_SetPropertyUint32 (ctx, Result, i, Entry);
		}
	}
	JS_FreeCString (ctx, pFolder);

	return Result;
}

static JSValue js_data_read (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CString Path;
	const gk_file_t *pFile = GetFile (ctx, argc, argv, "read", &Path);
	if (pFile == 0)
	{
		return JS_EXCEPTION;
	}

	JSValue Buffer = JS_NewArrayBufferCopy (ctx, (const u8 *) pFile->data, pFile->size);
	if (JS_IsException (Buffer))
	{
		return Buffer;
	}
	// JS_NewTypedArray reads argv[0..2] regardless of argc: pass all three
	JSValueConst Args[3] = {Buffer, JS_NewInt32 (ctx, 0), JS_UNDEFINED};
	JSValue Array = JS_NewTypedArray (ctx, 3, Args, JS_TYPED_ARRAY_UINT8);
	JS_FreeValue (ctx, Buffer);

	return Array;
}

static JSValue js_data_read_text (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	CString Path;
	const gk_file_t *pFile = GetFile (ctx, argc, argv, "readText", &Path);
	if (pFile == 0)
	{
		return JS_EXCEPTION;
	}
	if (!CAppStore::IsValidUTF8 ((const u8 *) pFile->data, pFile->size))
	{
		return JS_ThrowTypeError (ctx, "readText: %.100s is not UTF-8 text (read() gives its bytes)", (const char *) Path);
	}

	return JS_NewStringLen (ctx, pFile->data, pFile->size);
}

static JSValue js_data_hash (JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
	const char *pFolder = GetFolder (ctx, argc, argv, "hash");
	if (pFolder == 0)
	{
		return JS_EXCEPTION;
	}

	const gk_file_t *pFiles;
	unsigned nCount;
	const char *pHash;
	JSValue Result = JS_NULL;
	TGkDataStatus Status = GetFiles (ctx, pFolder, &pFiles, &nCount, &pHash, &Result);
	if (Status == GkDataOK)
	{
		Result = JS_NewString (ctx, pHash);
	}
	JS_FreeCString (ctx, pFolder);

	return Result;
}

static int DataModuleInit (JSContext *ctx, JSModuleDef *m)
{
	JS_SetModuleExport (ctx, m, "list", JS_NewCFunction (ctx, js_data_list, "list", 1));
	JS_SetModuleExport (ctx, m, "read", JS_NewCFunction (ctx, js_data_read, "read", 2));
	JS_SetModuleExport (ctx, m, "readText", JS_NewCFunction (ctx, js_data_read_text, "readText", 2));
	JS_SetModuleExport (ctx, m, "hash", JS_NewCFunction (ctx, js_data_hash, "hash", 1));

	return 0;
}

JSModuleDef *GkInitDataModule (JSContext *ctx, const char *pName)
{
	JSModuleDef *m = JS_NewCModule (ctx, pName, DataModuleInit);
	if (m == 0)
	{
		return 0;
	}

	JS_AddModuleExport (ctx, m, "list");
	JS_AddModuleExport (ctx, m, "read");
	JS_AddModuleExport (ctx, m, "readText");
	JS_AddModuleExport (ctx, m, "hash");

	return m;
}
