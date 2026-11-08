//
// sim.cpp - the simulator's core (see sim.h): the kernel's start-up and
// main loop (src/kernel.cpp) with a memory frame buffer instead of HDMI and
// simulated keyboard and mouse instead of USB.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "sim.h"
#include "../../src/runtime/apphost.h"
#include "../../src/runtime/appstore.h"
#include "../../src/runtime/cursor.h"
#include "../../src/runtime/i18n.h"
#include "../../src/runtime/synthcam.h"
#include "../../src/runtime/version.h"
#include "../../src/crypto/hwrng.h"
#include "../../src/kbdindev.h"
#include "../../src/runtime/keylayout.h"
#include "../../circle/include/circle/input/keymap.h"
#include <circle/logger.h>
#include <circle/timer.h>
#include <circle/usb/usbhid.h>
#include <circle/usb/usbkeyboard.h>
#include <ff.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char From[] = "kernel";

// --- the machine --------------------------------------------------------------

static CZgRandom *s_pRandom;
static CKeyboardIndev *s_pKeyboard;
static CAppHost *s_pAppHost;
static CZgSynthCamera *s_pCamera;
static boolean s_bAttached;

static int s_nWidth, s_nHeight;
static uint16_t *s_pFrame;		// the "HDMI" frame buffer
static uint16_t *s_pDrawBuf1, *s_pDrawBuf2;
static unsigned s_nFrameSerial;
static unsigned s_nLastLVGLUpdate;

static lv_indev_data_t s_Pointer;

// --- display ------------------------------------------------------------------

static void DisplayFlush (lv_display_t *pDisplay, const lv_area_t *pArea, u8 *pBuffer)
{
	const uint16_t *pIn = (const uint16_t *) pBuffer;
	int nAreaWidth = pArea->x2 - pArea->x1 + 1;
	for (int y = pArea->y1; y <= pArea->y2; y++)
	{
		memcpy (s_pFrame + y * s_nWidth + pArea->x1, pIn, nAreaWidth * sizeof (uint16_t));
		pIn += nAreaWidth;
	}
	s_nFrameSerial++;

	lv_display_flush_ready (pDisplay);
}

static uint32_t TickCallback (void)
{
	return (uint32_t) (CTimer::GetClockTicks64 () / 1000);
}

static void LogPrint (lv_log_level_t Level, const char *pMessage)
{
	char Buffer[512];
	snprintf (Buffer, sizeof Buffer, "%s", pMessage);
	size_t n = strlen (Buffer);
	if (n > 0 && Buffer[n - 1] == '\n')
	{
		Buffer[n - 1] = '\0';
	}
	CLogger::Get ()->Write ("lvgl", Level == LV_LOG_LEVEL_ERROR ? LogError
				: Level == LV_LOG_LEVEL_WARN ? LogWarning : LogNotice, "%s", Buffer);
}

static void PointerRead (lv_indev_t *pIndev, lv_indev_data_t *pData)
{
	(void) pIndev;
	pData->point = s_Pointer.point;
	pData->state = s_Pointer.state;
}

// as Circle's LVGL addon (circle/addon/lvgl/lvgl.cpp), with a full frame
// buffer for screenshots and the browser canvas
static void InitGUI (void)
{
	lv_init ();
	lv_log_register_print_cb (LogPrint);
	lv_tick_set_cb (TickCallback);

	s_pFrame = (uint16_t *) calloc ((size_t) s_nWidth * s_nHeight, sizeof (uint16_t));
	unsigned nBufSizePixels = s_nWidth * s_nHeight / 10;
	s_pDrawBuf1 = (uint16_t *) malloc (nBufSizePixels * sizeof (uint16_t));
	s_pDrawBuf2 = (uint16_t *) malloc (nBufSizePixels * sizeof (uint16_t));

	lv_display_t *pDisplay = lv_display_create (s_nWidth, s_nHeight);
	lv_display_set_flush_cb (pDisplay, DisplayFlush);
	lv_display_set_buffers (pDisplay, s_pDrawBuf1, s_pDrawBuf2, nBufSizePixels * sizeof (uint16_t),
				LV_DISPLAY_RENDER_MODE_PARTIAL);

	// the mouse, at the centre of the screen as on the Pi
	s_Pointer.point.x = (s_nWidth + 1) / 2;
	s_Pointer.point.y = (s_nHeight + 1) / 2;
	s_Pointer.state = LV_INDEV_STATE_RELEASED;
	lv_indev_t *pIndev = lv_indev_create ();
	lv_indev_set_type (pIndev, LV_INDEV_TYPE_POINTER);
	lv_indev_set_read_cb (pIndev, PointerRead);
	lv_obj_t *pCursor = lv_image_create (lv_screen_active ());
	lv_indev_set_cursor (pIndev, pCursor);
	ZgInstallCursor ();
}

