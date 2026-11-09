//
// markup.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "markup.h"
#include <circle/util.h>
#include <circle/string.h>
#include <string.h>

namespace {

struct TParser
{
	const char *pSource;
	unsigned nLength;
	unsigned nPos;			// in pSource, bytes

	const int *pSizes;
	unsigned nSizes;

	TZgMarkup *pOut;
	unsigned nText;			// bytes in pOut->pText

	struct
	{
		char Name[8];
		unsigned nPos;		// of its "<"
		TZgMarkupStyle Style;
	}
	Stack[ZG_MARKUP_MAX_DEPTH + 1];
	unsigned nDepth;		// Stack[0]: the label's own style

	char *pError;
	unsigned nErrorSize;
};

// "character N", counted as JavaScript would count them (UTF-16 units),
// 1 for the first
unsigned CharacterAt (const TParser &r, unsigned nPos)
{
	unsigned n = 1;
	for (unsigned i = 0; i < nPos && i < r.nLength; i++)
	{
		u8 c = (u8) r.pSource[i];
		if ((c & 0xC0) != 0x80)
		{
			n += c >= 0xF0 ? 2 : 1;
		}
	}
	return n;
}

boolean Fail (TParser &r, unsigned nPos, const char *pWhat, const char *pDetail = "")
{
	CString Text;
	Text.Format ("markup: %s%s at character %u", pWhat, pDetail, CharacterAt (r, nPos));
	strncpy (r.pError, Text, r.nErrorSize - 1);
	r.pError[r.nErrorSize - 1] = '\0';
	return FALSE;
}

boolean SameStyle (const TZgMarkupStyle &a, const TZgMarkupStyle &b)
{
	return    a.nSize == b.nSize && a.bMono == b.bMono && a.bBold == b.bBold && a.bItalic == b.bItalic
	       && a.bColor == b.bColor
	       && (!a.bColor || a.nColor == b.nColor) && a.nDecor == b.nDecor;
}

boolean AddText (TParser &r, const char *p, unsigned n, unsigned nPos)
{
	if (n == 0)
	{
		return TRUE;
	}
	TZgMarkup *pOut = r.pOut;
	const TZgMarkupStyle &Style = r.Stack[r.nDepth].Style;
	TZgMarkupRun *pLast = pOut->nRuns > 0 ? &pOut->Runs[pOut->nRuns - 1] : 0;
	if (pLast == 0 || !SameStyle (pLast->Style, Style))
	{
		if (pOut->nRuns == ZG_MARKUP_MAX_RUNS)
		{
			return Fail (r, nPos, "more than 64 pieces of text in different styles");
		}
		pLast = &pOut->Runs[pOut->nRuns++];
		pLast->Style = Style;
		pLast->nStart = r.nText;
		pLast->nLength = 0;
	}
	memcpy (pOut->pText + r.nText, p, n);
	r.nText += n;
	pOut->pText[r.nText] = '\0';
	pLast->nLength += n;
	return TRUE;
}

unsigned EncodeUTF8 (u32 c, char *p)
{
	if (c < 0x80)		{ p[0] = c; return 1; }
	if (c < 0x800)		{ p[0] = 0xC0 | c >> 6; p[1] = 0x80 | (c & 0x3F); return 2; }
	if (c < 0x10000)	{ p[0] = 0xE0 | c >> 12; p[1] = 0x80 | (c >> 6 & 0x3F); p[2] = 0x80 | (c & 0x3F); return 3; }
	p[0] = 0xF0 | c >> 18; p[1] = 0x80 | (c >> 12 & 0x3F); p[2] = 0x80 | (c >> 6 & 0x3F); p[3] = 0x80 | (c & 0x3F);
	return 4;
}

// An entity at r.nPos ("&..."): its UTF-8 in Out, r.nPos past it
boolean Entity (TParser &r, char *pOut, unsigned *pLength)
{
	unsigned nStart = r.nPos;
	const char *p = r.pSource + r.nPos + 1;
	const char *pEnd = r.pSource + r.nLength;
	const char *pSemi = p;
	while (pSemi < pEnd && pSemi - p < 10 && *pSemi != ';' && *pSemi != '&' && *pSemi != '<' && *pSemi != ' ')
	{
		pSemi++;
	}
	if (pSemi >= pEnd || *pSemi != ';')
	{
		return Fail (r, nStart, "\"&\" starts no entity (write &amp; for \"&\")");
	}
	unsigned n = pSemi - p;
	static const struct { const char *pName; char c; } Named[] =
		{{"lt", '<'}, {"gt", '>'}, {"amp", '&'}, {"quot", '"'}, {"apos", '\''}};
	for (unsigned i = 0; i < sizeof Named / sizeof Named[0]; i++)
	{
		if (strlen (Named[i].pName) == n && memcmp (p, Named[i].pName, n) == 0)
		{
			pOut[0] = Named[i].c;
			*pLength = 1;
			r.nPos += n + 2;
			return TRUE;
		}
	}
	if (n >= 2 && p[0] == '#')
	{
		boolean bHex = p[1] == 'x' || p[1] == 'X';
		u32 c = 0;
		unsigned nDigits = 0;
		boolean bOK = TRUE;
		for (const char *q = p + (bHex ? 2 : 1); q < pSemi && bOK; q++, nDigits++)
		{
			int d = *q >= '0' && *q <= '9' ? *q - '0'
			      : bHex && *q >= 'a' && *q <= 'f' ? *q - 'a' + 10
			      : bHex && *q >= 'A' && *q <= 'F' ? *q - 'A' + 10 : -1;
			bOK = d >= 0 && c <= 0x10FFFF;
			c = c * (bHex ? 16 : 10) + (d < 0 ? 0 : d);
		}
		if (!bOK || nDigits == 0 || c == 0 || c > 0x10FFFF || (c >= 0xD800 && c <= 0xDFFF))
		{
			return Fail (r, nStart, "not a character number");
		}
		*pLength = EncodeUTF8 (c, pOut);
		r.nPos += n + 2;
		return TRUE;
	}
	return Fail (r, nStart, "unknown entity (&lt; &gt; &amp; &quot; &apos; &#N; &#xN;)");
}

boolean IsNameChar (char c)
{
	return (c >= 'a' && c <= 'z') || c == '_';
}

void SkipSpace (TParser &r)
{
	while (r.nPos < r.nLength && (r.pSource[r.nPos] == ' ' || r.pSource[r.nPos] == '\t' || r.pSource[r.nPos] == '\n'))
	{
		r.nPos++;
	}
}

int SizeIndex (const TParser &r, int nSize)
{
	int nIndex = 0;
	for (unsigned i = 0; i < r.nSizes; i++)
	{
		if (r.pSizes[i] <= nSize)
		{
			nIndex = i;
		}
	}
	return nIndex;
}

boolean ParseColor (const char *p, u32 *pColor)
{
	unsigned n = strlen (p);
	if (p[0] != '#' || (n != 4 && n != 7))
	{
		return FALSE;
	}
	u32 v = 0;
	for (unsigned i = 1; i < n; i++)
	{
		char c = p[i];
		int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
		      : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
		if (d < 0)
		{
			return FALSE;
		}
		v = v * 16 + d;
		if (n == 4)
		{
			v = v * 16 + d;
		}
	}
	*pColor = v;
	return TRUE;
}

// One attribute of <span>, applied to pStyle
boolean SpanAttribute (TParser &r, unsigned nPos, const char *pName, const char *pValue, TZgMarkupStyle *pStyle)
{
	CString Detail;
	if (   strcmp (pName, "color") == 0 || strcmp (pName, "foreground") == 0
	    || strcmp (pName, "fgcolor") == 0)
	{
		if (!ParseColor (pValue, &pStyle->nColor))
		{
			Detail.Format (" %s=\"%.16s\": \"#RRGGBB\" or \"#RGB\" expected", pName, pValue);
			return Fail (r, nPos, "bad attribute", Detail);
		}
		pStyle->bColor = TRUE;
		return TRUE;
	}
	if (strcmp (pName, "size") == 0)
	{
		// digits only (no strtol in the kernel's C library)
		int n = 0;
		const char *q = pValue;
		while (*q >= '0' && *q <= '9' && n < 1000)
		{
			n = n * 10 + (*q++ - '0');
		}
		for (unsigned i = 0; *pValue != '\0' && *q == '\0' && i < r.nSizes; i++)
		{
			if (r.pSizes[i] == n)
			{
				pStyle->nSize = n;
				return TRUE;
			}
		}
		Detail.Format (" size=\"%.16s\": one of the sizes in ui.fonts expected", pValue);
		return Fail (r, nPos, "bad attribute", Detail);
	}
	if (strcmp (pName, "font_family") == 0 || strcmp (pName, "face") == 0)
	{
		if (strcmp (pValue, "monospace") != 0)
		{
			Detail.Format (" %s=\"%.16s\": only \"monospace\" is there", pName, pValue);
			return Fail (r, nPos, "bad attribute", Detail);
		}
		pStyle->bMono = TRUE;
		return TRUE;
	}
	if (strcmp (pName, "underline") == 0 || strcmp (pName, "strikethrough") == 0)
	{
		boolean bUnderline = pName[0] == 'u';
		const char *pOn = bUnderline ? "single" : "true", *pOff = bUnderline ? "none" : "false";
		unsigned nBit = bUnderline ? ZG_MARKUP_UNDERLINE : ZG_MARKUP_STRIKE;
		if (strcmp (pValue, pOn) == 0)
		{
			pStyle->nDecor |= nBit;
			return TRUE;
		}
		if (strcmp (pValue, pOff) == 0)
		{
			pStyle->nDecor &= ~nBit;
			return TRUE;
		}
		Detail.Format (" %s=\"%.16s\": \"%s\" or \"%s\" expected", pName, pValue, pOn, pOff);
		return Fail (r, nPos, "bad attribute", Detail);
	}
	if (strcmp (pName, "weight") == 0 || strcmp (pName, "style") == 0)
	{
		boolean bWeight = pName[0] == 'w';
		const char *pOn = bWeight ? "bold" : "italic";
		if (strcmp (pValue, pOn) != 0 && strcmp (pValue, "normal") != 0)
		{
			Detail.Format (" %s=\"%.16s\": \"%s\" or \"normal\" expected", pName, pValue, pOn);
			return Fail (r, nPos, "bad attribute", Detail);
		}
		(bWeight ? pStyle->bBold : pStyle->bItalic) = strcmp (pValue, pOn) == 0;
		return TRUE;
	}
	if (strcmp (pName, "bgcolor") == 0 || strcmp (pName, "background") == 0)
	{
		Detail.Format (" %s: text has no background color here", pName);
		return Fail (r, nPos, "unsupported attribute", Detail);
	}
	Detail.Format (" %.16s (color, size, font_family, weight, style, underline, strikethrough)", pName);
	return Fail (r, nPos, "unknown attribute", Detail);
}

boolean AddTag (TParser &r, const char *pTag)
{
	TZgMarkup *pOut = r.pOut;
	if (pOut->nTags == ZG_MARKUP_MAX_TAGS)
	{
		return Fail (r, r.nPos, "more than 64 tags");
	}
	unsigned n = strlen (pTag);
	pOut->pTags[pOut->nTags] = new char[n + 1];
	memcpy (pOut->pTags[pOut->nTags++], pTag, n + 1);
	return TRUE;
}

// A start or end tag at r.nPos ("<")
boolean Tag (TParser &r)
{
	unsigned nStart = r.nPos++;
	boolean bEnd = r.nPos < r.nLength && r.pSource[r.nPos] == '/';
	if (bEnd)
	{
		r.nPos++;
	}
	char Name[16];
	unsigned n = 0;
	while (r.nPos < r.nLength && IsNameChar (r.pSource[r.nPos]) && n < sizeof Name - 1)
	{
		Name[n++] = r.pSource[r.nPos++];
	}
	Name[n] = '\0';
	if (n == 0)
	{
		return Fail (r, nStart, "\"<\" starts no tag (write &lt; for \"<\")");
	}

	static const char *const Known[] = {"b", "i", "tt", "big", "small", "u", "s", "span"};
	boolean bKnown = FALSE;
	for (unsigned i = 0; i < sizeof Known / sizeof Known[0]; i++)
	{
		bKnown = bKnown || strcmp (Name, Known[i]) == 0;
	}
	CString Detail;
	if (!bKnown)
	{
		Detail.Format (" <%s> (b, i, tt, big, small, u, s, span)", Name);
		return Fail (r, nStart, "unknown tag", Detail);
	}

	if (bEnd)
	{
		SkipSpace (r);
		if (r.nPos >= r.nLength || r.pSource[r.nPos] != '>')
		{
			return Fail (r, nStart, "unfinished tag");
		}
		r.nPos++;
		if (r.nDepth == 0)
		{
			Detail.Format (" </%s> closes nothing", Name);
			return Fail (r, nStart, "unexpected end tag", Detail);
		}
		if (strcmp (r.Stack[r.nDepth].Name, Name) != 0)
		{
			Detail.Format (" </%s> where <%s> (at character %u) should close first", Name,
				       r.Stack[r.nDepth].Name, CharacterAt (r, r.Stack[r.nDepth].nPos));
			return Fail (r, nStart, "crossed tags:", Detail);
		}
		r.nDepth--;
		return TRUE;
	}

	if (r.nDepth == ZG_MARKUP_MAX_DEPTH)
	{
		return Fail (r, nStart, "tags nested more than 16 deep");
	}
	TZgMarkupStyle Style = r.Stack[r.nDepth].Style;
	CString Normal (Name);

	// attributes: <span> only, each once, sorted for the tag's normal form
	char Seen[8][16];
	unsigned nSeen = 0;
	CString Attributes[8];
	for (;;)
	{
		unsigned nBefore = r.nPos;
		SkipSpace (r);
		if (r.nPos >= r.nLength)
		{
			return Fail (r, nStart, "unfinished tag");
		}
		if (r.pSource[r.nPos] == '>')
		{
			r.nPos++;
			break;
		}
		if (r.nPos == nBefore)
		{
			return Fail (r, r.nPos, "bad tag: a space or \">\" expected");
		}
		unsigned nAttr = r.nPos;
		char Attr[16];
		unsigned k = 0;
		while (r.nPos < r.nLength && IsNameChar (r.pSource[r.nPos]) && k < sizeof Attr - 1)
		{
			Attr[k++] = r.pSource[r.nPos++];
		}
		Attr[k] = '\0';
		if (k == 0 || r.nPos >= r.nLength || r.pSource[r.nPos] != '=')
		{
			return Fail (r, nAttr, "bad attribute: name=\"value\" expected");
		}
		if (strcmp (Name, "span") != 0)
		{
			Detail.Format (" %s: <%s> takes none", Attr, Name);
			return Fail (r, nAttr, "unexpected attribute", Detail);
		}
		for (unsigned i = 0; i < nSeen; i++)
		{
			if (strcmp (Seen[i], Attr) == 0)
			{
				Detail.Format (" %s", Attr);
				return Fail (r, nAttr, "attribute given twice:", Detail);
			}
		}
		if (nSeen == 8)
		{
			return Fail (r, nAttr, "too many attributes");
		}
		strcpy (Seen[nSeen], Attr);
		r.nPos++;
		char cQuote = r.nPos < r.nLength ? r.pSource[r.nPos] : 0;
		if (cQuote != '"' && cQuote != '\'')
		{
			return Fail (r, nAttr, "bad attribute: a quoted value expected");
		}
		r.nPos++;
		char Value[64];
		unsigned v = 0;
		while (r.nPos < r.nLength && r.pSource[r.nPos] != cQuote)
		{
			char Decoded[4];
			unsigned nDecoded = 1;
			Decoded[0] = r.pSource[r.nPos];
			if (Decoded[0] == '<')
			{
				return Fail (r, r.nPos, "\"<\" in an attribute value");
			}
			if (Decoded[0] == '&')
			{
				if (!Entity (r, Decoded, &nDecoded))
				{
					return FALSE;
				}
			}
			else
			{
				r.nPos++;
			}
			if (v + nDecoded >= sizeof Value)
			{
				return Fail (r, nAttr, "attribute value too long");
			}
			memcpy (Value + v, Decoded, nDecoded);
			v += nDecoded;
		}
		Value[v] = '\0';
		if (r.nPos >= r.nLength)
		{
			return Fail (r, nAttr, "unfinished attribute value");
		}
		r.nPos++;
		if (!SpanAttribute (r, nAttr, Attr, Value, &Style))
		{
			return FALSE;
		}
		Attributes[nSeen++].Format ("%s=%s", Attr, Value);
	}
	for (unsigned i = 0; i < nSeen; i++)		// sorted
	{
		unsigned m = i;
		for (unsigned j = i + 1; j < nSeen; j++)
		{
			if (strcmp (Attributes[j], Attributes[m]) < 0)
			{
				m = j;
			}
		}
		CString Tmp (Attributes[i]);
		Attributes[i] = (const char *) Attributes[m];
		Attributes[m] = (const char *) Tmp;
		Normal.Append (" ");
		Normal.Append (Attributes[i]);
	}

	int nIndex = SizeIndex (r, Style.nSize);
	if (strcmp (Name, "tt") == 0)		Style.bMono = TRUE;
	else if (strcmp (Name, "b") == 0)	Style.bBold = TRUE;
	else if (strcmp (Name, "i") == 0)	Style.bItalic = TRUE;
	else if (strcmp (Name, "big") == 0)	Style.nSize = r.pSizes[nIndex + 1 < (int) r.nSizes ? nIndex + 1 : nIndex];
	else if (strcmp (Name, "small") == 0)	Style.nSize = r.pSizes[nIndex > 0 ? nIndex - 1 : 0];
	else if (strcmp (Name, "u") == 0)	Style.nDecor |= ZG_MARKUP_UNDERLINE;
	else if (strcmp (Name, "s") == 0)	Style.nDecor |= ZG_MARKUP_STRIKE;

	if (Style.bMono && (Style.bBold || Style.bItalic))
	{
		Detail.Format (" <%s>: there is no %s monospaced font", Name,
			       Style.bBold && Style.bItalic ? "bold italic" : Style.bBold ? "bold" : "italic");
		return Fail (r, nStart, "unsupported style:", Detail);
	}

	r.nDepth++;
	strcpy (r.Stack[r.nDepth].Name, Name);
	r.Stack[r.nDepth].nPos = nStart;
	r.Stack[r.nDepth].Style = Style;
	return AddTag (r, Normal);
}

}	// namespace

