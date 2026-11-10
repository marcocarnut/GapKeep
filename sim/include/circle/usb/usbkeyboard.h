// A simulated USB keyboard with Circle's interface: the simulator feeds it
// HID reports and the strings Circle's keymap would make of them, so
// src/kbdindev.cpp runs unchanged. The keymap ("US", "BR") is Circle's
// (sim/src/sim.cpp reads its tables).
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_usb_usbkeyboard_h
#define _circle_usb_usbkeyboard_h
#include <circle/device.h>
#include <circle/types.h>
#include <string.h>
typedef void TKeyPressedHandler (const char *pString);
typedef void TKeyStatusHandlerRaw (unsigned char ucModifiers, const unsigned char RawKeys[6]);
class CUSBKeyboardDevice : public CDevice
{
public:
	void RegisterKeyPressedHandler (TKeyPressedHandler *pHandler)	{ m_pPressed = pHandler; }
	void RegisterKeyStatusHandlerRaw (TKeyStatusHandlerRaw *pHandler, boolean bMixedMode = FALSE)
		{ m_pRaw = pHandler; (void) bMixedMode; }
	void UpdateLEDs (void) {}
	boolean SetKeyMap (const char *pLocale)
	{
		if (strcmp (pLocale, "US") != 0 && strcmp (pLocale, "BR") != 0) return FALSE;
		m_pKeyMap = pLocale; return TRUE;
	}
	const char *GetKeyMap (void) const	{ return m_pKeyMap; }

	// simulator side
	void Report (unsigned char ucModifiers, const unsigned char RawKeys[6])
		{ if (m_pRaw) (*m_pRaw) (ucModifiers, RawKeys); }
	void Pressed (const char *pString)	{ if (m_pPressed) (*m_pPressed) (pString); }

private:
	TKeyPressedHandler *m_pPressed = 0;
	TKeyStatusHandlerRaw *m_pRaw = 0;
	const char *m_pKeyMap = "US";
};
#endif
