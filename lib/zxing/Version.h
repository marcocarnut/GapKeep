//
// Version.h - zxing-cpp's build configuration, for GapKeep's QR-only
// reader (zxing-cpp generates this file from core/Version.h.in with CMake;
// GapKeep's builds don't use CMake). Used by lib/zxing/Makefile,
// sim/Makefile and tools/fuzz_qr.sh.
//
// SPDX-License-Identifier: Apache-2.0
//
#pragma once

#define ZXING_READERS
// no writers

#define ZXING_ENABLE_1D 0
#define ZXING_ENABLE_AZTEC 0
#define ZXING_ENABLE_DATAMATRIX 0
#define ZXING_ENABLE_MAXICODE 0
#define ZXING_ENABLE_PDF417 0
#define ZXING_ENABLE_QRCODE 1
// no character-set conversion: GapKeep takes the payload's raw bytes
#define ZXING_ENABLE_UNICODE 0

#define ZXING_VERSION_MAJOR 3
#define ZXING_VERSION_MINOR 1
#define ZXING_VERSION_PATCH 1
#define ZXING_VERSION_SUFFIX ""
#define ZXING_VERSION_STR "3.1.1"