void zg_sim_set_builtin_dir (const char *dir)
{
	ZgSimSetBuiltinRoot (dir);
}

static const char *s_pLanguage;		// --lang, over zerogap.txt

void zg_sim_set_language (const char *tag)
{
	s_pLanguage = tag;
}

int zg_sim_language (const char *tag)
{
	return CZgI18n::SetLanguage (tag, "simulator") ? 0 : -1;
}

int zg_sim_boot (int width, int height, const char *card)
{
	ZgSimClockStart ();
	s_nWidth = width;
	s_nHeight = height;

	s_pRandom = new CZgRandom;
	s_pRandom->Initialize ();

	ZgSimSetCardRoot (card);
#ifndef ZG_SEALED
	CAppStore::Initialize (card != 0);
#else
	CAppStore::Initialize (FALSE);
#endif

	InitGUI ();

	s_pKeyboard = new CKeyboardIndev;
	s_pKeyboard->Initialize ();

	CLogger::Get ()->Write (From, LogNotice, "zerogap " ZEROGAP_VERSION " (simulator), built " __DATE__ " " __TIME__);
	CLogger::Get ()->Write (From, LogNotice, "Screen %ux%u", (unsigned) width, (unsigned) height);

	s_pCamera = new CZgSynthCamera;
	CZgCamera::Set (s_pCamera);

	if (s_pLanguage != 0 && !CZgI18n::SetLanguage (s_pLanguage, "--lang"))
	{
		return -1;
	}

	s_pAppHost = new CAppHost (s_pKeyboard);
	return s_pAppHost->Initialize () ? 0 : -1;
}

// --- keyboard -----------------------------------------------------------------

// A key as Circle's USB keyboard driver delivers it: the HID report's
// modifier byte, and the string its keymap makes of the key (empty for a
// modifier key alone, like the Windows key).
struct TSimKey
{
	char String[8];
	u8 nModifiers;
};

static boolean s_bKeyDown;
static TSimKey s_Key;
static unsigned s_nNextRepeat;		// clock ticks

static const unsigned RepeatDelay = 400000;	// patches/circle/0002: 400 ms, then
static const unsigned RepeatRate = 80000;	// every 80 ms

static void SimKeyDown (const TSimKey &rKey, u8 nUsage = 4)
{
	if (s_bKeyDown)
	{
		zg_sim_key_up ();
	}

	CUSBKeyboardDevice *pKeyboard = ZgSimKeyboard ();
	unsigned char Raw[6] = {0};
	if (rKey.String[0] != '\0')
	{
		Raw[0] = nUsage;		// kbdindev only sees that a key went down
	}
	pKeyboard->Report (rKey.nModifiers, Raw);
	if (rKey.String[0] != '\0')
	{
		pKeyboard->Pressed (rKey.String);
	}

	s_Key = rKey;
	s_bKeyDown = TRUE;
	s_nNextRepeat = CTimer::GetClockTicks () + RepeatDelay;
}

void zg_sim_key_up (void)
{
	if (!s_bKeyDown)
	{
		return;
	}
	unsigned char Raw[6] = {0};
	ZgSimKeyboard ()->Report (0, Raw);
	s_bKeyDown = FALSE;
}

static void KeyRepeat (void)
{
	if (   s_bKeyDown
	    && s_Key.String[0] != '\0'
	    && (int) (CTimer::GetClockTicks () - s_nNextRepeat) >= 0)
	{
		ZgSimKeyboard ()->Pressed (s_Key.String);	// no report: a repeat
		s_nNextRepeat += RepeatRate;
	}
}

