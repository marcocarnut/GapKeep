//
// fuzz_usbmouse.cpp - fuzzes the USB mouse's HID report descriptor parser
// (circle/lib/usb/usbmousereport.cpp, patches/circle/0009) with
// AddressSanitizer and UBSan: the descriptor and the reports come from the
// device, so a hostile one chooses every byte. Built and run by
// tools/fuzz_usbmouse.sh.
//
// First fixed cases: real mouse descriptors (each must give the expected
// layout) and the malformed ones the security review described (each must
// be refused). Then rounds of:
//
//  - random bytes, and random item streams (random prefixes and data);
//  - real descriptors mutated: bytes flipped or replaced by telling values,
//    items inserted, deleted, duplicated or spliced in from another one,
//    the end cut off;
//  - generated hostile descriptors: many usages, sizes and counts out of
//    range, deep or unbalanced collections, long items, report IDs 0 and
//    over 255, truncated items;
//  - generated well-formed mouse descriptors, which the original parser
//    (Circle's, as GapKeep had it, copied below) also handles safely: the
//    new one must find the same layout, or refuse with a reason that the
//    original could not see (a field outside the report).
//
// For every descriptor the parser must not touch memory outside it
// (it is a heap block of exactly its length), and when it accepts one,
// the layout must fit: report at most USBMOUSE_MAX_REPORT_SIZE bytes,
// fields at most 32 bits, all inside the report. When it refuses one,
// the layout must be all zero. Every accepted layout's fields are then
// read from random reports of exactly the report's size (heap blocks
// again), and the extraction is also called with random offsets and
// sizes: it must never read outside the report.
//
//   fuzz_usbmouse ROUNDS SEED
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include <circle/usb/usbmousereport.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

typedef std::vector<u8> Bytes;

static u32 s_nRandom = 1;
static u32 Rand (void)			// xorshift32: reproducible from the seed
{
	s_nRandom ^= s_nRandom << 13;
	s_nRandom ^= s_nRandom >> 17;
	s_nRandom ^= s_nRandom << 5;
	return s_nRandom;
}
static unsigned Below (unsigned n)	{ return n ? Rand () % n : 0; }

static unsigned s_nFailures = 0;
static void Fail (const char *pWhat, const Bytes &Desc)
{
	fprintf (stderr, "FAIL: %s; descriptor (%zu bytes):", pWhat, Desc.size ());
	for (size_t i = 0; i < Desc.size () && i < 256; i++)
	{
		fprintf (stderr, " %02x", Desc[i]);
	}
	fprintf (stderr, "\n");
	if (++s_nFailures >= 10)
	{
		exit (1);
	}
}

// --- the original parser, for comparison ----------------------------------------
//
// CUSBMouseDevice::DecodeReport() from Circle (lib/usb/usbmouse.cpp, Circle
// 51.1.1, (C) 2020 H. Kocevar, 2014-2026 R. Stange, GPL-3.0-or-later) with
// GapKeep's patch 0001 (the layout zeroed first), as a function. Only
// called on descriptors it handles safely (see GenerateWellFormed()). One
// change: its shifts of negative (signed char) values, undefined behaviour,
// are done on unsigned ones, which gives what GCC made of them.

#define HID_USAGE_PAGE      0x04
#define HID_USAGE           0x08
#define HID_COLLECTION      0xA0
#define HID_END_COLLECTION  0xC0
#define HID_REPORT_COUNT    0x94
#define HID_REPORT_SIZE     0x74
#define HID_INPUT           0x80
#define HID_REPORT_ID       0x84
#define HID_USAGE_PAGE_BUTTONS         0x09
#define HID_USAGE_POINTER   0x01
#define HID_USAGE_MOUSE     0x02
#define HID_USAGE_X         0x30
#define HID_USAGE_Y         0x31
#define HID_USAGE_WHEEL     0x38

