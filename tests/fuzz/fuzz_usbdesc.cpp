//
// fuzz_usbdesc.cpp - fuzzes the descriptor parsers of gk:usb
// (src/runtime/usbdesc.c) with AddressSanitizer and UBSan: a claimed device
// sends its device, configuration and string descriptors, and a hostile one
// chooses every byte. Built and run by tools/fuzz_usbdesc.sh.
//
// First fixed cases: the descriptors of real devices (a DigiMacro, the test
// stub's device) and malformed ones, each with the expected outcome. Then
// rounds of random bytes, and of good descriptors mutated (bytes flipped or
// replaced by telling values: 0, 1, 2, 9, 0xFF; lengths cut short or made
// long; descriptors inserted or removed). Every input is a heap block of
// exactly its length, so reading past it is caught. For each:
//
//  - gk_usb_parse_device / _config / _langid / _string must not touch
//    memory outside the input or the output;
//  - an accepted configuration holds at most GK_USB_MAX_INTERFACES
//    interfaces, with different numbers, each found in the input as an
//    interface descriptor of alternate setting 0;
//  - a string is NUL-terminated inside its buffer, valid UTF-8, and holds
//    no character textcheck.h forbids.
//
//   fuzz_usbdesc ROUNDS SEED
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "../../src/runtime/usbdesc.h"
#include "../../src/runtime/textcheck.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

typedef std::vector<uint8_t> Bytes;

static uint32_t s_nRandom = 1;
static uint32_t Rand (void)		// xorshift32: reproducible from the seed
{
	s_nRandom ^= s_nRandom << 13;
	s_nRandom ^= s_nRandom >> 17;
	s_nRandom ^= s_nRandom << 5;
	return s_nRandom;
}
static unsigned Below (unsigned n)	{ return n ? Rand () % n : 0; }

static unsigned s_nFailures = 0;
static void Fail (const char *pWhat, const Bytes &Data)
{
	fprintf (stderr, "FAIL: %s; input (%zu bytes):", pWhat, Data.size ());
	for (size_t i = 0; i < Data.size () && i < 128; i++)
	{
		fprintf (stderr, " %02x", Data[i]);
	}
	fprintf (stderr, "\n");
	if (++s_nFailures > 20)
	{
		exit (1);
	}
}

// the input in a heap block of exactly its size (ASan sees every overread)
struct THeap
{
	uint8_t *p;
	THeap (const Bytes &b) : p ((uint8_t *) malloc (b.size () ? b.size () : 1))
	{
		if (!b.empty ())
		{
			memcpy (p, b.data (), b.size ());
		}
	}
	~THeap (void)		{ free (p); }
};

static int ParseConfig (const Bytes &b, gk_usb_config_t *pConfig)
{
	THeap h (b);
	int n = gk_usb_parse_config (h.p, b.size (), pConfig);
	if (n == 0)
	{
		if (pConfig->interface_count > GK_USB_MAX_INTERFACES)
		{
			Fail ("too many interfaces", b);
		}
		for (unsigned i = 0; i < pConfig->interface_count; i++)
		{
			for (unsigned k = 0; k < i; k++)
			{
				if (pConfig->interfaces[k].number == pConfig->interfaces[i].number)
				{
					Fail ("an interface number twice", b);
				}
			}
			// it is in the input, as an interface descriptor of alternate 0
			bool bFound = false;
			for (size_t j = 0; j + 9 <= b.size () && !bFound; j++)
			{
				bFound =    b[j] >= 9 && b[j + 1] == 4 && b[j + 2] == pConfig->interfaces[i].number
					 && b[j + 3] == 0 && b[j + 5] == pConfig->interfaces[i].cls;
			}
			if (!bFound)
			{
				Fail ("an interface that is not in the descriptor", b);
			}
		}
	}
	else
	{
		if (n != -1)
		{
			Fail ("parse_config returned neither 0 nor -1", b);
		}
	}
	return n;
}

static int ParseString (const Bytes &b, char *pOut = 0, size_t nOutSize = GK_USB_MAX_STRING)
{
	THeap h (b);
	char *pBuf = (char *) malloc (nOutSize);
	int n = gk_usb_parse_string (h.p, b.size (), pBuf, nOutSize);
	if (n >= 0)
	{
		if ((size_t) n >= nOutSize || pBuf[n] != '\0' || strlen (pBuf) != (size_t) n)
		{
			Fail ("a string not NUL-terminated at its length", b);
		}
		else if (!gk_text_is_clean (pBuf, n, 0))
		{
			Fail ("a string with a forbidden character or bad UTF-8", b);
		}
	}
	else if (nOutSize >= 4 && pBuf[0] != '\0')
	{
		Fail ("a refused string not empty", b);
	}
	if (pOut != 0 && n >= 0)
	{
		memcpy (pOut, pBuf, n + 1);
	}
	free (pBuf);
	return n;
}

