/*
 * wipe.c - gk_wipe() (wipe.h), on its own so that callers cannot see that
 * it is a memset() and drop it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "wipe.h"

#include <string.h>

void gk_wipe (void *p, size_t n)
{
	if (n == 0)
	{
		return;
	}
	memset (p, 0, n);
	/* the barrier: as far as the compiler knows, the zeros are read here */
	__asm__ __volatile__ ("" : : "r" (p) : "memory");
}
