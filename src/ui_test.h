//
// ui_test.h
//
// Step 1 test screen: proves display, mouse, keyboard and focus handling.
// Every input event is logged to the serial port so tests can be scripted.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _ui_test_h
#define _ui_test_h

#include <lvgl/lvgl.h>

void UITestCreate (lv_group_t *pGroup);

#endif
