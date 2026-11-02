//
// kbdindev.h
//
// Feeds Circle's USB keyboard (cooked mode) into LVGL as a keypad input device.
//
// Circle delivers each key press (including auto-repeat) as a string: a
// printable character, or a VT100-style escape sequence for special keys.
// We translate those into LVGL key codes, queue them, and hand them to LVGL
// one press/release pair at a time.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _kbdindev_h
#define _kbdindev_h

#include <circle/usb/usbkeyboard.h>
#include <circle/types.h>
#include <lvgl/lvgl.h>

class CKeyboardIndev
{
public:
	CKeyboardIndev (void);

	// Creates the LVGL keypad device and a default focus group.
	// Call after CLVGL::Initialize().
	void Initialize (void);

	// Call from the main loop after USB plug-and-play updates.
	void Update (boolean bPlugAndPlayUpdated);

	lv_group_t *GetGroup (void) const	{ return m_pGroup; }

private:
	static void KeyPressedHandler (const char *pString);
	static void KeyboardRemovedHandler (CDevice *pDevice, void *pContext);
	static void ReadCallback (lv_indev_t *pIndev, lv_indev_data_t *pData);

	void Enqueue (u32 nKey);
	static u32 Translate (const char *pString);

private:
	CUSBKeyboardDevice *m_pKeyboard;
	lv_indev_t *m_pIndev;
	lv_group_t *m_pGroup;

	// Single producer (USB interrupt context) / single consumer (LVGL in the
	// main loop) ring buffer.
	static const unsigned QueueSize = 64;	// power of two
	volatile u32 m_Queue[QueueSize];
	volatile unsigned m_nHead;		// written by producer
	volatile unsigned m_nTail;		// written by consumer

	u32 m_nPressedKey;			// key currently reported as pressed, 0 if none

	static CKeyboardIndev *s_pThis;
};

#endif
