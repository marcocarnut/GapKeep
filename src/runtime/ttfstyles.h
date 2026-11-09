//
// ttfstyles.h
//
// Bold, italic and bold italic text (markup's <b> and <i>): Montserrat
// Bold, Medium Italic and Bold Italic, embedded as TrueType files
// (fonts/gk_ttf_*.c, tools/make_fonts.py) and drawn by LVGL's TinyTTF at
// run time. Nothing is made at boot: the first label to use a style at a
// size makes its font (logged, with the time it took), which is kept until
// power-off, glyphs cached as they are drawn.
//
// Each has the line height and baseline of the bitmap font of its size,
// so it mixes on a line with it, and falls back to it for what it lacks
// (the icons).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _ttfstyles_h
#define _ttfstyles_h

#include <lvgl/lvgl.h>
#include <circle/types.h>

// The font for bold and/or italic text at a size; pNormal: the bitmap
// font of that size. 0 if it could not be made (no memory): logged, and the
// caller draws with pNormal.
const lv_font_t *GkStyledFont (const lv_font_t *pNormal, int nSize, boolean bBold, boolean bItalic);

// How many fonts have been made
unsigned GkStyledFontCount (void);

// Logs, for each font made: the glyph bitmaps asked for and the time spent
// giving them (rasterizing those not cached). For tests (testshot.h
// "#fonts"): what a first draw costs against a cached one.
void GkStyledFontStats (void);

#endif
