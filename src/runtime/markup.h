//
// markup.h
//
// Pango-style markup for ui.Label (markup: true), parsed into runs of text
// with a style each, for an LVGL spangroup (js_ui.cpp). Also checks the
// tags of translations (i18n.cpp). No LVGL here: the sizes <big> and
// <small> step through come from ui.fonts.
//
//   <b> <i>              bold, italic (and both): Montserrat Bold, Medium
//                        Italic, Bold Italic, drawn by TinyTTF (fontcache.h)
//   <tt>                 the monospaced font, at the same size
//   <big> <small>        the next size of ui.fonts up or down (none: the same)
//   <u> <s>              underline, strikethrough
//   <span ...>           color (or foreground, fgcolor) = "#RGB" | "#RRGGBB",
//                        size = GK_FONT_MIN_SIZE to GK_FONT_MAX_SIZE (px),
//                        font_family = "monospace",
//                        weight = "bold" | "normal",
//                        style = "italic" | "normal",
//                        underline = "single" | "none",
//                        strikethrough = "true" | "false"
//   &lt; &gt; &amp; &quot; &apos; &#N; &#xN;
//
// Anything else is an error, with its position: an unknown tag or
// attribute, bold or italic monospaced text (there is no such font: <b>
// in <tt> or in a mono label, <tt> in <b>), bgcolor (spans have no
// background), unclosed or crossed tags, a bad value, a stray "&". Never a
// half-parsed text.
//
// tools/i18n.py has the same rules in Python: keep them in step.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _markup_h
#define _markup_h

#include <circle/types.h>

// The sizes text can have, in pixels: ui.fontRange (fontcache.h)
#define GK_FONT_MIN_SIZE	8
#define GK_FONT_MAX_SIZE	120

#define GK_MARKUP_MAX_RUNS	64	// LVGL draws at most 64 spans on a line
#define GK_MARKUP_MAX_DEPTH	16
#define GK_MARKUP_MAX_TAGS	64

#define GK_MARKUP_UNDERLINE	1
#define GK_MARKUP_STRIKE	2

struct TGkMarkupStyle
{
	int nSize;		// GK_FONT_MIN_SIZE to GK_FONT_MAX_SIZE
	boolean bMono;
	boolean bBold;
	boolean bItalic;
	boolean bColor;		// else the label's
	u32 nColor;		// 0xRRGGBB
	unsigned nDecor;	// GK_MARKUP_*
};

struct TGkMarkupRun
{
	TGkMarkupStyle Style;
	unsigned nStart;	// in pText
	unsigned nLength;
};

struct TGkMarkup
{
	char *pText;		// the text, entities decoded, runs one after another
	unsigned nRuns;
	TGkMarkupRun Runs[GK_MARKUP_MAX_RUNS];

	// the start tags, normalized ("span color=#ff0000 size=20"), for
	// comparing a translation's with its key's
	unsigned nTags;
	char *pTags[GK_MARKUP_MAX_TAGS];
};

// Parses pSource (UTF-8). pSizes: ui.fonts, ascending (for <big> and
// <small>); nSize, bMono: the label's own. FALSE: pError holds why, and
// where ("at character 12").
// Free a parsed one with GkMarkupFree, even after an error.
boolean GkMarkupParse (const char *pSource, unsigned nSourceLength,
		       const int *pSizes, unsigned nSizes, int nSize, boolean bMono,
		       TGkMarkup *pOut, char *pError, unsigned nErrorSize);
void GkMarkupFree (TGkMarkup *pMarkup);

// For translations (i18n.cpp): 0 if pText may stand for pKey, else why.
// A key with "<" or "&" is markup: the translation must be valid markup
// with the same start tags (a multiset). Other keys: no "<" at all.
const char *GkMarkupCheckTranslation (const char *pKey, unsigned nKey, const char *pText, unsigned nText);

#endif
