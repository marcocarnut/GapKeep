//
// fontcache.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "fontcache.h"
#include "lv_mem_limit.h"		// gk_lv_mem_used
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/util.h>

extern "C"
{
	// tools/make_fonts.py: TrueType files, built into the image
	extern const unsigned char gk_ttf_regular[], gk_ttf_mono[], gk_ttf_bold[], gk_ttf_italic[],
				   gk_ttf_bolditalic[], gk_ttf_icons[];
	extern const size_t gk_ttf_regular_size, gk_ttf_mono_size, gk_ttf_bold_size, gk_ttf_italic_size,
			    gk_ttf_bolditalic_size, gk_ttf_icons_size;
	// the characters each has: first, last, ...
	extern const unsigned gk_ttf_regular_ranges[], gk_ttf_mono_ranges[], gk_ttf_bold_ranges[],
			      gk_ttf_italic_ranges[], gk_ttf_bolditalic_ranges[], gk_ttf_icons_ranges[];
	extern const unsigned gk_ttf_regular_range_count, gk_ttf_mono_range_count, gk_ttf_bold_range_count,
			      gk_ttf_italic_range_count, gk_ttf_bolditalic_range_count, gk_ttf_icons_range_count;
	// the line of the sizes without a bitmap font, in 1/65536 em
	extern const int gk_ttf_regular_line_top, gk_ttf_regular_line_bottom,
			 gk_ttf_regular_underline_position, gk_ttf_regular_underline_thickness;
}

static const char From[] = "fonts";

const int GkFontSizes[] = {12, 14, 16, 18, 20, 22, 24, 28, 32, 40};
const unsigned GkFontSizeCount = sizeof GkFontSizes / sizeof GkFontSizes[0];
static const lv_font_t *const BitmapFonts[] =
{
	&gk_montserrat_12, &gk_montserrat_14, &gk_montserrat_16,
	&gk_montserrat_18, &gk_montserrat_20, &gk_montserrat_22,
	&gk_montserrat_24, &gk_montserrat_28, &gk_montserrat_32,
	&gk_montserrat_40
};

// JetBrains Mono, with Montserrat's line at the same size, falling back to
// it for icons and the rest (tools/make_fonts.py)
const int GkMonoSizes[] = {12, 14, 16, 18, 20, 24, 28};
const unsigned GkMonoSizeCount = sizeof GkMonoSizes / sizeof GkMonoSizes[0];
static const lv_font_t *const BitmapMonoFonts[] =
{
	&gk_mono_12, &gk_mono_14, &gk_mono_16, &gk_mono_18, &gk_mono_20,
	&gk_mono_24, &gk_mono_28
};

enum TKind {KindRegular, KindMono, KindBold, KindItalic, KindBoldItalic, KindIcons, KindCount};

// Kerning from the fonts' GPOS pairs (JetBrains Mono has none; the icons
// need none). TinyTTF's kerning cache is off (LV_TINY_TTF_CACHE_KERNING_CNT
// 0, gk_lv_conf.h): LVGL 9.4 releases its entries into the glyph cache
// (lv_tiny_ttf.c, ttf_get_glyph_pair_kerning_width), and widths came out
// wrong (a bold space three times too wide, B and T overlapping).
// Uncached, stb_truetype reads the pair for each glyph drawn.