boolean ZgMarkupParse (const char *pSource, unsigned nSourceLength,
		       const int *pSizes, unsigned nSizes, int nSize, boolean bMono,
		       TZgMarkup *pOut, char *pError, unsigned nErrorSize)
{
	memset (pOut, 0, sizeof *pOut);
	pOut->pText = new char[nSourceLength + 1];
	pOut->pText[0] = '\0';

	TParser r;
	memset (&r, 0, sizeof r);
	r.pSource = pSource;
	r.nLength = nSourceLength;
	r.pSizes = pSizes;
	r.nSizes = nSizes;
	r.pOut = pOut;
	r.pError = pError;
	r.nErrorSize = nErrorSize;
	r.Stack[0].Style.nSize = nSize;
	r.Stack[0].Style.bMono = bMono;

	while (r.nPos < r.nLength)
	{
		char c = pSource[r.nPos];
		if (c == '<')
		{
			if (!Tag (r))
			{
				return FALSE;
			}
		}
		else if (c == '&')
		{
			unsigned nPos = r.nPos;
			char Decoded[4];
			unsigned n;
			if (!Entity (r, Decoded, &n) || !AddText (r, Decoded, n, nPos))
			{
				return FALSE;
			}
		}
		else
		{
			unsigned nStart = r.nPos;
			while (r.nPos < r.nLength && pSource[r.nPos] != '<' && pSource[r.nPos] != '&')
			{
				r.nPos++;
			}
			if (!AddText (r, pSource + nStart, r.nPos - nStart, nStart))
			{
				return FALSE;
			}
		}
	}
	if (r.nDepth > 0)
	{
		CString Detail;
		Detail.Format (" <%s>", r.Stack[r.nDepth].Name);
		return Fail (r, r.Stack[r.nDepth].nPos, "never closed:", Detail);
	}
	return TRUE;
}