// Special keys, as Circle's keymap spells them (and src/kbdindev.cpp reads them)
static const struct { const char *pQemu, *pDom, *pString; } SpecialKeys[] =
{
	{"ret",       "Enter",      "\n"},
	{"kp_enter",  0,            "\n"},
	{"tab",       "Tab",        "\t"},
	{"esc",       "Escape",     "\x1b"},
	{"backspace", "Backspace",  "\x7f"},
	{"spc",       " ",          " "},
	{"up",        "ArrowUp",    "\x1b[A"},
	{"down",      "ArrowDown",  "\x1b[B"},
	{"right",     "ArrowRight", "\x1b[C"},
	{"left",      "ArrowLeft",  "\x1b[D"},
	{"home",      "Home",       "\x1b[1~"},
	{"end",       "End",        "\x1b[4~"},
	{"delete",    "Delete",     "\x1b[3~"},
	{"insert",    "Insert",     "\x1b[2~"},
	{"pgup",      "PageUp",     "\x1b[5~"},
	{"pgdn",      "PageDown",   "\x1b[6~"},
	{"f1", "F1", "\x1b[[A"}, {"f2", "F2", "\x1b[[B"}, {"f3", "F3", "\x1b[[C"},
	{"f4", "F4", "\x1b[[D"}, {"f5", "F5", "\x1b[[E"}, {"f6", "F6", "\x1b[17~"},
	{"f7", "F7", "\x1b[18~"}, {"f8", "F8", "\x1b[19~"}, {"f9", "F9", "\x1b[20~"},
};

// Circle's keymaps (circle/lib/input/keymap_*.h; "BR": patches/circle/0005),
// as src/kbdindev.cpp gets them on the Pi
#define C(chr)		((u16) (u8) (chr))
static const u16 KeyMapUS[PHY_MAX_CODE+1][K_CTRLTAB+1] =
{
#include "../../circle/lib/input/keymap_us.h"
};
static const u16 KeyMapBR[PHY_MAX_CODE+1][K_CTRLTAB+1] =
{
#include "../../circle/lib/input/keymap_br.h"
};
#undef C

// QEMU names of the character keys, and their USB HID usages: keys by their
// place on a US keyboard, whatever they type ("less" and "ro" are the two
// keys a US keyboard doesn't have: ABNT2's "\ |" and "/ ?")
static const struct { const char *pQemu; u8 nUsage; } CharKeys[] =
{
	{"minus", 0x2D}, {"equal", 0x2E}, {"bracket_left", 0x2F}, {"bracket_right", 0x30},
	{"backslash", 0x31}, {"semicolon", 0x33}, {"apostrophe", 0x34}, {"grave_accent", 0x35},
	{"comma", 0x36}, {"dot", 0x37}, {"slash", 0x38}, {"less", 0x64}, {"ro", 0x87},
	{"1", 0x1E}, {"2", 0x1F}, {"3", 0x20}, {"4", 0x21}, {"5", 0x22},
	{"6", 0x23}, {"7", 0x24}, {"8", 0x25}, {"9", 0x26}, {"0", 0x27},
};

#define ZG_SIM_MOD_ALTGR	8	// "alt_r-": the right Alt, AltGr

static u8 HIDModifiers (int nMods)
{
	return   ((nMods & ZG_SIM_MOD_SHIFT) ? LSHIFT : 0)
	       | ((nMods & ZG_SIM_MOD_CTRL) ? LCTRL : 0)
	       | ((nMods & ZG_SIM_MOD_ALT) ? ALT : 0)
	       | ((nMods & ZG_SIM_MOD_ALTGR) ? ALTGR : 0);
}