static const struct
{
	const char *pName;
	const unsigned char *pData;
	const size_t *pSize;
	lv_font_kerning_t Kerning;
	const unsigned *pRanges;
	const unsigned *pRangeCount;
}
Sources[KindCount] =
{
	{"regular",	gk_ttf_regular,		&gk_ttf_regular_size,		LV_FONT_KERNING_NORMAL,
						gk_ttf_regular_ranges, &gk_ttf_regular_range_count},
	{"mono",	gk_ttf_mono,		&gk_ttf_mono_size,		LV_FONT_KERNING_NONE,
						gk_ttf_mono_ranges, &gk_ttf_mono_range_count},
	{"bold",	gk_ttf_bold,		&gk_ttf_bold_size,		LV_FONT_KERNING_NORMAL,
						gk_ttf_bold_ranges, &gk_ttf_bold_range_count},
	{"italic",	gk_ttf_italic,		&gk_ttf_italic_size,		LV_FONT_KERNING_NORMAL,
						gk_ttf_italic_ranges, &gk_ttf_italic_range_count},
	{"bold italic",	gk_ttf_bolditalic,	&gk_ttf_bolditalic_size,	LV_FONT_KERNING_NORMAL,
						gk_ttf_bolditalic_ranges, &gk_ttf_bolditalic_range_count},
	{"icons",	gk_ttf_icons,		&gk_ttf_icons_size,		LV_FONT_KERNING_NONE,
						gk_ttf_icons_ranges, &gk_ttf_icons_range_count},
};

struct TMade
{
	TKind Kind;
	int nSize;
	lv_font_t *pFont;		// TinyTTF's; pFont->user_data: this
	// TinyTTF's own, called by ours (GetGlyphDsc, GetGlyphBitmap)
	bool (*pGetGlyphDsc) (const lv_font_t *, lv_font_glyph_dsc_t *, uint32_t, uint32_t);
	const void *(*pGetGlyphBitmap) (lv_font_glyph_dsc_t *, lv_draw_buf_t *);
	long nBytes;			// what its glyphs hold now
	unsigned nLastUse;		// s_nClock then
	unsigned nBitmaps, nMicros;	// glyph bitmaps asked for, and the time it took
	unsigned nRasterized, nRasterMicros;	// of those, rasterized (not kept)
	unsigned nDropped;		// times its glyphs were dropped (the cap)
};

static TMade *s_pMade[KindCount][GK_FONT_MAX_SIZE + 1];
static unsigned s_nMade = 0;
static long s_nGlyphBytes = 0;		// sum of nBytes
static long s_nFontBytes = 0;		// the fonts without their glyphs
static unsigned s_nClock = 0;
static boolean s_bPreferOutlines = FALSE;	// tests

// The bitmap font of a size, 0 if none
static const lv_font_t *Bitmap (int nSize, boolean bMono)
{
	const int *pSizes = bMono ? GkMonoSizes : GkFontSizes;
	unsigned nCount = bMono ? GkMonoSizeCount : GkFontSizeCount;
	for (unsigned i = 0; i < nCount; i++)
	{
		if (pSizes[i] == nSize)
		{
			return bMono ? BitmapMonoFonts[i] : BitmapFonts[i];
		}
	}
	return 0;
}

// The bitmap font of the nearest size (the smaller if two are)
static const lv_font_t *NearestBitmap (int nSize, boolean bMono)
{
	const int *pSizes = bMono ? GkMonoSizes : GkFontSizes;
	unsigned nCount = bMono ? GkMonoSizeCount : GkFontSizeCount;
	unsigned nBest = 0;
	for (unsigned i = 1; i < nCount; i++)
	{
		int nDiff = pSizes[i] - nSize, nBestDiff = pSizes[nBest] - nSize;
		if ((nDiff < 0 ? -nDiff : nDiff) < (nBestDiff < 0 ? -nBestDiff : nBestDiff))
		{
			nBest = i;
		}
	}
	return bMono ? BitmapMonoFonts[nBest] : BitmapFonts[nBest];
}

// nSize * nFraction / 65536, rounded up (bUp) or to the nearest
static int32_t Scale (int nSize, int nFraction, boolean bUp)
{
	long n = (long) nSize * nFraction;
	if (bUp)
	{
		return (int32_t) ((n + 65535) / 65536);
	}
	return (int32_t) (n >= 0 ? (n + 32768) / 65536 : -((-n + 32768) / 65536));
}