static void OriginalDecodeReport (const u8 *m_pHIDReportDescriptor, u16 m_usReportDescriptorLength,
				  TMouseReport &m_MouseReport)
{
	s32 item, arg;
	u32 offset = 0, size = 0, count = 0;
	u32 id = 0;
	u32 nCollections = 0;
	u32 itemIndex = 0;
	boolean parse = FALSE;
	boolean foundMouseUsage = FALSE;
	u32 itemIndexes[MouseItemCount] = {0};

	memset (&m_MouseReport, 0, sizeof m_MouseReport);

	s8 *pHIDReportDescriptor = (s8 *) m_pHIDReportDescriptor;

	for (u16 usReportDescriptorLength = m_usReportDescriptorLength; usReportDescriptorLength > 0; )
	{
		item = *pHIDReportDescriptor++;
		usReportDescriptorLength--;

		switch(item & 0x03)
		{
		case 0:
			arg = 0;
			break;
		case 1:
			arg = *pHIDReportDescriptor++;
			usReportDescriptorLength--;
			break;
		case 2:
			arg = *pHIDReportDescriptor++ & 0xFF;
			arg = arg | (s32) ((u32) *pHIDReportDescriptor++ << 8);
			usReportDescriptorLength -= 2;
			break;
		default:
			arg = *pHIDReportDescriptor++;
			arg = arg | (s32) ((u32) *pHIDReportDescriptor++ << 8);
			arg = arg | (s32) ((u32) *pHIDReportDescriptor++ << 16);
			arg = arg | (s32) ((u32) *pHIDReportDescriptor++ << 24);
			usReportDescriptorLength -= 4;
			break;
		}

		switch(item & 0xFC)
		{
		case HID_COLLECTION:
			nCollections++;
			break;
		case HID_END_COLLECTION:
			nCollections--;
			if (nCollections == 0)
				parse = FALSE;
			break;
		case HID_USAGE:
			if (arg == HID_USAGE_MOUSE)
			{
				foundMouseUsage = TRUE;
			}
			else if (arg == HID_USAGE_POINTER)
			{
				if (id == 0)
				{
					parse = true;
				}
			}
			break;
		case HID_REPORT_ID:
			if (foundMouseUsage)
			{
				if (id == 0)
				{
					id = arg;
					offset += 8;
					parse = TRUE;
				}
				else
				{
					if ((u32)arg != id)
					{
						parse = FALSE;
					}
					else
					{
						parse = TRUE;
					}
				}
			}
			break;
		}

		if (! parse)
			continue;

		switch(item & 0xFC)
		{
		case HID_USAGE_PAGE:
			switch(arg)
			{
			case HID_USAGE_PAGE_BUTTONS:
				itemIndexes[itemIndex] = MouseItemButtons;
				itemIndex++;
				break;
			}
			break;
		case HID_USAGE:
			switch(arg)
			{
			case HID_USAGE_X:
				itemIndexes[itemIndex] = MouseItemXAxis;
				itemIndex++;
				break;
			case HID_USAGE_Y:
				itemIndexes[itemIndex] = MouseItemYAxis;
				itemIndex++;
				break;
			case HID_USAGE_WHEEL:
				itemIndexes[itemIndex] = MouseItemWheel;
				itemIndex++;
				break;
			}
			break;
		case HID_REPORT_SIZE:
			size = arg;
			break;
		case HID_REPORT_COUNT:
			count = arg;
			break;
		case HID_INPUT:
			if ((arg & 0x03) == 0x02)
			{
				u32 bitOffset = offset;
				u32 bitSize = 0;
				u32 index = 0;
				u32 item = 0;
				while (index < itemIndex)
				{
					item = itemIndexes[index];
					bitSize = size;
					if (item == MouseItemButtons)
					{
						bitSize = count;
					}
					m_MouseReport.items[item].bitSize = bitSize;
					m_MouseReport.items[item].bitOffset = bitOffset;
					bitOffset += bitSize;
					index++;
				}
				itemIndex = 0;
			}

			offset += count * size;
			break;
		}
	}

	m_MouseReport.id = id;
	m_MouseReport.byteSize = (offset + 7) / 8;
}

// --- checks -------------------------------------------------------------------------

static boolean IsZero (const TMouseReport &R)
{
	if (R.id != 0 || R.byteSize != 0)
	{
		return FALSE;
	}
	for (unsigned i = 0; i < MouseItemCount; i++)
	{
		if (R.items[i].bitSize != 0 || R.items[i].bitOffset != 0)
		{
			return FALSE;
		}
	}
	return TRUE;
}

static unsigned s_nAccepted, s_nMice, s_nRefused, s_nExtracts;