void ZgMarkupFree (TZgMarkup *pMarkup)
{
	delete [] pMarkup->pText;
	pMarkup->pText = 0;
	for (unsigned i = 0; i < pMarkup->nTags; i++)
	{
		delete [] pMarkup->pTags[i];
	}
	pMarkup->nTags = 0;
	pMarkup->nRuns = 0;
}

const char *ZgMarkupCheckTranslation (const char *pKey, unsigned nKey, const char *pText, unsigned nText)
{
	boolean bMarkup = memchr (pKey, '<', nKey) != 0 || memchr (pKey, '&', nKey) != 0;
	if (!bMarkup)
	{
		return memchr (pText, '<', nText) != 0 ? "has a tag, and its key has none" : 0;
	}

	// sizes don't matter here, as long as every size is one of them
	static const int Sizes[] = {12, 14, 16, 18, 20, 22, 24, 28, 32, 40};
	static TZgMarkup Key, Text;		// big for the stack
	char Error[2];
	boolean bKeyOK = ZgMarkupParse (pKey, nKey, Sizes, sizeof Sizes / sizeof Sizes[0], 16, FALSE,
					&Key, Error, sizeof Error);
	boolean bTextOK = ZgMarkupParse (pText, nText, Sizes, sizeof Sizes / sizeof Sizes[0], 16, FALSE,
					 &Text, Error, sizeof Error);
	const char *pWhy = 0;
	if (!bKeyOK)
	{
		pWhy = 0;		// not markup after all ("a < b"): only no tags added
		if (bTextOK && Text.nTags > 0)
		{
			pWhy = "has a tag, and its key has none";
		}
	}
	else if (!bTextOK)
	{
		pWhy = "is not valid markup";
	}
	else if (Key.nTags != Text.nTags)
	{
		pWhy = "hasn't the same tags as its key";
	}
	else
	{
		// the same multiset: each of the key's tags matched with one of the text's
		boolean Used[ZG_MARKUP_MAX_TAGS] = {FALSE};
		for (unsigned i = 0; i < Key.nTags && pWhy == 0; i++)
		{
			unsigned j;
			for (j = 0; j < Text.nTags; j++)
			{
				if (!Used[j] && strcmp (Key.pTags[i], Text.pTags[j]) == 0)
				{
					Used[j] = TRUE;
					break;
				}
			}
			if (j == Text.nTags)
			{
				pWhy = "hasn't the same tags as its key";
			}
		}
	}
	ZgMarkupFree (&Key);
	ZgMarkupFree (&Text);
	return pWhy;
}
