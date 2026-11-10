/*
 * lv_mem_limit.h - how much memory LVGL may use (lv_mem_wipe.c), and how
 * much an app's widgets may make it use (js_ui.cpp checks before it
 * creates a widget or sets a property, and throws a RangeError).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_LV_MEM_LIMIT_H
#define GK_LV_MEM_LIMIT_H

#include <stddef.h>

#define GK_LV_MEM_LIMIT			(64u * 1024 * 1024)
#define GK_LV_MEM_LIMIT_TEXT		"64 MB"
#define GK_LV_MEM_SOFT_LIMIT		(32u * 1024 * 1024)
#define GK_LV_MEM_SOFT_LIMIT_TEXT	"32 MB"

#ifdef __cplusplus
extern "C"
#endif
size_t gk_lv_mem_used (void);		/* bytes LVGL holds now */

#endif