// decodes (from a heap block of exactly the descriptor's size) and checks
static const char *Check (const Bytes &Desc, TMouseReport *pOut = 0)
{
	u8 *pDesc = (u8 *) malloc (Desc.size () ? Desc.size () : 1);
	if (!Desc.empty ())
	{
		memcpy (pDesc, Desc.data (), Desc.size ());
	}

	TMouseReport R;
	memset (&R, 0x5A, sizeof R);	// must be overwritten whatever happens
	const char *pError = USBMouseDecodeReport (pDesc, Desc.size (), &R);
	free (pDesc);

	if (pError != 0)
	{
		s_nRefused++;
		if (!IsZero (R))
		{
			Fail ("refused, but the layout is not all zero", Desc);
		}
	}
	else if (R.byteSize == 0)
	{
		s_nAccepted++;
		if (!IsZero (R))
		{
			Fail ("no mouse, but the layout is not all zero", Desc);
		}
	}
	else
	{
		s_nAccepted++;
		s_nMice++;
		if (R.byteSize > USBMOUSE_MAX_REPORT_SIZE)
		{
			Fail ("report too long", Desc);
		}
		if (R.id > 0xFF)
		{
			Fail ("report ID over 255", Desc);
		}
		for (unsigned i = 0; i < MouseItemCount; i++)
		{
			const TMouseReportItem &I = R.items[i];
			if (I.bitSize > 32)
			{
				Fail ("field over 32 bits", Desc);
			}
			if (I.bitSize > 0 && I.bitOffset + I.bitSize > R.byteSize * 8)
			{
				Fail ("field outside the report", Desc);
			}
		}

		// read the fields from reports of exactly that size
		for (unsigned n = 0; n < 4; n++)
		{
			u8 *pReport = (u8 *) malloc (R.byteSize);
			for (unsigned k = 0; k < R.byteSize; k++)
			{
				pReport[k] = Rand ();
			}
			for (unsigned i = 0; i < MouseItemCount; i++)
			{
				const TMouseReportItem &I = R.items[i];
				u32 u = USBMouseExtractUnsigned (pReport, R.byteSize, I.bitOffset, I.bitSize);
				s32 s = USBMouseExtractSigned (pReport, R.byteSize, I.bitOffset, I.bitSize);
				if (I.bitSize < 32 && (u >> I.bitSize) != 0)
				{
					Fail ("extracted value wider than its field", Desc);
				}
				if ((u32) s != u && (I.bitSize == 0 || I.bitSize == 32
						     || !(u & (1u << (I.bitSize - 1)))))
				{
					Fail ("signed value differs from the unsigned one", Desc);
				}
				s_nExtracts++;
			}
			free (pReport);
		}
	}

	if (pOut != 0)
	{
		*pOut = R;
	}

	return pError;
}

// the extraction alone, with any arguments, on a report of any size
static void FuzzExtract (void)
{
	unsigned nSize = Below (USBMOUSE_MAX_REPORT_SIZE + 8);
	u8 *pReport = (u8 *) malloc (nSize ? nSize : 1);
	for (unsigned k = 0; k < nSize; k++)
	{
		pReport[k] = Rand ();
	}
	unsigned nOffset = Below (4) == 0 ? Rand () : Below (nSize * 8 + 40);
	unsigned nBits = Below (4) == 0 ? Rand () : Below (40);
	u32 u = USBMouseExtractUnsigned (pReport, nSize, nOffset, nBits);
	(void) USBMouseExtractSigned (pReport, nSize, nOffset, nBits);
	if (   (nBits == 0 || nBits > 32 || nSize > USBMOUSE_MAX_REPORT_SIZE
		|| (u64) nOffset + nBits > (u64) nSize * 8)
	    && u != 0)
	{
		Fail ("field outside the report read as non-zero", Bytes ());
	}
	// a bit at a time, against a plain reading
	if (   nBits > 0 && nBits <= 32 && nSize <= USBMOUSE_MAX_REPORT_SIZE
	    && (u64) nOffset + nBits <= (u64) nSize * 8)
	{
		u32 v = 0;
		for (unsigned i = 0; i < nBits; i++)
		{
			unsigned b = nOffset + i;
			v |= (u32) ((pReport[b / 8] >> (b % 8)) & 1) << i;
		}
		if (u != v)
		{
			Fail ("extracted value wrong", Bytes ());
		}
	}
	s_nExtracts++;
	free (pReport);
}

// --- descriptors --------------------------------------------------------------------

