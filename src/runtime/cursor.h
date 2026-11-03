/*
 * cursor.h - zerogap's mouse pointer (drawn by tools/make_cursor.py)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_CURSOR_H
#define ZG_CURSOR_H

#include <lvgl/lvgl/lvgl.h>

#ifdef __cplusplus
extern "C" {
#endif

extern const lv_image_dsc_t zg_cursor_image;
extern const int zg_cursor_hot_x, zg_cursor_hot_y;	/* the tip, in the image */

#ifdef __cplusplus
}
#endif

#endif
