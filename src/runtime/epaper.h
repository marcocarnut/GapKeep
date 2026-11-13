//
// epaper.h
//
// ui.epaper's panel (js_ui.cpp): a second LVGL display, off screen, the
// size of the e-paper panel gapkeep.txt configures (epd.h), on which the
// app builds what the panel will show with gk:ui's widgets. A refresh
// renders it, turns it into the panel's planes (1 bit, and red), in the
// panel's own orientation, and hands them to the driver as a job (jobs.h):
// its promise settles once the panel is asleep, or with an Error.
//
// Its theme is black on white: the text black, the screen white, Panels
// and Buttons outlined in black. Colours become the panel's: red where it
// has red (0xFF0000 and colours near it), else black if darker than a mid
// grey, white if lighter.
//
// What it shows may be a secret: its frame buffer is LVGL's (wiped when
// freed, lv_mem_wipe.c), the planes are wiped once sent, nothing is logged.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _epaper_h
#define _epaper_h

#include <circle/types.h>
#include <lvgl/lvgl.h>
#include <lvgl/lvgl/src/themes/lv_theme_private.h>
#include "epd.h"

extern "C" {
#include <quickjs.h>
}

class CGkEPaperDisplay
{
public:
	// The configured panel's display, drawn after nRotation quarter turns
	// counter-clockwise from the panel's native rows (EPDPages'
	// rotation). 0, and *ppError, if there is no panel or no SPI.
	static CGkEPaperDisplay *Open (unsigned nRotation, const char **ppError);
	~CGkEPaperDisplay (void);	// the display, its screen and widgets

	lv_obj_t *GetScreen (void) const		{ return m_pScreen; }
	const TGkEPDModel *GetModel (void) const	{ return m_pModel; }
	unsigned GetWidth (void) const			{ return m_nWidth; }
	unsigned GetHeight (void) const			{ return m_nHeight; }

	// The screen rendered now, as the panel's planes: B/W (1 white), then
	// red (1 red) if it has red; native rows. New (wipe and delete []).
	u8 *Snapshot (unsigned *pBytes);

	// A refresh with what the screen shows now: a promise (jobs.h).
	JSValue Refresh (JSContext *ctx, const struct TGkJobOptions &Options);

	// The rotation (Open()'s) for an app's orientation and flip, on the
	// configured panel as it is mounted (epaper_rotate).
	static unsigned Rotation (boolean bPortrait, boolean bFlip);

private:
	CGkEPaperDisplay (void) {}

	static void Flush (lv_display_t *pDisplay, const lv_area_t *pArea, u8 *pPixels);
	static void ThemeApply (lv_theme_t *pTheme, lv_obj_t *pObj);

private:
	const TGkEPDModel *m_pModel;
	unsigned m_nRotation;
	unsigned m_nWidth, m_nHeight;	// as drawn (after the rotation)
	lv_display_t *m_pDisplay;
	lv_draw_buf_t *m_pBuffer;
	lv_obj_t *m_pScreen;
	lv_theme_t m_Theme;
};

#endif
