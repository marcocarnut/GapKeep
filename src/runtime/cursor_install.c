/*
 * cursor_install.c - puts GapKeep's pointer image (cursor.c) on the mouse
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "cursor.h"

void GkInstallCursor (void)
{
	for (lv_indev_t *pIndev = lv_indev_get_next (0); pIndev != 0; pIndev = lv_indev_get_next (pIndev))
	{
		lv_obj_t *pCursor = lv_indev_get_cursor (pIndev);
		if (   pCursor != 0
		    && lv_image_get_src (pCursor) != &gk_cursor_image)
		{
			lv_image_set_src (pCursor, &gk_cursor_image);
			/* LVGL puts the image's top left corner at the pointer */
			lv_obj_set_style_translate_x (pCursor, -gk_cursor_hot_x, 0);
			lv_obj_set_style_translate_y (pCursor, -gk_cursor_hot_y, 0);
		}
	}
}
