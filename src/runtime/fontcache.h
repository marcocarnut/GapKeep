//
// fontcache.h
//
// GapKeep's fonts: text at any size from GK_FONT_MIN_SIZE to
// GK_FONT_MAX_SIZE pixels, normal or monospaced, and bold, italic and bold
// italic (markup's <b> and <i>; never monospaced: there is no such font).
//
// The sizes of ui.fonts and ui.monoFonts are bitmap fonts in the image
// (fonts/gk_montserrat_*.c, gk_mono_*.c, tools/make_fonts.py): drawn as
// they are, nothing to make. Every other size and style is drawn by LVGL's
// TinyTTF from TrueType outlines embedded in the image (fonts/gk_ttf_*.c:
// Montserrat Medium, Bold, Medium Italic, Bold Italic, JetBrains Mono
// Medium, and the icons, from Font Awesome). Never from anything else:
// apps cannot give fonts of their own, so no app-provided bytes reach the
// TrueType parser.
//
// A font is made when a label first uses it (logged), with the line height
// and baseline of the bitmap font of its size, or, for sizes without one,
// measured from the outlines as the bitmap fonts' are, so that sizes and
// styles mix on a line; it falls back as the bitmap fonts do: to the icons,
// and the monospaced font to the normal one (Latin Extended-A, € and ₿).
// Its glyphs are rasterized when first drawn, and kept (up to 96 a font).
//
// What the kept glyphs take is capped for all fonts together
// (GK_FONT_CACHE_CAP): past it, the glyphs of the fonts drawn longest ago
// are dropped (rasterized again if drawn again). The fonts themselves,
// each a few hundred bytes without its glyphs, are freed with everything
// else when the app exits (GkFontsFree), as are the glyphs.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _fontcache_h
#define _fontcache_h

#include <lvgl/lvgl.h>
#include <circle/types.h>
#include <stddef.h>
#include "markup.h"		// GK_FONT_MIN_SIZE, GK_FONT_MAX_SIZE

// The glyphs kept, at most, for all the made fonts together (see
// docs/APPS.md, "Font sizes", for how it was chosen)
#define GK_FONT_CACHE_CAP	(4u * 1024 * 1024)

// ui.fonts, ui.monoFonts: the bitmap fonts' sizes, ascending
extern const int GkFontSizes[];
extern const unsigned GkFontSizeCount;
extern const int GkMonoSizes[];
extern const unsigned GkMonoSizeCount;

// The font for text of a size (GK_FONT_MIN_SIZE to GK_FONT_MAX_SIZE: the
// caller checks) and style. If one can't be made (no memory: logged), the
// bitmap font of the nearest size.
const lv_font_t *GkFont (int nSize, boolean bMono, boolean bBold = FALSE, boolean bItalic = FALSE);

// The size and kind of a font GkFont gave; 16 and not monospaced for any
// other (the theme's)
void GkFontInfo (const lv_font_t *pFont, int *pSize, boolean *pMono);

// At an app's exit, after its widgets are deleted: frees every made font
void GkFontsFree (void);

// LVGL memory the made fonts hold, glyphs and all: not counted against an
// app's screen (js_ui.cpp, CheckUIMemory), being capped here
size_t GkFontMemory (void);

// How many fonts are made now
unsigned GkFontCount (void);

// For tests (testshot.h "#fonts drop", "#fonts outlines on"): drops every
// font's glyphs, as the cap would (the next draw rasterizes them: what a
// first draw costs); draws the bitmap fonts' sizes from outlines too, from
// the next font asked for (to compare the two).
void GkFontsDropGlyphs (void);
void GkFontsPreferOutlines (boolean bOn);

// Logs, for each font made: the glyph bitmaps asked for, the time spent
// giving them (rasterizing those not kept), and the memory its glyphs hold.
// For tests (testshot.h "#fonts").
void GkFontStats (void);

#endif
