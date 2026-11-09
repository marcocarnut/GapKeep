/*
 * gk_bridge.h - C-callable services implemented in C++ (gk_bridge.cpp).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_BRIDGE_H
#define GK_BRIDGE_H

#ifdef __cplusplus
extern "C" {
#endif

void gk_log_line (const char *source, const char *line);
void gk_time_now (unsigned *sec, unsigned *usec);	/* clock.cpp: UTC */
int gk_utc_offset_minutes (void);			/* clock.cpp: local time's offset */
void gk_fatal (const char *message) __attribute__ ((noreturn));

#ifdef __cplusplus
}
#endif

#endif
