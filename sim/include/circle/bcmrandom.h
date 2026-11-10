// The Broadcom hardware RNG, simulated with the host's random source
// (getrandom() natively, crypto.getRandomValues() in the browser).
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_bcmrandom_h
#define _circle_bcmrandom_h
#include <circle/types.h>
class CBcmRandomNumberGenerator
{
public:
	u32 GetNumber (void);
};
#endif