static void Everything (const Bytes &b)
{
	THeap h (b);
	gk_usb_device_desc_t Desc;
	gk_usb_parse_device (h.p, b.size (), &Desc);
	gk_usb_config_total (h.p, b.size ());
	gk_usb_config_t Config;
	ParseConfig (b, &Config);
	uint16_t usLang;
	gk_usb_parse_langid (h.p, b.size (), &usLang);
	ParseString (b);
	ParseString (b, 0, 4 + Below (8));	// small buffers: cut at a character
}

static Bytes Str (const char16_t *s)
{
	Bytes b {0, 3};
	for (; *s; s++)
	{
		b.push_back (*s & 0xFF);
		b.push_back (*s >> 8);
	}
	b[0] = (uint8_t) b.size ();
	return b;
}

static const Bytes DigiMacroDevice = {
	0x12, 0x01, 0x10, 0x01, 0x00, 0x00, 0x00, 0x08, 0xc0, 0x16, 0xdb, 0x27, 0x04, 0x02,
	0x01, 0x02, 0x03, 0x01};
static const Bytes StubConfig = {
	9, 2, 43, 0, 2, 1, 0, 0x80, 50,
	9, 4, 0, 0, 1, 3, 1, 1, 0,
	9, 0x21, 0x11, 0x01, 0, 1, 0x22, 25, 0,
	7, 5, 0x81, 3, 8, 0, 10,
	9, 4, 1, 0, 0, 0xFF, 0, 0, 0};

static void FixedCases (void)
{
	gk_usb_device_desc_t Desc;
	THeap d (DigiMacroDevice);
	if (   gk_usb_parse_device (d.p, 18, &Desc) != 0 || Desc.vid != 0x16c0 || Desc.pid != 0x27db
	    || Desc.max_packet0 != 8 || Desc.i_product != 2)
	{
		Fail ("DigiMacro's device descriptor", DigiMacroDevice);
	}
	Bytes Bad = DigiMacroDevice;
	Bad[7] = 7;
	THeap b (Bad);
	if (gk_usb_parse_device (b.p, 18, &Desc) == 0)
	{
		Fail ("a max packet size of 7 accepted", Bad);
	}
	if (gk_usb_parse_device (d.p, 17, &Desc) == 0)
	{
		Fail ("17 bytes of device descriptor accepted", DigiMacroDevice);
	}

	gk_usb_config_t Config;
	if (   ParseConfig (StubConfig, &Config) != 0 || Config.interface_count != 2
	    || Config.interfaces[0].cls != 3 || Config.interfaces[1].cls != 0xFF || Config.value != 1)
	{
		Fail ("the stub's configuration", StubConfig);
	}
	Bytes Cut (StubConfig.begin (), StubConfig.end () - 1);
	Cut[2] = (uint8_t) Cut.size ();
	if (ParseConfig (Cut, &Config) == 0)
	{
		Fail ("a configuration whose last descriptor is cut short", Cut);
	}
	Bytes Long = StubConfig;
	Long[2] = 44;
	if (ParseConfig (Long, &Config) == 0)
	{
		Fail ("a configuration longer than it says", Long);
	}
	Bytes Zero = StubConfig;
	Zero[18] = 0;			// a descriptor of length 0: no loop forever
	if (ParseConfig (Zero, &Config) == 0)
	{
		Fail ("a descriptor of length 0", Zero);
	}
	Bytes Twice = StubConfig;
	Twice[36] = 0;			// interface 1 numbered 0
	if (ParseConfig (Twice, &Config) == 0)
	{
		Fail ("an interface number twice", Twice);
	}
	Bytes Many {9, 2, 0, 0, 17, 1, 0, 0x80, 50};
	for (int i = 0; i < 17; i++)
	{
		Bytes If {9, 4, (uint8_t) i, 0, 0, 0xFF, 0, 0, 0};
		Many.insert (Many.end (), If.begin (), If.end ());
	}
	Many[2] = (uint8_t) Many.size ();
	Many[3] = (uint8_t) (Many.size () >> 8);
	if (ParseConfig (Many, &Config) == 0)
	{
		Fail ("17 interfaces accepted", Many);
	}
	Bytes Alt = StubConfig;
	Bytes AltIf {9, 4, 0, 1, 0, 0xFE, 0, 0, 0};	// interface 0, alternate 1: skipped
	Alt.insert (Alt.end (), AltIf.begin (), AltIf.end ());
	Alt[2] = (uint8_t) Alt.size ();
	if (ParseConfig (Alt, &Config) != 0 || Config.interface_count != 2)
	{
		Fail ("an alternate setting not skipped", Alt);
	}

	char Out[GK_USB_MAX_STRING];
	if (ParseString (Str (u"DigiMacro"), Out) != 9 || strcmp (Out, "DigiMacro") != 0)
	{
		Fail ("\"DigiMacro\"", Str (u"DigiMacro"));
	}
	if (ParseString (Str (u"Caf\u00e9 \u20ac"), Out) < 0 || strcmp (Out, "Caf\xc3\xa9 \xe2\x82\xac") != 0)
	{
		Fail ("UTF-16 to UTF-8", Str (u"Caf\u00e9 \u20ac"));
	}
	const char16_t Hidden[] = {'a', 0x202E, 'b', '\n', 'c', 0x200B, 'd', 0};	// RLO, LF, ZWSP
	if (ParseString (Str (Hidden), Out) < 0 || strcmp (Out, "a?b?c?d") != 0)
	{
		Fail ("bidi, control and invisible characters not replaced", Str (Hidden));
	}
	if (ParseString (Str (u"\U0001F600"), Out) != 4)
	{
		Fail ("a surrogate pair", Str (u"\U0001F600"));
	}
	const char16_t Lone[] = {0xD800, 'x', 0};
	if (ParseString (Str (Lone), Out) < 0 || strcmp (Out, "?x") != 0)
	{
		Fail ("a lone surrogate not replaced", Str (Lone));
	}
	Bytes LongString = Str (u"x");
	LongString[0] = 200;		// says more than it has
	if (ParseString (LongString, Out) >= 0)
	{
		Fail ("a string longer than its bytes", LongString);
	}
	Bytes Max {254, 3};
	for (int i = 0; i < 126; i++)	// 126 three-byte characters: cut to fit
	{
		Max.push_back (0xAC);
		Max.push_back (0x20);
	}
	int n = ParseString (Max, Out);
	if (n < 0 || n > GK_USB_MAX_STRING - 1 || n % 3 != 0)
	{
		Fail ("a long string not cut at a character", Max);
	}
	uint16_t usLang;
	THeap l (Bytes {4, 3, 9, 4});
	if (gk_usb_parse_langid (l.p, 4, &usLang) != 0 || usLang != 0x0409)
	{
		Fail ("string 0", Bytes {4, 3, 9, 4});
	}
	THeap l2 (Bytes {2, 3});
	if (gk_usb_parse_langid (l2.p, 2, &usLang) == 0)
	{
		Fail ("a string 0 without languages", Bytes {2, 3});
	}
}