static void Item (Bytes &D, u8 ucTag, u32 nArg, unsigned nSize)	// short item
{
	D.push_back (ucTag | (nSize == 4 ? 3 : nSize));
	for (unsigned k = 0; k < nSize; k++)
	{
		D.push_back (nArg >> (8 * k));
	}
}
static void Item (Bytes &D, u8 ucTag, u32 nArg)			// smallest size
{
	Item (D, ucTag, nArg, nArg == 0 ? 0 : nArg <= 0xFF ? 1 : nArg <= 0xFFFF ? 2 : 4);
}
static unsigned RandomArgSize (void)
{
	static const unsigned Sizes[] = { 0, 1, 2, 4 };
	return Sizes[Below (4)];
}
static Bytes Hex (const char *p)
{
	Bytes D;
	for (; p[0] && p[1]; p += 2)
	{
		unsigned v;
		sscanf (p, "%2x", &v);
		D.push_back (v);
	}
	return D;
}

struct TSeed
{
	const char *pName;
	const char *pHex;
	unsigned nByteSize, nID;
	unsigned Bits[MouseItemCount][2];	// size, offset: buttons, X, Y, wheel
};

static const TSeed Seeds[] =
{
	// the rig's gadget (tools/rig/gadget.sh): 3 buttons, X/Y 8 bits
	{ "boot mouse",
	  "05010902a1010901a100050919012903150025019503750181029501750581030501"
	  "093009311581257f750895028106c0c0",
	  3, 0, {{3, 0}, {8, 8}, {8, 16}, {0, 0}} },
	// QEMU's usb-mouse: 3 buttons, X/Y/wheel 8 bits
	{ "qemu usb-mouse",
	  "05010902a1010901a100050919012903150025019503750181029501750581010501"
	  "093009310938158125 7f750895038106c0c0",
	  4, 0, {{3, 0}, {8, 8}, {8, 16}, {8, 24}} },
	// a wheel mouse with 5 buttons and 12-bit X/Y, report ID 2 (Logitech-like)
	{ "report ID 2, 12-bit X/Y",
	  "05010902a10185020901a1000509190129051500250195057501810295017503"
	  "8101050116 01f826ff07750c95020930093181060938158125 7f7508950181"
	  "06c0c0",
	  6, 2, {{5, 8}, {12, 16}, {12, 28}, {8, 40}} },
	// a gaming mouse: 16 buttons, 16-bit X/Y, 8-bit wheel
	{ "16 buttons, 16-bit X/Y",
	  "05010902a1010901a10005091901291015002501951075018102050116018026ff7f"
	  "751095020930093181060938158125 7f750895018106c0c0",
	  7, 0, {{16, 0}, {16, 16}, {16, 32}, {8, 48}} },
	// a keyboard collection (report ID 1) before the mouse (report ID 2)
	{ "keyboard + mouse, report IDs",
	  "05010906a101850105071 9e029e715002501750195088102950175088101c0"
	  "05010902a10185020901a100050919012903150025019503750181029501750581"
	  "0305010930093115812 57f750895028106c0c0",
	  4, 2, {{3, 8}, {8, 16}, {8, 24}, {0, 0}} },
};

static Bytes SeedBytes (unsigned i)
{
	// spaces in the strings above are only for reading
	char Buf[512];
	unsigned n = 0;
	for (const char *p = Seeds[i].pHex; *p && n < sizeof Buf - 1; p++)
	{
		if (*p != ' ')
		{
			Buf[n++] = *p;
		}
	}
	Buf[n] = 0;
	return Hex (Buf);
}

