//
// kbdindev.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "kbdindev.h"
#include <circle/devicenameservice.h>
#include <circle/logger.h>
#include <circle/util.h>
#include <circle/synchronize.h>
#include <circle/usb/usbhid.h>
#include <assert.h>

static const char FromKbd[] = "kbd";

CKeyboardIndev *CKeyboardIndev::s_pThis = 0;

CKeyboardIndev::CKeyboardIndev (void)
:	m_pKeyboard (0),
	m_pIndev (0),
	m_nRawModifiers (0),
	m_bNewPress (FALSE),
	m_bGUIDown (FALSE),
	m_nHead (0),
	m_nTail (0),
	m_nPressedKey (0),
	m_pPressedGroup (0),
	m_pPressedObj (0),
	m_pKeyHook (0),
	m_pKeyHookParam (0),
	m_pHomeHandler (0),
	m_pHomeParam (0)
{
	assert (s_pThis == 0);
	s_pThis = this;
	memset (m_RawKeys, 0, sizeof m_RawKeys);
}

void CKeyboardIndev::Initialize (void)
{
	m_pIndev = lv_indev_create ();
	lv_indev_set_type (m_pIndev, LV_INDEV_TYPE_KEYPAD);
	lv_indev_set_read_cb (m_pIndev, ReadCallback);
}

void CKeyboardIndev::SetGroup (lv_group_t *pGroup)
{
	assert (m_pIndev != 0);
	lv_indev_set_group (m_pIndev, pGroup);
}

lv_group_t *CKeyboardIndev::GetGroup (void) const
{
	assert (m_pIndev != 0);
	return lv_indev_get_group (m_pIndev);
}

void CKeyboardIndev::SetKeyHook (TKeyHook *pHook, void *pParam)
{
	m_pKeyHook = pHook;
	m_pKeyHookParam = pParam;
}

void CKeyboardIndev::SetHomeHandler (THomeHandler *pHandler, void *pParam)
{
	m_pHomeHandler = pHandler;
	m_pHomeParam = pParam;
}

void CKeyboardIndev::Flush (void)
{
	m_nTail = m_nHead;
}

void CKeyboardIndev::Update (boolean bPlugAndPlayUpdated)
{
	if (bPlugAndPlayUpdated && m_pKeyboard == 0)
	{
		m_pKeyboard = (CUSBKeyboardDevice *)
			CDeviceNameService::Get ()->GetDevice ("ukbd1", FALSE);
		if (m_pKeyboard != 0)
		{
			m_pKeyboard->RegisterRemovedHandler (KeyboardRemovedHandler);
			m_pKeyboard->RegisterKeyPressedHandler (KeyPressedHandler);
			m_pKeyboard->RegisterKeyStatusHandlerRaw (KeyStatusHandlerRaw, TRUE);	// mixed mode

			CLogger::Get ()->Write (FromKbd, LogNotice, "Keyboard attached");
		}
	}

	if (m_pKeyboard != 0)
	{
		// must not be called from interrupt context
		m_pKeyboard->UpdateLEDs ();
	}
}

void CKeyboardIndev::KeyStatusHandlerRaw (unsigned char ucModifiers, const unsigned char RawKeys[6])
{
	assert (s_pThis != 0);
	CKeyboardIndev *pThis = s_pThis;

	pThis->m_nRawModifiers = ucModifiers;

	// Circle calls this before it turns the same report into characters;
	// auto-repeat characters come from a timer, with no report. So a
	// character is a real key press only if some key went down since the
	// previous one. (Comparing key sets, not counting reports: keyboards
	// may resend unchanged reports.)
	for (unsigned i = 0; i < 6; i++)
	{
		if (RawKeys[i] == 0)
		{
			continue;
		}
		boolean bWasDown = FALSE;
		for (unsigned j = 0; j < 6; j++)
		{
			if (pThis->m_RawKeys[j] == RawKeys[i])
			{
				bWasDown = TRUE;
			}
		}
		if (!bWasDown)
		{
			pThis->m_bNewPress = TRUE;
		}
	}
	memcpy (pThis->m_RawKeys, RawKeys, sizeof pThis->m_RawKeys);

	boolean bGUI = (ucModifiers & (LWIN | RWIN)) != 0;
	if (bGUI && !pThis->m_bGUIDown && pThis->m_pHomeHandler != 0)
	{
		(*pThis->m_pHomeHandler) (pThis->m_pHomeParam);
	}
	pThis->m_bGUIDown = bGUI;
}

