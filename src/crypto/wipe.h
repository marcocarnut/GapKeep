/*
 * wipe.h - gk_wipe(): overwrite memory that held a secret.
 *
 * A memset() of a buffer that is never read again (a key on the stack just
 * before the function returns, a block about to be freed) is a dead store
 * the compiler may remove, and GCC does at -O2 unless the build happens to
 * use -ffreestanding. gk_wipe() is not a memset() as far as the caller's
 * compiler can see: it is out of line, in its own file (wipe.c), and ends
 * with a compiler barrier, so even with link-time optimisation the stores
 * stay. Every wipe of a secret in GapKeep goes through it;
 * tests/native/check_wipes.sh checks that the calls survive compilation
 * without -ffreestanding.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_WIPE_H
#define GK_WIPE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Sets n bytes at p to zero, always. p may be 0 if n is 0. */
void gk_wipe (void *p, size_t n);

#ifdef __cplusplus
}
#endif

#endif