static Bytes Mutate (Bytes b)
{
	static const uint8_t Telling[] = {0, 1, 2, 3, 4, 5, 9, 0x21, 0x7F, 0x80, 0xFF};
	unsigned nEdits = 1 + Below (4);
	for (unsigned e = 0; e < nEdits; e++)
	{
		switch (Below (6))
		{
		case 0:
			if (!b.empty ()) b[Below (b.size ())] ^= 1 << Below (8);
			break;
		case 1:
			if (!b.empty ()) b[Below (b.size ())] = Telling[Below (sizeof Telling)];
			break;
		case 2:
			if (!b.empty ()) b.resize (Below (b.size ()));
			break;
		case 3:
			b.insert (b.begin () + Below (b.size () + 1), Telling[Below (sizeof Telling)]);
			break;
		case 4:
			if (b.size () > 2) b.erase (b.begin () + Below (b.size ()));
			break;
		default:
			if (b.size () >= 4) { b[2] = (uint8_t) b.size (); b[3] = (uint8_t) (b.size () >> 8); }
			break;
		}
	}
	return b;
}

int main (int argc, char **argv)
{
	unsigned nRounds = argc > 1 ? (unsigned) atoi (argv[1]) : 100000;
	s_nRandom = argc > 2 ? (uint32_t) atoi (argv[2]) : 1;
	if (s_nRandom == 0)
	{
		s_nRandom = 1;
	}

	FixedCases ();

	const Bytes Seeds[] = {DigiMacroDevice, StubConfig, Str (u"GapKeep tests"), Bytes {4, 3, 9, 4}};
	for (unsigned r = 0; r < nRounds; r++)
	{
		Bytes b;
		if (Below (4) == 0)
		{
			b.resize (Below (80));
			for (auto &x : b) x = (uint8_t) Rand ();
		}
		else
		{
			b = Mutate (Seeds[Below (sizeof Seeds / sizeof Seeds[0])]);
		}
		Everything (b);
	}

	if (s_nFailures)
	{
		fprintf (stderr, "fuzz_usbdesc: %u failure(s)\n", s_nFailures);
		return 1;
	}
	printf ("fuzz_usbdesc: %u rounds, no problem\n", nRounds);
	return 0;
}
