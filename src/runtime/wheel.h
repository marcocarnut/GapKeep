//
// wheel.h
//
// The mouse wheel: it scrolls what is under the pointer, as in a browser.
// The kernel (Circle's USB mouse, through the LVGL addon:
// patches/circle/0006) and the simulator (its "wheel" command, the
// browser's wheel event) call ZgWheel from the main loop.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _wheel_h
#define _wheel_h

// nNotches > 0: down (shows what is below), < 0: up. Each notch scrolls
// three lines of the text there. Scrolls the nearest scrollable object
// under the pointer that can still scroll that way, if any.
void ZgWheel (int nNotches);		// where LVGL's pointer last was

// the same at a point of the screen
void ZgWheelAt (int x, int y, int nNotches);

#endif
