//
// keylayout.h
//
// The keyboard layout: which character each key types. One for the whole
// system, applied to the USB keyboard by src/kbdindev.cpp (in the kernel
// and in the simulator alike).
//
//   "us"        US, the default (Circle's "US" keymap)
//   "br-abnt2"  Brazilian ABNT2 (Circle's "BR", patches/circle/0005), with
//               dead keys: ´ ` ~ ^ ¨ and then a letter type the accented
//               letter (á à ã â ä...), and then a space the accent itself
//
// Set from zerogap.txt ("keyboard = br-abnt2", settings.cpp), from the
// build (make KEYBOARD=br-abnt2, the default before zerogap.txt; the only
// way for sealed builds, which read no card), from a test build's serial
// line ("#keyboard br-abnt2"), and while running by GkKeyLayoutSet (for
// zg:i18n's setKeyboard). A change lasts until reboot: nothing is written.
//
// What apps get is UTF-8: ui.onKey's key names, and the text typed into a
// TextArea.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _keylayout_h
#define _keylayout_h

#include <circle/types.h>

// The layouts' names, in a fixed order, then 0.
const char *const *GkKeyLayouts (void);

// The current layout's name: one of GkKeyLayouts().
const char *GkKeyLayoutGet (void);

// Switches to the layout pName, at once (a dead key pending is dropped).
// pFrom says who asks, for the log ("zerogap.txt", "settings app"...).
// FALSE, logged, nothing changed: no such layout.
boolean GkKeyLayoutSet (const char *pName, const char *pFrom);

// zerogap.txt's "keyboard = <layout>": TRUE if pKey is "keyboard" (the
// value is then taken or refused, with a log line), FALSE for other keys.
boolean GkKeyLayoutConfigure (const char *pKey, const char *pValue, unsigned nLine);

// --- for src/kbdindev.cpp -------------------------------------------------------

// Circle's keymap for the current layout ("US", "BR"), and a number that
// changes with every GkKeyLayoutSet, so the keyboard can tell it must load
// it again.
const char *GkKeyLayoutCircleMap (void);
unsigned GkKeyLayoutGeneration (void);

// Dead keys. Feed every character the keymap gives (a Unicode code point;
// 0 for a key that types none: Enter, an arrow...), in order. Returns how
// many characters to type now, in pOut (0, 1 or 2): nothing for a dead
// key, the composed letter after one, or the accent and then the character
// if they don't compose. *pbConsumed is TRUE when a non-character key only
// cancelled a pending dead key (Backspace and Escape do) and must not act.
// Called from interrupt context: no allocation, no logging.
class CGkDeadKeys
{
public:
	CGkDeadKeys (void) : m_nPending (0) {}

	unsigned Feed (u32 nChar, boolean bRepeat, boolean bCancelKey,
		       u32 pOut[2], boolean *pbConsumed);

	void Reset (void)	{ m_nPending = 0; }

private:
	u32 m_nPending;		// the dead key's accent, 0 if none
};

// UTF-8 for a code point (at most 4 bytes and a NUL into pBuf[5]); the
// number of bytes.
unsigned GkUtf8Encode (u32 nChar, char pBuf[5]);

#endif