static void FixedCases (void)
{
	// real mice: the expected layout, the same as the original parser's
	for (unsigned i = 0; i < sizeof Seeds / sizeof Seeds[0]; i++)
	{
		Bytes D = SeedBytes (i);
		TMouseReport R, O;
		const char *pError = Check (D, &R);
		OriginalDecodeReport (D.data (), D.size (), O);
		boolean bOK = pError == 0 && R.byteSize == Seeds[i].nByteSize && R.id == Seeds[i].nID
			      && memcmp (&R, &O, sizeof R) == 0;
		for (unsigned k = 0; k < MouseItemCount; k++)
		{
			bOK = bOK && R.items[k].bitSize == Seeds[i].Bits[k][0]
				  && (R.items[k].bitSize == 0 || R.items[k].bitOffset == Seeds[i].Bits[k][1]);
		}
		if (!bOK)
		{
			fprintf (stderr, "%s: %s, %u bytes, id %u\n", Seeds[i].pName,
				 pError ? pError : "accepted", R.byteSize, R.id);
			Fail ("a real mouse's layout", D);
		}
	}

	// the review's malformed descriptors: each refused
	struct { const char *pName; Bytes D; } Bad[16];
	unsigned n = 0;
	Bytes D;

	// five Usage (X) in a pointer collection: the 4-entry array overflowed
	D.clear (); Item (D, 0x04, 1); Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x08, 1);
	for (unsigned k = 0; k < 5; k++) Item (D, 0x08, HID_USAGE_X);
	Item (D, 0x74, 8); Item (D, 0x94, 5); Item (D, 0x80, 2); Item (D, 0xC0, 0, 0);
	Bad[n].pName = "five usages"; Bad[n++].D = D;

	// an item whose data runs past the end (4-byte data, 1 byte left)
	D = SeedBytes (0); D.push_back (0x97); D.push_back (0x01);
	Bad[n].pName = "truncated 4-byte item"; Bad[n++].D = D;

	// one byte, a 2-byte item: the original's u16 length wrapped
	Bad[n].pName = "u16 wrap"; Bad[n++].D = Bytes (1, 0x76);

	// report size 33 (asserted in ExtractUnsigned)
	D.clear (); Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x08, 1); Item (D, 0x08, HID_USAGE_X);
	Item (D, 0x74, 33); Item (D, 0x94, 1); Item (D, 0x80, 2); Item (D, 0xC0, 0, 0);
	Bad[n].pName = "report size 33"; Bad[n++].D = D;

	// size x count wraps the bit offset (0x10000 x 0x10000)
	D.clear (); Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x08, 1);
	Item (D, 0x74, 0x10000, 4); Item (D, 0x94, 0x10000, 4); Item (D, 0x80, 1);
	Item (D, 0x08, HID_USAGE_X); Item (D, 0x74, 8); Item (D, 0x94, 1); Item (D, 0x80, 2); Item (D, 0xC0, 0, 0);
	Bad[n].pName = "offset wraps"; Bad[n++].D = D;

	// a huge report count on buttons (32-bit field from a count of 1000)
	D.clear (); Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x08, 1); Item (D, 0x04, 9);
	Item (D, 0x74, 1); Item (D, 0x94, 1000); Item (D, 0x80, 2); Item (D, 0xC0, 0, 0);
	Bad[n].pName = "1000 buttons"; Bad[n++].D = D;

	// fields after the report's end: 2 usages, one field
	D.clear (); Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x08, 1);
	Item (D, 0x08, HID_USAGE_X); Item (D, 0x08, HID_USAGE_Y);
	Item (D, 0x74, 8); Item (D, 0x94, 1); Item (D, 0x80, 2); Item (D, 0xC0, 0, 0);
	Bad[n].pName = "field after the end"; Bad[n++].D = D;

	// End Collection with none open
	D.clear (); Item (D, 0xC0, 0, 0); { Bytes S = SeedBytes (0); D.insert (D.end (), S.begin (), S.end ()); }
	Bad[n].pName = "unbalanced End Collection"; Bad[n++].D = D;

	// a truncated long item
	D = SeedBytes (0); D.push_back (0xFE); D.push_back (200); D.push_back (0x10); D.push_back (0);
	Bad[n].pName = "truncated long item"; Bad[n++].D = D;

	// report ID 0
	D.clear (); Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x84, 0, 1);
	Bad[n].pName = "report ID 0"; Bad[n++].D = D;

	for (unsigned i = 0; i < n; i++)
	{
		const char *pError = Check (Bad[i].D);
		if (pError == 0)
		{
			fprintf (stderr, "%s\n", Bad[i].pName);
			Fail ("a malformed descriptor accepted", Bad[i].D);
		}
		else
		{
			printf ("refused as it should: %-26s (%s)\n", Bad[i].pName, pError);
		}
	}
}