void CKeyboardIndev::KeyPressedHandler (const char *pString)
{
	assert (s_pThis != 0);

	TZgKey Key;
	Key.bRepeat = !s_pThis->m_bNewPress;
	s_pThis->m_bNewPress = FALSE;
	if (s_pThis->Translate (pString, &Key))
	{
		s_pThis->Enqueue (Key);
	}
}

void CKeyboardIndev::KeyboardRemovedHandler (CDevice *pDevice, void *pContext)
{
	assert (s_pThis != 0);
	s_pThis->m_pKeyboard = 0;

	CLogger::Get ()->Write (FromKbd, LogNotice, "Keyboard removed");
}

void CKeyboardIndev::Enqueue (const TZgKey &rKey)
{
	unsigned nNext = (m_nHead + 1) & (QueueSize-1);
	if (nNext == m_nTail)
	{
		return;		// full: drop the key rather than block in IRQ context
	}

	m_Queue[m_nHead] = rKey;
	DataMemBarrier ();
	m_nHead = nNext;
}

// Each queued key is first offered to the key hook (main-loop context, so it
// may call into JavaScript). If not consumed and it has an LVGL code, it
// becomes one PRESSED report followed by one RELEASED report. Circle
// generates auto-repeat (enabled by patches/circle/0002), so LVGL's own
// long-press repeat is not needed.
void CKeyboardIndev::ReadCallback (lv_indev_t *pIndev, lv_indev_data_t *pData)
{
	assert (s_pThis != 0);
	CKeyboardIndev *pThis = s_pThis;

	if (pThis->m_nPressedKey != 0)
	{
		// If handling the press moved the focus (Enter in a text field that
		// jumps to a button, say), the release must not act on the newly
		// focused widget: LVGL would "click" it. One key press, one action.
		lv_group_t *pGroup = lv_indev_get_group (pIndev);
		lv_obj_t *pFocused = pGroup ? lv_group_get_focused (pGroup) : 0;
		if (pGroup != pThis->m_pPressedGroup || pFocused != pThis->m_pPressedObj)
		{
			lv_indev_wait_release (pIndev);
		}

		pData->key = pThis->m_nPressedKey;
		pData->state = LV_INDEV_STATE_RELEASED;
		pThis->m_nPressedKey = 0;
		pData->continue_reading = pThis->m_nTail != pThis->m_nHead;

		return;
	}

	while (pThis->m_nTail != pThis->m_nHead)
	{
		DataMemBarrier ();
		TZgKey Key = pThis->m_Queue[pThis->m_nTail];
		pThis->m_nTail = (pThis->m_nTail + 1) & (QueueSize-1);

		if (   pThis->m_pKeyHook != 0
		    && (*pThis->m_pKeyHook) (Key, pThis->m_pKeyHookParam))
		{
			continue;
		}

		if (Key.nLVKey == 0)
		{
			continue;
		}

		// Space activates buttons, checkboxes, switches... like Enter, as
		// people expect; only text areas get it as a character.
		if (Key.nLVKey == ' ')
		{
			lv_group_t *pGroup = lv_indev_get_group (pIndev);
			lv_obj_t *pFocused = pGroup ? lv_group_get_focused (pGroup) : 0;
			if (pFocused != 0 && !lv_obj_check_type (pFocused, &lv_textarea_class))
			{
				Key.nLVKey = LV_KEY_ENTER;
			}
		}

		// Holding Enter (or Space on a button) must not click again and
		// again: auto-repeat is for moving and typing, not for actions.
		if (Key.bRepeat && Key.nLVKey == LV_KEY_ENTER)
		{
			continue;
		}

		pThis->m_nPressedKey = Key.nLVKey;
		pThis->m_pPressedGroup = lv_indev_get_group (pIndev);
		pThis->m_pPressedObj = pThis->m_pPressedGroup ? lv_group_get_focused (pThis->m_pPressedGroup) : 0;
		pData->key = Key.nLVKey;
		pData->state = LV_INDEV_STATE_PRESSED;
		pData->continue_reading = true;

		return;
	}

	pData->state = LV_INDEV_STATE_RELEASED;
}

