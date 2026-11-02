//
// testcrash.h
//
// Test builds only: deliberate violations of the memory protection, each
// of which must stop the system (tests/memprotect.txt).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _testcrash_h
#define _testcrash_h

// kind: write-code, write-rodata, write-vectors, exec-data, exec-heap,
// exec-stack, stack-overflow, smash. Returns only for an unknown kind.
void ZgTestCrash (const char *pKind);

#endif
