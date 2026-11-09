//
// wheel.h
//
// The mouse wheel: it scrolls what is under the pointer, as in a browser.
// The kernel (Circle's USB mouse, through the LVGL addon:
// patches/circle/0006) and the simulator (its "wheel" command, the
// browser's wheel event) call GkWheel from the main loop.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _wheel_h
#define _wheel_h

// nNotches > 0: down (shows what is below), < 0: up. Each notch scrolls
// three lines of the text there. Scrolls the nearest scrollable object
// under the pointer that can still scroll that way, if any.
void GkWheel (int nNotches);		// where LVGL's pointer last was

// the same at a point of the screen
void GkWheelAt (int x, int y, int nNotches);

// Shift+PageUp (nPages < 0) / Shift+PageDown (> 0): scrolls the nearest
// scrollable ancestor of pFocused (0: the screen) by a page less a line.
struct _lv_obj_t;
void GkScrollPage (struct _lv_obj_t *pFocused, int nPages);

#endif
