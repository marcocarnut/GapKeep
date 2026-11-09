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

// From pObj up: the first object that can scroll vertically and still has
// room that way scrolls nSteps notches (bPage: pages). FALSE if none could.
static boolean ScrollFrom (lv_obj_t *pObj, int nSteps, boolean bPage)
{
	for (; pObj != 0; pObj = lv_obj_get_parent (pObj))
	{
		if (   !lv_obj_has_flag (pObj, LV_OBJ_FLAG_SCROLLABLE)
		    || !(lv_obj_get_scroll_dir (pObj) & LV_DIR_VER))
		{
			continue;
		}
		lv_obj_update_layout (pObj);
		int32_t nRoom = nSteps > 0 ? lv_obj_get_scroll_bottom (pObj) : lv_obj_get_scroll_top (pObj);
		if (nRoom <= 0)
		{
			continue;		// at its end that way: maybe its parent
		}

		const lv_font_t *pFont = lv_obj_get_style_text_font (pObj, LV_PART_MAIN);
		int32_t nLine = lv_font_get_line_height (pFont) + lv_obj_get_style_text_line_space (pObj, LV_PART_MAIN);
		int32_t nStep = LinesPerNotch * nLine;
		if (bPage)
		{
			nStep = lv_obj_get_content_height (pObj) - nLine;
			if (nStep < nLine)
			{
				nStep = nLine;
			}
		}
		int32_t nDistance = nSteps * nStep;
		// scroll_by: a positive dy moves the content down, showing what is above
		int32_t nBefore = lv_obj_get_scroll_y (pObj);
		lv_obj_scroll_by_bounded (pObj, 0, -nDistance, LV_ANIM_OFF);
		CLogger::Get ()->Write (From, LogNotice, "%s%d: scrolled %d px", bPage ? "page " : "", nSteps,
					(int) (lv_obj_get_scroll_y (pObj) - nBefore));
		return TRUE;
	}
	return FALSE;
}

void GkWheel (int nNotches)
{
	lv_point_t Point;
	if (PointerAt (&Point))
	{
		GkWheelAt (Point.x, Point.y, nNotches);
	}
}

void GkWheelAt (int x, int y, int nNotches)
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

	if (!ScrollFrom (pObj, nNotches, FALSE))
	{
		CLogger::Get ()->Write (From, LogNotice, "%d: nothing to scroll there", nNotches);
	}
}

// Shift+PageUp/PageDown: a page of the focused widget's nearest scrollable
// ancestor (the screen's, if nothing is focused), less a line so the
// reader keeps their place.
void GkScrollPage (lv_obj_t *pFocused, int nPages)
{
	lv_obj_t *pObj = pFocused != 0 ? pFocused : lv_screen_active ();
	if (nPages != 0 && !ScrollFrom (pObj, nPages, TRUE))
	{
		CLogger::Get ()->Write (From, LogNotice, "page %d: nothing to scroll there", nPages);
	}
}
