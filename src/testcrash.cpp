//
// testcrash.cpp
//
// Every function here must end in an exception (Circle logs "Data abort",
// "Prefetch abort") or in the stack canary check ("Stack smashing
// detected"), and the system halts. If one returns, the protection it tests
// is missing.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "testcrash.h"
#include <circle/logger.h>
#include <circle/util.h>
#include <circle/synchronize.h>
#include <circle/types.h>

static const char From[] = "testcrash";

static const u32 s_Constant = 0x12345678;
static u32 s_Data[2];

static const u32 BX_LR = 0xE12FFF1E;		// "bx lr": returns, if it runs

typedef void TFunc (void);

static void __attribute__ ((noinline)) Run (u32 *pCode)
{
	pCode[0] = BX_LR;
	CleanDataCache ();
	InvalidateInstructionCache ();
	CLogger::Get ()->Write (From, LogNotice, "jumping to 0x%X", (uintptr) pCode);
	((TFunc *) pCode) ();
}

static void __attribute__ ((noinline)) Write (volatile u32 *pTarget)
{
	CLogger::Get ()->Write (From, LogNotice, "writing to 0x%X", (uintptr) pTarget);
	*pTarget = 0;
}

#pragma GCC diagnostic ignored "-Winfinite-recursion"	// that's the point

static unsigned __attribute__ ((noinline)) Recurse (unsigned nDepth)
{
	volatile u8 Buffer[1024];
	Buffer[0] = nDepth;
	return Recurse (nDepth + 1) + Buffer[0];	// not a tail call
}

static void __attribute__ ((noinline)) Smash (const char *pSource)
{
	char Buffer[8];
	volatile unsigned nLength = 64;			// the compiler must not see it coming
	memcpy (Buffer, pSource, nLength);
	CLogger::Get ()->Write (From, LogNotice, "%c", Buffer[0]);
}

void ZgTestCrash (const char *pKind)
{
	CLogger::Get ()->Write (From, LogNotice, "%s", pKind);

	if (strcmp (pKind, "write-code") == 0)
	{
		Write ((volatile u32 *) (uintptr) &ZgTestCrash);
	}
	else if (strcmp (pKind, "write-rodata") == 0)
	{
		Write ((volatile u32 *) &s_Constant);
	}
	else if (strcmp (pKind, "write-vectors") == 0)
	{
		Write ((volatile u32 *) 0x4);
	}
	else if (strcmp (pKind, "exec-data") == 0)
	{
		Run (s_Data);
	}
	else if (strcmp (pKind, "exec-heap") == 0)
	{
		u32 *pHeap = new u32[2];
		Run (pHeap);
	}
	else if (strcmp (pKind, "exec-stack") == 0)
	{
		u32 Code[2];
		Run (Code);
	}
	else if (strcmp (pKind, "stack-overflow") == 0)
	{
		Recurse (0);
	}
	else if (strcmp (pKind, "smash") == 0)
	{
		static const char Junk[64] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		Smash (Junk);
	}
	else
	{
		CLogger::Get ()->Write (From, LogWarning, "unknown kind");
		return;
	}

	CLogger::Get ()->Write (From, LogError, "%s: NOT STOPPED", pKind);
}
