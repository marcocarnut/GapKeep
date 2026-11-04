/*
 * hexcheck.h - compares a digest with lowercase hex, for the self-tests.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_HEXCHECK_H
#define ZG_HEXCHECK_H

#include <stddef.h>
#include <stdint.h>

static inline int zg_hex_equal (const uint8_t *digest, size_t len, const char *hex)
{
	static const char digits[] = "0123456789abcdef";
	for (size_t i = 0; i < len; i++)
	{
		if (hex[2*i] != digits[digest[i] >> 4] || hex[2*i+1] != digits[digest[i] & 15])
		{
			return 0;
		}
	}
	return hex[2*len] == '\0';
}

#endif
