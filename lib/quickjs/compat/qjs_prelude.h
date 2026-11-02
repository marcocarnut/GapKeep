/*
 * Force-included before every QuickJS source file (see Makefile).
 * Declares the few hosted-libc functions QuickJS uses that newlib's headers
 * do not declare for a bare-metal target. Implementations live in
 * src/runtime/libc_shim.c.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef ZG_QJS_PRELUDE_H
#define ZG_QJS_PRELUDE_H

#include <stddef.h>
#include <time.h>

size_t malloc_usable_size (void *ptr);

#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif
int clock_gettime (int clock_id, struct timespec *tp);

#endif
