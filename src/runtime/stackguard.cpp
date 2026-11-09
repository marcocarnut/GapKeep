//
// stackguard.cpp
//
// Stack canaries. Everything is compiled with -fstack-protector-strong
// (tools/build.sh): functions with arrays on the stack put
// __stack_chk_guard below their return address and check it before
// returning. A buffer overflow that reaches the return address changes it,
// and the system stops instead of running the attacker's choice of code.
//
// The guard is a fixed value until GkInitStackGuard() replaces it with one
// from the hardware RNG, first thing in main(). Only functions that are
// running at that moment would see a changed guard: sysinit(), which never
// returns, and main() and GkInitStackGuard() itself, which are compiled
// without the check.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "stackguard.h"
#include <circle/bcmrandom.h>
#include <circle/logger.h>
#include <circle/startup.h>
#include <circle/types.h>

extern "C"
{
	u32 __stack_chk_guard = 0x00F1CE9A;

	void __stack_chk_fail (void)
	{
		CLogger *pLogger = CLogger::Get ();
		if (pLogger != 0)
		{
			pLogger->Write ("stackguard", LogPanic, "Stack smashing detected");	// halts
		}

		halt ();
	}
}

__attribute__ ((no_stack_protector))
void GkInitStackGuard (void)
{
	CBcmRandomNumberGenerator Random;
	u32 nGuard = Random.GetNumber ();

	// a zero low byte stops overflows by C strings from reproducing it
	__stack_chk_guard = (nGuard & ~0xFFu) | 0x00;
}
