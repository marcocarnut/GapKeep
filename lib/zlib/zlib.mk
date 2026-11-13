#
# zlib's inflate (third_party/zlib): what is built and how. Shared by
# lib/zlib/Makefile (the kernel), sim/Makefile and tests (the host).
#
# zlib 1.3.2, zlib License (third_party/zlib/LICENSE), copied unchanged
# from its GitHub release:
#   https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz
#   SHA-256 bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
#   (as GitHub lists the asset), and its signature
#   (zlib-1.3.2.tar.gz.asc) good by Mark Adler's key
#   5ED4 6A67 21D3 6558 7791 E2AA 783F CD8E 58BC AFBA (as zlib.net names it)
# Only decompression: inflate, its tables, Adler-32 and zutil; no gzip
# (NO_GZIP: no CRC-32, no gzip headers), no deflate, no default allocator
# (Z_SOLO: the caller gives zalloc and zfree). Used by
# src/runtime/inflate.c (gk:zlib).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
ZLIB_DIR     = $(ROOT)/third_party/zlib
ZLIB_SOURCES = adler32.c inffast.c inflate.c inftrees.c zutil.c
ZLIB_DEFINES = -DNO_GZIP -DZ_SOLO
ZLIB_INCLUDE = -I $(ZLIB_DIR)