boolean CKeyboardIndev::Translate (const char *pString, TZgKey *pKey) const
{
	assert (pString != 0);
	assert (pKey != 0);

	u8 nRaw = m_nRawModifiers;
	pKey->nMods =   ((nRaw & (LSHIFT | RSHIFT)) ? ZG_MOD_SHIFT : 0)
		      | ((nRaw & (LCTRL | RCTRL)) ? ZG_MOD_CTRL : 0)
		      | ((nRaw & ALT) ? ZG_MOD_ALT : 0);	// not AltGr: it types characters on many layouts
	pKey->nLVKey = 0;
	pKey->Name[0] = '\0';

	if (pString[0] == '\0')
	{
		return FALSE;
	}

	if (pString[1] == '\0')
	{
		u8 c = (u8) pString[0];
		switch (c)
		{
		case '\x1b':	pKey->nLVKey = LV_KEY_ESC;	 strcpy (pKey->Name, "Escape");    return TRUE;
		case '\x7f':	pKey->nLVKey = LV_KEY_BACKSPACE; strcpy (pKey->Name, "Backspace"); return TRUE;
		case '\n':	pKey->nLVKey = LV_KEY_ENTER;	 strcpy (pKey->Name, "Enter");     return TRUE;
		case '\t':
			pKey->nLVKey = (pKey->nMods & ZG_MOD_SHIFT) ? LV_KEY_PREV : LV_KEY_NEXT;
			strcpy (pKey->Name, "Tab");
			return TRUE;
		default:
			break;
		}

		if (c >= 1 && c <= 26)		// Ctrl+letter: for apps only
		{
			pKey->Name[0] = 'a' + c - 1;
			pKey->Name[1] = '\0';
			pKey->nMods |= ZG_MOD_CTRL;
			return TRUE;
		}

		if (c >= ' ' && c < 0x7f)
		{
			pKey->Name[0] = c;
			pKey->Name[1] = '\0';
			// Alt+key: for apps only, don't type it
			pKey->nLVKey = (pKey->nMods & ZG_MOD_ALT) ? 0 : c;
			return TRUE;
		}

		return FALSE;
	}

	static const struct
	{
		const char *pSeq;
		u32 nLVKey;
		const char *pName;
	}
	Map[] =
	{
		{"\x1b[A",  LV_KEY_UP,    "ArrowUp"},
		{"\x1b[B",  LV_KEY_DOWN,  "ArrowDown"},
		{"\x1b[C",  LV_KEY_RIGHT, "ArrowRight"},
		{"\x1b[D",  LV_KEY_LEFT,  "ArrowLeft"},
		{"\x1b[1~", LV_KEY_HOME,  "Home"},
		{"\x1b[4~", LV_KEY_END,   "End"},
		{"\x1b[3~", LV_KEY_DEL,   "Delete"},
		{"\x1b[2~", 0,            "Insert"},
		{"\x1b[5~", 0,            "PageUp"},
		{"\x1b[6~", 0,            "PageDown"},
		{"\x1b[[A", 0, "F1"}, {"\x1b[[B", 0, "F2"}, {"\x1b[[C", 0, "F3"},
		{"\x1b[[D", 0, "F4"}, {"\x1b[[E", 0, "F5"}, {"\x1b[17~", 0, "F6"},
		{"\x1b[18~", 0, "F7"}, {"\x1b[19~", 0, "F8"}, {"\x1b[20~", 0, "F9"},
	};

	for (unsigned i = 0; i < sizeof Map / sizeof Map[0]; i++)
	{
		if (strcmp (pString, Map[i].pSeq) == 0)
		{
			pKey->nLVKey = Map[i].nLVKey;
			strcpy (pKey->Name, Map[i].pName);
			return TRUE;
		}
	}

	return FALSE;
}
