//
// textcheck.h
//
// Text that comes from an app or a card and is shown by the system (an
// app's or a suite's name, version and description, their translations,
// every translation of an app's catalog) must not hold characters that
// change how the text around them reads: control characters (C0, DEL, C1),
// line and paragraph separators, the bidi controls, and the invisible ones
// (zero-width spaces and joiners, word joiner and invisible operators, the
// byte order mark, the soft hyphen). With them, an app's name could put a
// line of its choosing under the launcher's, such as a forged "SHA-256"
// (docs/APPS.md, "App hashes"). The line feed is allowed only where the
// caller says so (an app's own messages; never in names).
//
// The same set is in tools/textcheck.py (tools/bundle_apps.py, tools/i18n.py).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_textcheck_h
#define _gk_textcheck_h

#include <stddef.h>

// The next code point of UTF-8 text, or -1 if it is malformed (then *pp is
// set to pEnd)
static inline int gk_next_code_point (const unsigned char **pp, const unsigned char *pEnd)
{
	const unsigned char *p = *pp;
	unsigned c = *p++;
	unsigned nMore = c < 0x80 ? 0 : (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2
		       : (c & 0xF8) == 0xF0 ? 3 : 9;
	if (nMore == 9 || nMore > (size_t) (pEnd - p))
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

// Whether code point c (-1: malformed UTF-8) may not be shown; the line
// feed only if bLineFeedOK is 0
static inline int gk_is_forbidden_char (int c, int bLineFeedOK)
{
	return    c < 0
	       || (c < 0x20 && !(c == '\n' && bLineFeedOK))
	       || (c >= 0x7F && c <= 0x9F)		// DEL, C1
	       || c == 0xAD				// soft hyphen
	       || c == 0x061C				// Arabic letter mark
	       || (c >= 0x200B && c <= 0x200F)		// zero-width space, (non-)joiner, LRM, RLM
	       || (c >= 0x2028 && c <= 0x202E)		// line and paragraph separators, embeddings
	       || (c >= 0x2060 && c <= 0x2069)		// word joiner, invisible operators, isolates
	       || c == 0xFEFF				// zero-width no-break space (BOM)
	       || (c >= 0xD800 && c <= 0xDFFF);	// lone surrogates
}

// Whether n bytes of text at p are UTF-8 without forbidden characters
static inline int gk_text_is_clean (const char *p, size_t n, int bLineFeedOK)
{
	const unsigned char *q = (const unsigned char *) p, *pEnd = q + n;
	while (q < pEnd)
	{
		if (gk_is_forbidden_char (gk_next_code_point (&q, pEnd), bLineFeedOK))
		{
			return 0;
		}
	}
	return 1;
}

// For text from the card shown as it is (a folder's name in the launcher's
// list of problems): each forbidden character, line feeds too, and each
// malformed byte become '?', in place (the text gets no longer). p is
// NUL-terminated.
static inline void gk_text_sanitise (char *p)
{
	unsigned char *pIn = (unsigned char *) p, *pOut = pIn;
	unsigned char *pEnd = pIn;
	while (*pEnd != '\0')
	{
		pEnd++;
	}
	while (pIn < pEnd)
	{
		const unsigned char *q = pIn;
		int c = gk_next_code_point (&q, pEnd);
		if (c < 0 || gk_is_forbidden_char (c, 0))
		{
			*pOut++ = '?';
			pIn = c < 0 ? pIn + 1 : (unsigned char *) q;	// malformed: one byte at a time
			continue;
		}
		while (pIn < q)
		{
			*pOut++ = *pIn++;
		}
	}
	*pOut = '\0';
}

#endif
