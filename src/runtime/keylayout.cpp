//
// keylayout.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "keylayout.h"
#include <circle/logger.h>
#include <circle/string.h>
#include <circle/util.h>

#ifndef GK_KEYBOARD
#define GK_KEYBOARD	"us"		// make KEYBOARD=... (src/Makefile)
#endif

static const char From[] = "keyboard";

static const struct TLayout
{
	const char *pName;
	const char *pCircleMap;
	boolean bDeadKeys;
}
Layouts[] =
{
	{"us",       "US", FALSE},
	{"br-abnt2", "BR", TRUE},
};
static const unsigned LayoutCount = sizeof Layouts / sizeof Layouts[0];

static const char *const Names[LayoutCount + 1] = {"us", "br-abnt2", 0};

static int s_nLayout = -1;		// -1: the build's default, not looked up yet
static volatile unsigned s_nGeneration = 0;

static int Find (const char *pName)
{
	for (unsigned i = 0; i < LayoutCount; i++)
	{
		if (strcmp (Layouts[i].pName, pName) == 0)
		{
			return (int) i;
		}
	}
	return -1;
}

static const TLayout &Current (void)
{
	if (s_nLayout < 0)
	{
		s_nLayout = Find (GK_KEYBOARD);
		if (s_nLayout < 0)		// src/Makefile checks KEYBOARD
		{
			s_nLayout = 0;
		}
	}
	return Layouts[s_nLayout];
}

const char *const *GkKeyLayouts (void)
{
	return Names;
}

const char *GkKeyLayoutGet (void)
{
	return Current ().pName;
}

boolean GkKeyLayoutSet (const char *pName, const char *pFrom)
{
	int n = pName != 0 ? Find (pName) : -1;
	if (n < 0)
	{
		CLogger::Get ()->Write (From, LogWarning, "no layout \"%s\" (%s): still %s",
					pName != 0 ? pName : "", pFrom, GkKeyLayoutGet ());
		return FALSE;
	}

	s_nLayout = n;
	s_nGeneration++;
	CLogger::Get ()->Write (From, LogNotice, "layout %s (%s)", pName, pFrom);
	return TRUE;
}

boolean GkKeyLayoutConfigure (const char *pKey, const char *pValue, unsigned nLine)
{
	if (strcmp (pKey, "keyboard") != 0)
	{
		return FALSE;
	}
	if (Find (pValue) < 0)
	{
		CString List;
		for (unsigned i = 0; i < LayoutCount; i++)
		{
			List.Append (i == 0 ? "" : ", ");
			List.Append (Layouts[i].pName);
		}
		CLogger::Get ()->Write (From, LogWarning, "gapkeep.txt:%u: keyboard: one of %s expected",
					nLine, (const char *) List);
		return TRUE;
	}
	GkKeyLayoutSet (pValue, "gapkeep.txt");
	return TRUE;
}

const char *GkKeyLayoutCircleMap (void)
{
	return Current ().pCircleMap;
}

unsigned GkKeyLayoutGeneration (void)
{
	return s_nGeneration;
}

// --- dead keys -------------------------------------------------------------------

// The spacing accents the keymap gives for dead keys
static const u32 Acute = 0xB4, Grave = 0x60, Tilde = 0x7E, Circumflex = 0x5E, Diaeresis = 0xA8;

