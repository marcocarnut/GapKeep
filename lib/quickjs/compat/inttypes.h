/*
 * inttypes.h wrapper for GapKeep.
 *
 * Some arm-none-eabi toolchains (e.g. Debian/Ubuntu gcc-arm-none-eabi) use
 * GCC's own stdint.h instead of newlib's. newlib's inttypes.h then omits the
 * 64-bit PRI/SCN macros because __int64_t_defined is never set. Fill them in.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef GK_COMPAT_INTTYPES_H
#define GK_COMPAT_INTTYPES_H

#include_next <inttypes.h>

#ifndef PRId64
#define PRId64 "lld"
#define PRIi64 "lli"
#define PRIo64 "llo"
#define PRIu64 "llu"
#define PRIx64 "llx"
#define PRIX64 "llX"
#define SCNd64 "lld"
#define SCNi64 "lli"
#define SCNo64 "llo"
#define SCNu64 "llu"
#define SCNx64 "llx"
#endif

#endif
