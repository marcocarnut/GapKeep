//
// ttfstyles.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "ttfstyles.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <stddef.h>

extern "C"
{
	extern const unsigned char zg_ttf_bold[], zg_ttf_italic[], zg_ttf_bolditalic[];
	extern const size_t zg_ttf_bold_size, zg_ttf_italic_size, zg_ttf_bolditalic_size;
}

static const char From[] = "fonts";

static const unsigned MaxSizes = 16;		// more than ui.fonts has

static struct
{
	const char *pName;
	const unsigned char *pData;
	const size_t *pSize;
	struct
	{
		int nSize;
		lv_font_t *pFont;
		const void *(*pGetBitmap) (lv_font_glyph_dsc_t *, lv_draw_buf_t *);	// TinyTTF's
		unsigned nBitmaps, nMicros;	// asked for, and the time it took
	} Made[MaxSizes];
}
Styles[3] =		// index: bBold | bItalic << 1, less one
{
	{"bold", zg_ttf_bold, &zg_ttf_bold_size, {}},
	{"italic", zg_ttf_italic, &zg_ttf_italic_size, {}},
	{"bold italic", zg_ttf_bolditalic, &zg_ttf_bolditalic_size, {}},
};

static unsigned s_nMade = 0;

// TinyTTF's get_glyph_bitmap, counted and timed (ZgStyledFontStats)
static const void *GetBitmap (lv_font_glyph_dsc_t *pGlyph, lv_draw_buf_t *pBuffer)
{
	for (auto &Style : Styles)
	{
		for (auto &Made : Style.Made)
		{
			if (Made.pFont == pGlyph->resolved_font)
			{
				unsigned nStart = CTimer::GetClockTicks ();
				const void *pBitmap = (*Made.pGetBitmap) (pGlyph, pBuffer);
				Made.nMicros += CTimer::GetClockTicks () - nStart;
				Made.nBitmaps++;
				return pBitmap;
			}
		}
	}
	return 0;
}

void ZgStyledFontStats (void)
{
	for (auto &Style : Styles)
	{
		for (auto &Made : Style.Made)
		{
			if (Made.pFont != 0)
			{
				CLogger::Get ()->Write (From, LogNotice, "%s %d px: %u glyph bitmaps, %u us",
							Style.pName, Made.nSize, Made.nBitmaps, Made.nMicros);
			}
		}
	}
}

const lv_font_t *ZgStyledFont (const lv_font_t *pNormal, int nSize, boolean bBold, boolean bItalic)
{
	if (!bBold && !bItalic)
	{
		return pNormal;
	}
	auto &Style = Styles[(bBold ? 1 : 0) + (bItalic ? 2 : 0) - 1];

	unsigned i;
	for (i = 0; i < MaxSizes && Style.Made[i].pFont != 0; i++)
	{
		if (Style.Made[i].nSize == nSize)
		{
			return Style.Made[i].pFont;
		}
	}
	if (i == MaxSizes)
	{
		return pNormal;
	}

	unsigned nStart = CTimer::GetClockTicks ();
	lv_font_t *pFont = lv_tiny_ttf_create_data_ex (Style.pData, *Style.pSize, nSize,
						       LV_FONT_KERNING_NORMAL, LV_TINY_TTF_CACHE_GLYPH_CNT);
	if (pFont == 0)
	{
		CLogger::Get ()->Write (From, LogWarning, "%s %d px: no memory for the font", Style.pName, nSize);
		return pNormal;
	}
	// the bitmap font's line, so they mix (TinyTTF takes the TTF's own)
	pFont->line_height = pNormal->line_height;
	pFont->base_line = pNormal->base_line;
	pFont->underline_position = pNormal->underline_position;
	pFont->underline_thickness = pNormal->underline_thickness;
	pFont->fallback = pNormal;		// the icons
	Style.Made[i].nSize = nSize;
	Style.Made[i].pFont = pFont;
	Style.Made[i].pGetBitmap = pFont->get_glyph_bitmap;
	pFont->get_glyph_bitmap = GetBitmap;
	s_nMade++;
	CLogger::Get ()->Write (From, LogNotice, "%s %d px: made in %u us", Style.pName, nSize,
				CTimer::GetClockTicks () - nStart);
	return pFont;
}

unsigned ZgStyledFontCount (void)
{
	return s_nMade;
}
