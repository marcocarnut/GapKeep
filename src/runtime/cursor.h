/*
 * cursor.h - GapKeep's mouse pointer (drawn by tools/make_cursor.py)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_CURSOR_H
#define GK_CURSOR_H

#include <lvgl/lvgl/lvgl.h>

#ifdef __cplusplus
extern "C" {
#endif

extern const lv_image_dsc_t gk_cursor_image;
extern const int gk_cursor_hot_x, gk_cursor_hot_y;	/* the tip, in the image */

/* Gives every pointer device's cursor GapKeep's image (cursor_install.c).
 * Circle's LVGL addon sets up its own when a mouse turns up (at boot or
 * plugged in later): call after that. */
void GkInstallCursor (void);

#ifdef __cplusplus
}
#endif

#endif
