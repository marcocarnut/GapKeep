//
// ui_test.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "ui_test.h"
#include <circle/logger.h>

static const char FromUI[] = "ui";

static lv_obj_t *s_pWordArea;
static lv_obj_t *s_pEcho;
static unsigned s_nClicks;

static void WordEvent (lv_event_t *e)
{
	lv_event_code_t code = lv_event_get_code (e);
	const char *pText = lv_textarea_get_text (s_pWordArea);

	if (code == LV_EVENT_VALUE_CHANGED)
	{
		lv_label_set_text_fmt (s_pEcho, "You typed: %s", pText);
		CLogger::Get ()->Write (FromUI, LogNotice, "text=\"%s\"", pText);
	}
	else if (code == LV_EVENT_READY)
	{
		CLogger::Get ()->Write (FromUI, LogNotice, "enter text=\"%s\"", pText);
	}
	else if (code == LV_EVENT_FOCUSED)
	{
		CLogger::Get ()->Write (FromUI, LogNotice, "focus=word");
	}
}

static void ButtonEvent (lv_event_t *e)
{
	lv_event_code_t code = lv_event_get_code (e);

	if (code == LV_EVENT_CLICKED)
	{
		s_nClicks++;
		lv_label_set_text_fmt (s_pEcho, "Button clicked %u time(s)", s_nClicks);
		CLogger::Get ()->Write (FromUI, LogNotice, "click=button n=%u", s_nClicks);
	}
	else if (code == LV_EVENT_FOCUSED)
	{
		CLogger::Get ()->Write (FromUI, LogNotice, "focus=button");
	}
}

void UITestCreate (lv_group_t *pGroup)
{
	lv_obj_t *pScreen = lv_screen_active ();

	lv_theme_t *pTheme = lv_theme_default_init (lv_display_get_default (),
						    lv_palette_main (LV_PALETTE_TEAL),
						    lv_palette_main (LV_PALETTE_AMBER),
						    true,		// dark
						    &lv_font_montserrat_16);
	lv_display_set_theme (lv_display_get_default (), pTheme);

	lv_obj_set_flex_flow (pScreen, LV_FLEX_FLOW_COLUMN);
	lv_obj_set_flex_align (pScreen, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
	lv_obj_set_style_pad_all (pScreen, 24, 0);
	lv_obj_set_style_pad_row (pScreen, 16, 0);

	lv_obj_t *pTitle = lv_label_create (pScreen);
	lv_obj_set_style_text_font (pTitle, &lv_font_montserrat_24, 0);
	lv_label_set_text (pTitle, "zerogap");

	lv_obj_t *pSub = lv_label_create (pScreen);
	lv_label_set_text (pSub, "Step 1: display, USB keyboard and mouse");
	lv_obj_set_style_text_color (pSub, lv_palette_lighten (LV_PALETTE_GREY, 1), 0);

	s_pWordArea = lv_textarea_create (pScreen);
	lv_textarea_set_one_line (s_pWordArea, true);
	lv_textarea_set_placeholder_text (s_pWordArea, "Type a word...");
	lv_textarea_set_max_length (s_pWordArea, 32);
	lv_obj_set_width (s_pWordArea, lv_pct (80));
	lv_obj_add_event_cb (s_pWordArea, WordEvent, LV_EVENT_ALL, 0);

	lv_obj_t *pButton = lv_button_create (pScreen);
	lv_obj_add_event_cb (pButton, ButtonEvent, LV_EVENT_ALL, 0);
	lv_obj_t *pLabel = lv_label_create (pButton);
	lv_label_set_text (pLabel, LV_SYMBOL_OK "  Press me");

	s_pEcho = lv_label_create (pScreen);
	lv_label_set_text (s_pEcho, "Tab moves focus, Enter activates.");

	lv_group_add_obj (pGroup, s_pWordArea);
	lv_group_add_obj (pGroup, pButton);
	lv_group_focus_obj (s_pWordArea);
}
