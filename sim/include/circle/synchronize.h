// The simulator is single-threaded: no barriers needed.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_synchronize_h
#define _circle_synchronize_h
#define DataMemBarrier()	do {} while (0)
#endif