// What Circle's keymap types for this key: Ctrl+letter is the control
// character, Alt+key nothing (as Circle's CKeyMap::Translate, without Caps
// Lock and Num Lock). FALSE: the key types nothing.
static boolean KeyMapString (u8 nUsage, int nMods, TSimKey *pKey)
{
	const u16 (*pMap)[K_CTRLTAB+1] =
		strcmp (ZgSimKeyboard ()->GetKeyMap (), "BR") == 0 ? KeyMapBR : KeyMapUS;
	pKey->nModifiers = HIDModifiers (nMods);
	if (nMods & ZG_SIM_MOD_ALT)
	{
		return FALSE;
	}
	boolean bShift = (nMods & ZG_SIM_MOD_SHIFT) != 0;
	unsigned nTable =   (nMods & ZG_SIM_MOD_ALTGR) ? (bShift ? K_ALTSHIFTTAB : K_ALTTAB)
			  : bShift ? K_SHIFTTAB : K_NORMTAB;
	u16 nCode = pMap[nUsage][nTable];
	char c;
	if (nCode > ' ' && nCode < 0x100)
	{
		c = (char) nCode;
	}
	else if (nCode == KeyKP_Comma || nCode == KeyKP_Period)
	{
		c = nCode == KeyKP_Comma ? ',' : '.';
	}
	else
	{
		return FALSE;
	}
	if (nMods & ZG_SIM_MOD_CTRL)
	{
		if (c < 'a' || c > 'z')
		{
			return FALSE;
		}
		c = (char) (c - 'a' + 1);
	}
	pKey->String[0] = c;
	pKey->String[1] = '\0';
	return TRUE;
}

int zg_sim_keyboard (const char *pLayout)
{
	return ZgKeyLayoutSet (pLayout, "simulator") ? 0 : -1;
}

// A printable character with modifiers, as Circle's keymap gives it:
// Ctrl+letter is the control character.
static void Printable (char c, int nMods, TSimKey *pKey)
{
	pKey->nModifiers = HIDModifiers (nMods);
	if ((nMods & ZG_SIM_MOD_CTRL) && isalpha ((unsigned char) c))
	{
		c = (char) (tolower ((unsigned char) c) - 'a' + 1);
	}
	pKey->String[0] = c;
	pKey->String[1] = '\0';
}

int zg_sim_key_down_qemu (const char *pName)
{
	// "shift-", "ctrl-", "alt-" prefixes
	int nMods = 0;
	for (;;)
	{
		if (strncmp (pName, "shift-", 6) == 0)		{ nMods |= ZG_SIM_MOD_SHIFT; pName += 6; }
		else if (strncmp (pName, "ctrl-", 5) == 0)	{ nMods |= ZG_SIM_MOD_CTRL; pName += 5; }
		else if (strncmp (pName, "alt-", 4) == 0)	{ nMods |= ZG_SIM_MOD_ALT; pName += 4; }
		else if (strncmp (pName, "alt_r-", 6) == 0)	{ nMods |= ZG_SIM_MOD_ALTGR; pName += 6; }
		else break;
	}

	TSimKey Key;
	memset (&Key, 0, sizeof Key);

	if (strcmp (pName, "meta_l") == 0 || strcmp (pName, "meta_r") == 0)
	{
		Key.nModifiers = HIDModifiers (nMods) | (pName[5] == 'l' ? LWIN : RWIN);
		SimKeyDown (Key);
		return 0;
	}

	for (unsigned i = 0; i < sizeof SpecialKeys / sizeof SpecialKeys[0]; i++)
	{
		if (strcmp (pName, SpecialKeys[i].pQemu) == 0)
		{
			Key.nModifiers = HIDModifiers (nMods);
			strcpy (Key.String, SpecialKeys[i].pString);
			SimKeyDown (Key);
			return 0;
		}
	}

	u8 nUsage = 0;
	for (unsigned i = 0; i < sizeof CharKeys / sizeof CharKeys[0]; i++)
	{
		if (strcmp (pName, CharKeys[i].pQemu) == 0)
		{
			nUsage = CharKeys[i].nUsage;
		}
	}
	if (pName[0] >= 'a' && pName[0] <= 'z' && pName[1] == '\0')
	{
		nUsage = 0x04 + (pName[0] - 'a');
	}
	if (nUsage != 0)
	{
		if (!KeyMapString (nUsage, nMods, &Key))
		{
			Key.String[0] = '\0';		// a key down, nothing typed
		}
		SimKeyDown (Key, nUsage);
		return 0;
	}

	return -1;
}

