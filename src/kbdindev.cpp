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
#include <assert.h>

static const char FromKbd[] = "kbd";

CKeyboardIndev *CKeyboardIndev::s_pThis = 0;

CKeyboardIndev::CKeyboardIndev (void)
:	m_pKeyboard (0),
	m_pIndev (0),
	m_pGroup (0),
	m_nHead (0),
	m_nTail (0),
	m_nPressedKey (0)
{
	assert (s_pThis == 0);
	s_pThis = this;
}

void CKeyboardIndev::Initialize (void)
{
	m_pGroup = lv_group_create ();
	lv_group_set_default (m_pGroup);

	m_pIndev = lv_indev_create ();
	lv_indev_set_type (m_pIndev, LV_INDEV_TYPE_KEYPAD);
	lv_indev_set_read_cb (m_pIndev, ReadCallback);
	lv_indev_set_group (m_pIndev, m_pGroup);
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

			CLogger::Get ()->Write (FromKbd, LogNotice, "Keyboard attached");
		}
	}

	if (m_pKeyboard != 0)
	{
		// must not be called from interrupt context
		m_pKeyboard->UpdateLEDs ();
	}
}

void CKeyboardIndev::KeyPressedHandler (const char *pString)
{
	assert (s_pThis != 0);

	u32 nKey = Translate (pString);
	if (nKey != 0)
	{
		s_pThis->Enqueue (nKey);
	}
}

void CKeyboardIndev::KeyboardRemovedHandler (CDevice *pDevice, void *pContext)
{
	assert (s_pThis != 0);
	s_pThis->m_pKeyboard = 0;

	CLogger::Get ()->Write (FromKbd, LogNotice, "Keyboard removed");
}

void CKeyboardIndev::Enqueue (u32 nKey)
{
	unsigned nNext = (m_nHead + 1) & (QueueSize-1);
	if (nNext == m_nTail)
	{
		return;		// full: drop the key rather than block in IRQ context
	}

	m_Queue[m_nHead] = nKey;
	DataMemBarrier ();
	m_nHead = nNext;
}

// Each queued key becomes one PRESSED report followed by one RELEASED report.
// Circle already generates auto-repeat, so LVGL's own long-press repeat is
// not needed.
void CKeyboardIndev::ReadCallback (lv_indev_t *pIndev, lv_indev_data_t *pData)
{
	assert (s_pThis != 0);
	CKeyboardIndev *pThis = s_pThis;

	if (pThis->m_nPressedKey != 0)
	{
		pData->key = pThis->m_nPressedKey;
		pData->state = LV_INDEV_STATE_RELEASED;
		pThis->m_nPressedKey = 0;

		// more keys waiting? have LVGL call us again right away
		pData->continue_reading = pThis->m_nTail != pThis->m_nHead;

		return;
	}

	if (pThis->m_nTail == pThis->m_nHead)
	{
		pData->state = LV_INDEV_STATE_RELEASED;
		return;
	}

	DataMemBarrier ();
	u32 nKey = pThis->m_Queue[pThis->m_nTail];
	pThis->m_nTail = (pThis->m_nTail + 1) & (QueueSize-1);

	pThis->m_nPressedKey = nKey;
	pData->key = nKey;
	pData->state = LV_INDEV_STATE_PRESSED;
	pData->continue_reading = true;
}

u32 CKeyboardIndev::Translate (const char *pString)
{
	assert (pString != 0);

	if (pString[0] == '\0')
	{
		return 0;
	}

	if (pString[1] == '\0')
	{
		switch (pString[0])
		{
		case '\x1b':	return LV_KEY_ESC;
		case '\x7f':	return LV_KEY_BACKSPACE;
		case '\t':	return LV_KEY_NEXT;
		case '\n':	return LV_KEY_ENTER;
		default:	break;
		}

		u8 c = (u8) pString[0];
		if (c >= ' ' && c < 0x7f)
		{
			return c;
		}

		return 0;	// other control characters (Ctrl+letter) unused for now
	}

	static const struct
	{
		const char *pSeq;
		u32 nKey;
	}
	Map[] =
	{
		{"\x1b[A",  LV_KEY_UP},
		{"\x1b[B",  LV_KEY_DOWN},
		{"\x1b[C",  LV_KEY_RIGHT},
		{"\x1b[D",  LV_KEY_LEFT},
		{"\x1b[1~", LV_KEY_HOME},
		{"\x1b[4~", LV_KEY_END},
		{"\x1b[3~", LV_KEY_DEL},
		{"\x1b[5~", LV_KEY_PREV},	// PageUp: previous widget (no Shift+Tab in cooked mode)
		{"\x1b[6~", LV_KEY_NEXT},	// PageDown: next widget
	};

	for (unsigned i = 0; i < sizeof Map / sizeof Map[0]; i++)
	{
		if (strcmp (pString, Map[i].pSeq) == 0)
		{
			return Map[i].nKey;
		}
	}

	return 0;
}