// well-formed mouse descriptors that the original parser handles safely:
// complete short items only, balanced collections, at most 4 usages per
// input item, sizes up to 32, small counts, report IDs below 0x80
static Bytes GenerateWellFormed (void)
{
	Bytes D;
	Item (D, 0x04, 1);
	Item (D, 0x08, 2);			// Usage (Mouse)
	Item (D, 0xA0, 1);
	unsigned nID = Below (3) == 0 ? 1 + Below (0x7F) : 0;
	if (nID)
	{
		Item (D, 0x84, nID);
	}
	Item (D, 0x08, 1);			// Usage (Pointer)
	Item (D, 0xA0, 0);
	unsigned nInputs = 1 + Below (4);
	for (unsigned i = 0; i < nInputs; i++)
	{
		unsigned nUsages = Below (5);
		static const u32 Usages[] = { HID_USAGE_X, HID_USAGE_Y, HID_USAGE_WHEEL, 0x32, 0x33 };
		for (unsigned u = 0; u < nUsages; u++)
		{
			if (Below (4) == 0)
			{
				Item (D, 0x04, Below (2) ? HID_USAGE_PAGE_BUTTONS : 1);
			}
			else
			{
				Item (D, 0x08, Usages[Below (5)], 1 + Below (2));
			}
		}
		if (Below (2)) Item (D, 0x74, Below (33));
		if (Below (2)) Item (D, 0x94, Below (17));
		if (Below (3) == 0) Item (D, 0x14, Rand () & 0xFF);	// logical minimum: ignored
		// the original keeps usages past a constant input item: none there
		Item (D, 0x80, nUsages ? 0x02 | (Below (2) << 2) : 0x01 | (Below (2) << 1));
	}
	Item (D, 0xC0, 0, 0);
	Item (D, 0xC0, 0, 0);
	return D;
}

static Bytes GenerateHostile (void)
{
	Bytes D;
	if (Below (2))
	{
		Item (D, 0x08, 2); Item (D, 0xA0, 1); Item (D, 0x08, 1);
	}
	unsigned nItems = Below (60);
	static const u8 Tags[] = { 0x04, 0x08, 0xA0, 0xC0, 0x94, 0x74, 0x80, 0x84, 0x14, 0x24, 0x90, 0xB0 };
	for (unsigned i = 0; i < nItems; i++)
	{
		u8 ucTag = Tags[Below (sizeof Tags)];
		u32 nArg;
		switch (Below (6))
		{
		case 0:  nArg = Rand (); break;
		case 1:  nArg = Below (2) ? HID_USAGE_X + Below (9) : HID_USAGE_PAGE_BUTTONS; break;
		case 2:  nArg = 0xFFFFFFFF - Below (4); break;
		case 3:  nArg = 1u << Below (32); break;
		default: nArg = Below (70); break;
		}
		if (Below (12) == 0)			// a long item
		{
			D.push_back (0xFE);
			unsigned nSize = Below (40);
			D.push_back (nSize);
			D.push_back (Rand ());
			for (unsigned k = 0; k < nSize; k++) D.push_back (Rand ());
			continue;
		}
		Item (D, ucTag, nArg, RandomArgSize ());
	}
	if (Below (4) == 0 && !D.empty ())		// cut short
	{
		D.resize (Below (D.size ()));
	}
	return D;
}

static Bytes Mutate (Bytes D)
{
	unsigned nMutations = 1 + Below (8);
	for (unsigned m = 0; m < nMutations; m++)
	{
		static const u8 Telling[] = { 0x00, 0x01, 0x02, 0x08, 0x20, 0x21, 0x30, 0x7F, 0x80,
					      0x81, 0xC0, 0xFE, 0xFF, 0x75, 0x95, 0x85, 0x09, 0x05, 0xA1 };
		switch (Below (7))
		{
		case 0:
			if (!D.empty ()) D[Below (D.size ())] ^= 1 << Below (8);
			break;
		case 1:
			if (!D.empty ()) D[Below (D.size ())] = Telling[Below (sizeof Telling)];
			break;
		case 2:
			D.insert (D.begin () + Below (D.size () + 1), Telling[Below (sizeof Telling)]);
			break;
		case 3:
			if (!D.empty ()) D.erase (D.begin () + Below (D.size ()));
			break;
		case 4:					// duplicate a stretch
			if (!D.empty ())
			{
				unsigned a = Below (D.size ()), n = 1 + Below (8);
				Bytes Piece (D.begin () + a, D.begin () + (a + n < D.size () ? a + n : D.size ()));
				D.insert (D.begin () + Below (D.size () + 1), Piece.begin (), Piece.end ());
			}
			break;
		case 5:					// splice from another seed
			{
				Bytes S = SeedBytes (Below (sizeof Seeds / sizeof Seeds[0]));
				unsigned a = Below (S.size ()), n = 1 + Below (16);
				D.insert (D.begin () + Below (D.size () + 1), S.begin () + a,
					  S.begin () + (a + n < S.size () ? a + n : S.size ()));
			}
			break;
		case 6:
			if (!D.empty ()) D.resize (Below (D.size ()));
			break;
		}
	}
	if (D.size () > USBMOUSE_MAX_DESCRIPTOR_SIZE + 16)
	{
		D.resize (USBMOUSE_MAX_DESCRIPTOR_SIZE + Below (16));
	}
	return D;
}

