//
// wheel.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "wheel.h"
#include <lvgl/lvgl.h>
#include <circle/logger.h>
#include <circle/types.h>

static const char From[] = "wheel";

static const int LinesPerNotch = 3;

// where the pointer is: the first pointer input device's last point
static boolean PointerAt (lv_point_t *pPoint)
{
	for (lv_indev_t *p = lv_indev_get_next (0); p != 0; p = lv_indev_get_next (p))
	{
		if (lv_indev_get_type (p) == LV_INDEV_TYPE_POINTER)
		{
			lv_indev_get_point (p, pPoint);
			return TRUE;
		}
	}
	return FALSE;
}

void ZgWheel (int nNotches)
{
	lv_point_t Point;
	if (PointerAt (&Point))
	{
		ZgWheelAt (Point.x, Point.y, nNotches);
	}
}

void ZgWheelAt (int x, int y, int nNotches)
{
	lv_point_t Point = {x, y};
	if (nNotches == 0)
	{
		return;
	}

	// what is under the pointer: a modal alert on the top layer first
	lv_obj_t *pObj = lv_indev_search_obj (lv_layer_top (), &Point);
	if (pObj == 0 || pObj == lv_layer_top ())
	{
		pObj = lv_indev_search_obj (lv_screen_active (), &Point);
	}

	for (; pObj != 0; pObj = lv_obj_get_parent (pObj))
	{
		if (   !lv_obj_has_flag (pObj, LV_OBJ_FLAG_SCROLLABLE)
		    || !(lv_obj_get_scroll_dir (pObj) & LV_DIR_VER))
		{
			continue;
		}
		lv_obj_update_layout (pObj);
		int32_t nRoom = nNotches > 0 ? lv_obj_get_scroll_bottom (pObj) : lv_obj_get_scroll_top (pObj);
		if (nRoom <= 0)
		{
			continue;		// at its end that way: maybe its parent
		}

		const lv_font_t *pFont = lv_obj_get_style_text_font (pObj, LV_PART_MAIN);
		int32_t nLine = lv_font_get_line_height (pFont) + lv_obj_get_style_text_line_space (pObj, LV_PART_MAIN);
		int32_t nDistance = nNotches * LinesPerNotch * nLine;
		// scroll_by: a positive dy moves the content down, showing what is above
		int32_t nBefore = lv_obj_get_scroll_y (pObj);
		lv_obj_scroll_by_bounded (pObj, 0, -nDistance, LV_ANIM_OFF);
		CLogger::Get ()->Write (From, LogNotice, "%d: scrolled %d px", nNotches,
					(int) (lv_obj_get_scroll_y (pObj) - nBefore));
		return;
	}
	CLogger::Get ()->Write (From, LogNotice, "%d: nothing to scroll there", nNotches);
}
