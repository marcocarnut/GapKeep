/*
 * zg_bridge.h - C-callable services implemented in C++ (zg_bridge.cpp).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_BRIDGE_H
#define ZG_BRIDGE_H

#ifdef __cplusplus
extern "C" {
#endif

void zg_log_line (const char *source, const char *line);
void zg_time_now (unsigned *sec, unsigned *usec);
void zg_fatal (const char *message) __attribute__ ((noreturn));

#ifdef __cplusplus
}
#endif

#endif