// Every size's fonts on the same line: the bitmap font's of that size, or,
// without one, the line make_fonts.py measured from the outlines as it
// measures the bitmap fonts' (TinyTTF would take the TTF's own)
static void SetLine (lv_font_t *pFont, int nSize)
{
	const lv_font_t *pBitmap = Bitmap (nSize, FALSE);
	if (pBitmap != 0)
	{
		pFont->line_height = pBitmap->line_height;
		pFont->base_line = pBitmap->base_line;
		pFont->underline_position = pBitmap->underline_position;
		pFont->underline_thickness = pBitmap->underline_thickness;
		return;
	}
	int32_t nTop = Scale (nSize, gk_ttf_regular_line_top, TRUE);
	int32_t nBottom = Scale (nSize, gk_ttf_regular_line_bottom, TRUE);
	pFont->line_height = nTop + nBottom;
	pFont->base_line = nBottom;
	pFont->underline_position = (int8_t) Scale (nSize, gk_ttf_regular_underline_position, FALSE);
	int32_t nThickness = Scale (nSize, gk_ttf_regular_underline_thickness, FALSE);
	pFont->underline_thickness = (int8_t) (nThickness < 1 ? 1 : nThickness);
}

// Drops a font's glyphs: TinyTTF makes its caches anew when its size is set
static void Drop (TMade *pMade)
{
	long nBefore = (long) gk_lv_mem_used ();
	lv_tiny_ttf_set_size (pMade->pFont, pMade->nSize);
	SetLine (pMade->pFont, pMade->nSize);
	long nFreed = nBefore - (long) gk_lv_mem_used ();
	s_nGlyphBytes -= pMade->nBytes;
	s_nFontBytes += pMade->nBytes - nFreed;		// ~0: new empty caches for old ones
	pMade->nBytes = 0;
	pMade->nDropped++;
}

// Glyphs over the cap: those of the fonts used longest ago are dropped,
// never those of pKeep (one of its glyphs may be drawn now). LVGL draws one
// glyph at a time, so no other font's is in use.
static void Trim (TMade *pKeep)
{
	while (s_nGlyphBytes > (long) GK_FONT_CACHE_CAP)
	{
		TMade *pOldest = 0;
		for (unsigned k = 0; k < KindCount; k++)
		{
			for (int s = GK_FONT_MIN_SIZE; s <= GK_FONT_MAX_SIZE; s++)
			{
				TMade *p = s_pMade[k][s];
				if (   p != 0 && p != pKeep && p->nBytes > 0
				    && (pOldest == 0 || p->nLastUse < pOldest->nLastUse))
				{
					pOldest = p;
				}
			}
		}
		if (pOldest == 0)
		{
			return;		// pKeep's alone (at most 96 glyphs)
		}
		Drop (pOldest);
	}
}

// What a call into TinyTTF changed in LVGL's memory: its caches
static void Account (TMade *pMade, size_t nBefore)
{
	long nDelta = (long) gk_lv_mem_used () - (long) nBefore;
	pMade->nBytes += nDelta;
	s_nGlyphBytes += nDelta;
	pMade->nLastUse = ++s_nClock;
	if (s_nGlyphBytes > (long) GK_FONT_CACHE_CAP)
	{
		Trim (pMade);
	}
}

// Whether a font has a character (TinyTTF logs an error for each it lacks)
static boolean Has (const TMade *pMade, uint32_t nLetter)
{
	const unsigned *pRanges = Sources[pMade->Kind].pRanges;
	unsigned nLow = 0, nHigh = *Sources[pMade->Kind].pRangeCount;
	while (nLow < nHigh)
	{
		unsigned nMid = (nLow + nHigh) / 2;
		if (nLetter < pRanges[2 * nMid])
		{
			nHigh = nMid;
		}
		else if (nLetter > pRanges[2 * nMid + 1])
		{
			nLow = nMid + 1;
		}
		else
		{
			return TRUE;
		}
	}
	return FALSE;
}

