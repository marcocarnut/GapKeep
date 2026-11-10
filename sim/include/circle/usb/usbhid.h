// Modifier bits of USB HID keyboard reports, as in Circle's usbhid.h.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_usb_usbhid_h
#define _circle_usb_usbhid_h
#define LCTRL		(1 << 0)
#define LSHIFT		(1 << 1)
#define ALT		(1 << 2)
#define LWIN		(1 << 3)
#define RCTRL		(1 << 4)
#define RSHIFT		(1 << 5)
#define ALTGR		(1 << 6)
#define RWIN		(1 << 7)
#endif