// accent, base letter, composed letter: Latin-1 and Latin Extended-A, which
// GapKeep's fonts have
static const struct { u16 nAccent, nBase, nComposed; } Compose[] =
{
	{Acute, 'a', 0xE1}, {Acute, 'e', 0xE9}, {Acute, 'i', 0xED}, {Acute, 'o', 0xF3},
	{Acute, 'u', 0xFA}, {Acute, 'y', 0xFD}, {Acute, 'A', 0xC1}, {Acute, 'E', 0xC9},
	{Acute, 'I', 0xCD}, {Acute, 'O', 0xD3}, {Acute, 'U', 0xDA}, {Acute, 'Y', 0xDD},
	{Acute, 'c', 0x107}, {Acute, 'C', 0x106}, {Acute, 'n', 0x144}, {Acute, 'N', 0x143},
	{Acute, 's', 0x15B}, {Acute, 'S', 0x15A}, {Acute, 'z', 0x17A}, {Acute, 'Z', 0x179},
	{Acute, 'l', 0x13A}, {Acute, 'L', 0x139}, {Acute, 'r', 0x155}, {Acute, 'R', 0x154},

	{Grave, 'a', 0xE0}, {Grave, 'e', 0xE8}, {Grave, 'i', 0xEC}, {Grave, 'o', 0xF2},
	{Grave, 'u', 0xF9}, {Grave, 'A', 0xC0}, {Grave, 'E', 0xC8}, {Grave, 'I', 0xCC},
	{Grave, 'O', 0xD2}, {Grave, 'U', 0xD9},

	{Circumflex, 'a', 0xE2}, {Circumflex, 'e', 0xEA}, {Circumflex, 'i', 0xEE},
	{Circumflex, 'o', 0xF4}, {Circumflex, 'u', 0xFB}, {Circumflex, 'A', 0xC2},
	{Circumflex, 'E', 0xCA}, {Circumflex, 'I', 0xCE}, {Circumflex, 'O', 0xD4},
	{Circumflex, 'U', 0xDB}, {Circumflex, 'c', 0x109}, {Circumflex, 'C', 0x108},
	{Circumflex, 'g', 0x11D}, {Circumflex, 'G', 0x11C}, {Circumflex, 'h', 0x125},
	{Circumflex, 'H', 0x124}, {Circumflex, 'j', 0x135}, {Circumflex, 'J', 0x134},
	{Circumflex, 's', 0x15D}, {Circumflex, 'S', 0x15C}, {Circumflex, 'w', 0x175},
	{Circumflex, 'W', 0x174}, {Circumflex, 'y', 0x177}, {Circumflex, 'Y', 0x176},

	{Tilde, 'a', 0xE3}, {Tilde, 'o', 0xF5}, {Tilde, 'n', 0xF1}, {Tilde, 'A', 0xC3},
	{Tilde, 'O', 0xD5}, {Tilde, 'N', 0xD1}, {Tilde, 'i', 0x129}, {Tilde, 'I', 0x128},
	{Tilde, 'u', 0x169}, {Tilde, 'U', 0x168},

	{Diaeresis, 'a', 0xE4}, {Diaeresis, 'e', 0xEB}, {Diaeresis, 'i', 0xEF},
	{Diaeresis, 'o', 0xF6}, {Diaeresis, 'u', 0xFC}, {Diaeresis, 'y', 0xFF},
	{Diaeresis, 'A', 0xC4}, {Diaeresis, 'E', 0xCB}, {Diaeresis, 'I', 0xCF},
	{Diaeresis, 'O', 0xD6}, {Diaeresis, 'U', 0xDC}, {Diaeresis, 'Y', 0x178},
};

static boolean IsDead (u32 nChar)
{
	return    nChar == Acute || nChar == Grave || nChar == Tilde
	       || nChar == Circumflex || nChar == Diaeresis;
}

unsigned CGkDeadKeys::Feed (u32 nChar, boolean bRepeat, boolean bCancelKey,
			    u32 pOut[2], boolean *pbConsumed)
{
	*pbConsumed = FALSE;

	if (!Current ().bDeadKeys)
	{
		m_nPending = 0;
		if (nChar == 0)
		{
			return 0;
		}
		pOut[0] = nChar;
		return 1;
	}

	if (nChar == 0)			// Enter, an arrow, Backspace...: cancels
	{
		if (m_nPending != 0)
		{
			m_nPending = 0;
			*pbConsumed = bCancelKey;
		}
		return 0;
	}

	if (IsDead (nChar))
	{
		if (bRepeat)		// holding a dead key does nothing more
		{
			return 0;
		}
		u32 nPrevious = m_nPending;
		if (nPrevious == 0)
		{
			m_nPending = nChar;
			return 0;
		}
		if (nPrevious == nChar)	// twice: the accent, once
		{
			m_nPending = 0;
			pOut[0] = nChar;
			return 1;
		}
		m_nPending = nChar;	// another one: the first is typed as is
		pOut[0] = nPrevious;
		return 1;
	}

	u32 nAccent = m_nPending;
	if (nAccent == 0)
	{
		pOut[0] = nChar;
		return 1;
	}
	m_nPending = 0;

	if (nChar == ' ')
	{
		pOut[0] = nAccent;
		return 1;
	}
	for (unsigned i = 0; i < sizeof Compose / sizeof Compose[0]; i++)
	{
		if (Compose[i].nAccent == nAccent && Compose[i].nBase == nChar)
		{
			pOut[0] = Compose[i].nComposed;
			return 1;
		}
	}
	pOut[0] = nAccent;
	pOut[1] = nChar;
	return 2;
}

unsigned GkUtf8Encode (u32 nChar, char pBuf[5])
{
	unsigned n;
	if (nChar < 0x80)
	{
		pBuf[0] = (char) nChar;
		n = 1;
	}
	else if (nChar < 0x800)
	{
		pBuf[0] = (char) (0xC0 | (nChar >> 6));
		pBuf[1] = (char) (0x80 | (nChar & 0x3F));
		n = 2;
	}
	else if (nChar < 0x10000)
	{
		pBuf[0] = (char) (0xE0 | (nChar >> 12));
		pBuf[1] = (char) (0x80 | ((nChar >> 6) & 0x3F));
		pBuf[2] = (char) (0x80 | (nChar & 0x3F));
		n = 3;
	}
	else
	{
		pBuf[0] = (char) (0xF0 | (nChar >> 18));
		pBuf[1] = (char) (0x80 | ((nChar >> 12) & 0x3F));
		pBuf[2] = (char) (0x80 | ((nChar >> 6) & 0x3F));
		pBuf[3] = (char) (0x80 | (nChar & 0x3F));
		n = 4;
	}
	pBuf[n] = '\0';
	return n;
}