int main (int argc, char **argv)
{
	unsigned nRounds = argc > 1 ? atoi (argv[1]) : 100000;
	s_nRandom = argc > 2 ? atoi (argv[2]) : 1;
	if (s_nRandom == 0)
	{
		s_nRandom = 1;
	}

	FixedCases ();

	unsigned nSame = 0, nDiffer = 0, nNoMouse = 0, nOriginalOutside = 0, nOriginalTooLong = 0;
	for (unsigned r = 0; r < nRounds; r++)
	{
		Bytes D;
		switch (Below (10))
		{
		case 0:					// random bytes
			for (unsigned n = Below (300); n > 0; n--) D.push_back (Rand ());
			break;
		case 1:					// random item stream
			for (unsigned n = Below (80); n > 0; n--)
				Item (D, Rand () & 0xFC, Rand (), RandomArgSize ());
			break;
		case 2: case 3: case 4:
			D = Mutate (Below (4) ? SeedBytes (Below (sizeof Seeds / sizeof Seeds[0]))
					      : GenerateWellFormed ());
			break;
		case 5: case 6:
			D = GenerateHostile ();
			break;
		default:				// well-formed: compare with the original
			{
				D = GenerateWellFormed ();
				TMouseReport R, O;
				const char *pError = Check (D, &R);
				OriginalDecodeReport (D.data (), D.size (), O);
				// what the original could not see: a field placed after
				// the report's end, a report over 64 bytes
				boolean bOutside = FALSE;
				for (unsigned i = 0; i < MouseItemCount; i++)
					if (O.items[i].bitSize > 0
					    && O.items[i].bitOffset + O.items[i].bitSize > O.byteSize * 8)
						bOutside = TRUE;
				boolean bTooLong = O.byteSize > USBMOUSE_MAX_REPORT_SIZE;

				if (pError == 0 && R.byteSize > 0)
				{
					if (memcmp (&R, &O, sizeof R) == 0) nSame++;
					else { nDiffer++; Fail ("a layout differs from the original's", D); }
				}
				else if (pError == 0)
				{
					// no mouse: the original found no report either, or
					// one of its ID only (a "mouse" with no fields in it)
					if (O.byteSize == 0 || (O.id != 0 && O.byteSize == 1)) nNoMouse++;
					else { nDiffer++; Fail ("no mouse, where the original found one", D); }
				}
				else
				{
					if (bOutside) nOriginalOutside++;
					else if (bTooLong) nOriginalTooLong++;
					else { fprintf (stderr, "refused: %s\n", pError); Fail ("refused a well-formed descriptor", D); }
				}
			}
			continue;
		}
		Check (D);
		FuzzExtract ();
	}

	printf ("fuzz_usbmouse: %u rounds, seed %u: %u accepted (%u mice), %u refused, %u fields read;\n"
		"  generated well-formed descriptors, against the original parser: %u same layout,\n"
		"  %u no mouse for either, %u refused for a field the original placed after the\n"
		"  report's end, %u for a report over %u bytes, %u different\n",
		nRounds, argc > 2 ? atoi (argv[2]) : 1, s_nAccepted, s_nMice, s_nRefused, s_nExtracts,
		nSame, nNoMouse, nOriginalOutside, nOriginalTooLong, USBMOUSE_MAX_REPORT_SIZE, nDiffer);

	if (s_nFailures > 0)
	{
		printf ("fuzz_usbmouse: %u FAILURES\n", s_nFailures);
		return 1;
	}
	printf ("fuzz_usbmouse: OK\n");
	return 0;
}
