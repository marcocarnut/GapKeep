//
// stackguard.h
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _stackguard_h
#define _stackguard_h

// Sets the stack canary from the hardware RNG. Call first thing in main(),
// which must itself be compiled without stack protection.
void ZgInitStackGuard (void);

#endif