static bool GetGlyphDsc (const lv_font_t *pFont, lv_font_glyph_dsc_t *pDsc, uint32_t nLetter, uint32_t nNext)
{
	TMade *pMade = (TMade *) pFont->user_data;
	if (   nLetter >= 0x20 && nLetter != 0xF8FF && nLetter != 0x200C	// (TinyTTF's own empty ones)
	    && !Has (pMade, nLetter))
	{
		return false;		// to the fallback font
	}
	size_t nBefore = gk_lv_mem_used ();
	bool bFound = (*pMade->pGetGlyphDsc) (pFont, pDsc, nLetter, nNext);
	Account (pMade, nBefore);
	return bFound;
}

static const void *GetGlyphBitmap (lv_font_glyph_dsc_t *pGlyph, lv_draw_buf_t *pBuffer)
{
	TMade *pMade = (TMade *) pGlyph->resolved_font->user_data;
	size_t nBefore = gk_lv_mem_used ();
	unsigned nStart = CTimer::GetClockTicks ();
	const void *pBitmap = (*pMade->pGetGlyphBitmap) (pGlyph, pBuffer);
	unsigned nMicros = CTimer::GetClockTicks () - nStart;
	pMade->nMicros += nMicros;
	pMade->nBitmaps++;
	if (gk_lv_mem_used () != nBefore)		// a new bitmap (one kept is free)
	{
		pMade->nRasterized++;
		pMade->nRasterMicros += nMicros;
	}
	Account (pMade, nBefore);
	return pBitmap;
}

static const lv_font_t *Make (TKind Kind, int nSize)
{
	if (s_pMade[Kind][nSize] != 0)
	{
		return s_pMade[Kind][nSize]->pFont;
	}

	// what it falls back to, first: the icons, or the normal font
	const lv_font_t *pFallback = 0;
	if (Kind == KindRegular)
	{
		pFallback = Make (KindIcons, nSize);
	}
	else if (Kind != KindIcons)
	{
		pFallback = GkFont (nSize, FALSE);
	}

	size_t nBefore = gk_lv_mem_used ();
	unsigned nStart = CTimer::GetClockTicks ();
	const auto &Source = Sources[Kind];
	lv_font_t *pFont = lv_tiny_ttf_create_data_ex (Source.pData, *Source.pSize, nSize,
						       Source.Kerning, LV_TINY_TTF_CACHE_GLYPH_CNT);
	TMade *pMade = pFont != 0 ? new TMade : 0;
	if (pMade == 0)
	{
		if (pFont != 0)
		{
			lv_tiny_ttf_destroy (pFont);
		}
		CLogger::Get ()->Write (From, LogWarning, "%s %d px: no memory for the font", Source.pName, nSize);
		return 0;
	}
	memset (pMade, 0, sizeof *pMade);
	pMade->Kind = Kind;
	pMade->nSize = nSize;
	pMade->pFont = pFont;
	pMade->pGetGlyphDsc = pFont->get_glyph_dsc;
	pMade->pGetGlyphBitmap = pFont->get_glyph_bitmap;
	pMade->nLastUse = ++s_nClock;
	pFont->get_glyph_dsc = GetGlyphDsc;
	pFont->get_glyph_bitmap = GetGlyphBitmap;
	pFont->user_data = pMade;
	pFont->fallback = pFallback;
	SetLine (pFont, nSize);
	s_pMade[Kind][nSize] = pMade;
	s_nMade++;
	s_nFontBytes += (long) gk_lv_mem_used () - (long) nBefore;

	CLogger::Get ()->Write (From, LogNotice, "%s %d px: made in %u us", Source.pName, nSize,
				CTimer::GetClockTicks () - nStart);
	return pFont;
}