int zg_sim_key_down_dom (const char *pKey, int nMods)
{
	TSimKey Key;
	memset (&Key, 0, sizeof Key);

	if (strcmp (pKey, "Meta") == 0 || strcmp (pKey, "OS") == 0)
	{
		Key.nModifiers = HIDModifiers (nMods) | LWIN;
		SimKeyDown (Key);
		return 0;
	}

	for (unsigned i = 0; i < sizeof SpecialKeys / sizeof SpecialKeys[0]; i++)
	{
		if (SpecialKeys[i].pDom != 0 && strcmp (pKey, SpecialKeys[i].pDom) == 0)
		{
			Key.nModifiers = HIDModifiers (nMods);
			strcpy (Key.String, SpecialKeys[i].pString);
			SimKeyDown (Key);
			return 0;
		}
	}

	// one printable ASCII character: the browser already applied Shift and
	// the keyboard layout
	if ((unsigned char) pKey[0] >= ' ' && (unsigned char) pKey[0] < 0x7f && pKey[1] == '\0')
	{
		Printable (pKey[0], nMods, &Key);
		SimKeyDown (Key);
		return 0;
	}

	return -1;		// Shift, Control, Alt alone, dead keys, non-ASCII
}

int zg_sim_launch (const char *pID)
{
	return s_pAppHost->RequestLaunch (pID) ? 0 : -1;
}

// --- pointer ------------------------------------------------------------------

void zg_sim_pointer (int x, int y, int pressed)
{
	s_Pointer.point.x = x < 0 ? 0 : x >= s_nWidth ? s_nWidth - 1 : x;
	s_Pointer.point.y = y < 0 ? 0 : y >= s_nHeight ? s_nHeight - 1 : y;
	s_Pointer.state = pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

// --- main loop ----------------------------------------------------------------

void zg_sim_step (void)
{
	// USB plug-and-play: the keyboard turns up at the first pass
	boolean bUpdated = !s_bAttached;
	s_bAttached = TRUE;

	KeyRepeat ();
	s_pKeyboard->Update (bUpdated);

	// LVGL every 5 ms, as Circle's addon runs it
	unsigned nTicks = CTimer::GetClockTicks ();
	if (nTicks - s_nLastLVGLUpdate >= 5 * CLOCKHZ / 1000)
	{
		lv_timer_handler ();
		s_nLastLVGLUpdate = nTicks;
	}

	s_pAppHost->Update ();
}

const uint16_t *zg_sim_frame (int *width, int *height)
{
	*width = s_nWidth;
	*height = s_nHeight;
	return s_pFrame;
}

unsigned zg_sim_frame_serial (void)
{
	return s_nFrameSerial;
}

// --- camera -------------------------------------------------------------------
// (Never logs what the camera shows: a QR code may hold a secret.)

int zg_sim_camera (const char *mode)
{
	if (s_pCamera == 0)
	{
		return -1;
	}
	if (strcmp (mode, "none") == 0)
	{
		s_pCamera->SetNone ();
	}
	else if (strcmp (mode, "scene") == 0)
	{
		s_pCamera->SetScene ();
	}
	else
	{
		return -1;
	}
	CLogger::Get ()->Write ("camera", LogNotice, "%s", mode);
	return 0;
}

int zg_sim_camera_qr (const uint8_t *data, unsigned length, int quiet)
{
	if (s_pCamera == 0 || !s_pCamera->SetQR (data, length))
	{
		return -1;
	}
	if (!quiet)
	{
		CLogger::Get ()->Write ("camera", LogNotice, "a QR code of %u bytes", length);
	}
	return 0;
}

int zg_sim_camera_picture (const uint8_t *grey, unsigned width, unsigned height)
{
	if (s_pCamera == 0 || !s_pCamera->SetPicture (grey, width, height))
	{
		return -1;
	}
	CLogger::Get ()->Write ("camera", LogNotice, "a picture, %ux%u", width, height);
	return 0;
}

int zg_sim_camera_push (const uint8_t *grey, unsigned width, unsigned height)
{
	return s_pCamera != 0 && s_pCamera->PushFrame (grey, width, height) ? 0 : -1;
}

int zg_sim_camera_picture_rgb (const uint8_t *rgb, unsigned width, unsigned height)
{
	if (s_pCamera == 0 || !s_pCamera->SetPictureRGB (rgb, width, height))
	{
		return -1;
	}
	CLogger::Get ()->Write ("camera", LogNotice, "a colour picture, %ux%u", width, height);
	return 0;
}

int zg_sim_camera_push_rgb (const uint8_t *rgb, unsigned width, unsigned height)
{
	return s_pCamera != 0 && s_pCamera->PushFrameRGB (rgb, width, height) ? 0 : -1;
}
