//
// session.h
//
// Each app's session store: values an app keeps across its runs, until
// the device is switched off. It lives in the kernel's RAM only: nothing
// is ever written to the card, so a reboot forgets it all.
//
// An app's values are its own: they are filed under its id and its hash
// (the SHA-256 of its files), so no other app can read them, and neither
// can another version of the same app (on the device, apps can't change
// until a reboot; in the simulator, editing an app starts it afresh).
//
// Values are kept as bytes (js_session.cpp serializes them). Every byte is
// overwritten before its memory is freed.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _session_h
#define _session_h

#include <circle/types.h>
#include <stddef.h>

struct TGkSessionEntry;

class CGkSession
{
public:
	static const size_t MaxKeyLength = 64;		// bytes of UTF-8
	static const size_t MaxPerApp = 64 * 1024;	// keys and values, bytes
	static const size_t MaxTotal = 1024 * 1024;	// all apps together

	enum TResult { Ok, TooBig, Full };

	// pOwner: "<id>:<hash>". Replaces the key's value, if any. TooBig: over
	// MaxPerApp; Full: over MaxTotal. Nothing changes then.
	static TResult Set (const char *pOwner, const char *pKey, const void *pData, size_t nSize);

	// 0 if not there; else the value (valid until the next call here).
	static const u8 *Get (const char *pOwner, const char *pKey, size_t *pSize);

	static boolean Remove (const char *pOwner, const char *pKey);	// FALSE: not there
	static void Clear (const char *pOwner);

	// Keys in the order they were first set; pKey: 0 for the first.
	static const char *NextKey (const char *pOwner, const char *pKey);

	static size_t GetUsed (const char *pOwner);	// keys and values, bytes

private:
	static TGkSessionEntry *Find (const char *pOwner, const char *pKey, TGkSessionEntry ***pppLink);
	static void Free (TGkSessionEntry *pEntry);

private:
	static TGkSessionEntry *s_pFirst;
	static size_t s_nTotal;
};

#endif