const lv_font_t *GkFont (int nSize, boolean bMono, boolean bBold, boolean bItalic)
{
	if (nSize < GK_FONT_MIN_SIZE || nSize > GK_FONT_MAX_SIZE)
	{
		return NearestBitmap (nSize, bMono);	// the callers check
	}
	if (!bBold && !bItalic && !s_bPreferOutlines)
	{
		const lv_font_t *pBitmap = Bitmap (nSize, bMono);
		if (pBitmap != 0)
		{
			return pBitmap;
		}
	}
	TKind Kind = bBold && bItalic ? KindBoldItalic : bBold ? KindBold : bItalic ? KindItalic
		   : bMono ? KindMono : KindRegular;
	const lv_font_t *pFont = Make (Kind, nSize);
	return pFont != 0 ? pFont : NearestBitmap (nSize, bMono);
}

void GkFontInfo (const lv_font_t *pFont, int *pSize, boolean *pMono)
{
	*pSize = 16;
	*pMono = FALSE;
	for (unsigned i = 0; i < GkFontSizeCount; i++)
	{
		if (BitmapFonts[i] == pFont)
		{
			*pSize = GkFontSizes[i];
			return;
		}
	}
	for (unsigned i = 0; i < GkMonoSizeCount; i++)
	{
		if (BitmapMonoFonts[i] == pFont)
		{
			*pSize = GkMonoSizes[i];
			*pMono = TRUE;
			return;
		}
	}
	if (pFont == 0 || pFont->get_glyph_dsc != GetGlyphDsc)
	{
		return;
	}
	const TMade *pMade = (const TMade *) pFont->user_data;
	*pSize = pMade->nSize;
	*pMono = pMade->Kind == KindMono;
}

void GkFontsFree (void)
{
	if (s_nMade == 0)
	{
		return;
	}
	size_t nBefore = gk_lv_mem_used ();
	for (unsigned k = 0; k < KindCount; k++)
	{
		for (int s = GK_FONT_MIN_SIZE; s <= GK_FONT_MAX_SIZE; s++)
		{
			TMade *pMade = s_pMade[k][s];
			if (pMade != 0)
			{
				lv_tiny_ttf_destroy (pMade->pFont);
				delete pMade;
				s_pMade[k][s] = 0;
			}
		}
	}
	CLogger::Get ()->Write (From, LogNotice, "%u freed, %u bytes", s_nMade,
				(unsigned) (nBefore - gk_lv_mem_used ()));
	s_nMade = 0;
	s_nGlyphBytes = 0;
	s_nFontBytes = 0;
}

void GkFontsDropGlyphs (void)
{
	for (unsigned k = 0; k < KindCount; k++)
	{
		for (int s = GK_FONT_MIN_SIZE; s <= GK_FONT_MAX_SIZE; s++)
		{
			if (s_pMade[k][s] != 0 && s_pMade[k][s]->nBytes != 0)
			{
				Drop (s_pMade[k][s]);
			}
		}
	}
}

void GkFontsPreferOutlines (boolean bOn)
{
	s_bPreferOutlines = bOn;
}

size_t GkFontMemory (void)
{
	long n = s_nGlyphBytes + s_nFontBytes;
	return n > 0 ? (size_t) n : 0;
}

unsigned GkFontCount (void)
{
	return s_nMade;
}

void GkFontStats (void)
{
	for (unsigned k = 0; k < KindCount; k++)
	{
		for (int s = GK_FONT_MIN_SIZE; s <= GK_FONT_MAX_SIZE; s++)
		{
			const TMade *p = s_pMade[k][s];
			if (p != 0)
			{
				CLogger::Get ()->Write (From, LogNotice,
					"%s %d px: %u glyph bitmaps, %u us; %u rasterized, %u us; "
					"%ld bytes kept, dropped %u times",
					Sources[k].pName, s, p->nBitmaps, p->nMicros, p->nRasterized,
					p->nRasterMicros, p->nBytes, p->nDropped);
			}
		}
	}
	CLogger::Get ()->Write (From, LogNotice, "%u fonts: %ld bytes of glyphs (cap %u), %ld bytes besides",
				s_nMade, s_nGlyphBytes, GK_FONT_CACHE_CAP, s_nFontBytes);
}
