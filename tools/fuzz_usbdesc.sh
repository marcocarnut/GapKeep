#!/bin/sh
#
# Fuzzes gk:usb's USB descriptor parsers (src/runtime/usbdesc.c: what a
# claimed device says of itself) on this machine with AddressSanitizer and
# UBSan: tests/fuzz/fuzz_usbdesc.cpp.
#
#   tools/fuzz_usbdesc.sh [rounds] [seed]      (default 200000 rounds, seed 1)
#
# Any memory error, undefined behaviour, or descriptor handled wrongly (see
# the test's comment) stops it with a report.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/sim/build/fuzz
mkdir -p "$OUT"
SAN="-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1"
gcc -std=gnu11 -Wall -c $SAN -o "$OUT/usbdesc.o" "$ROOT/src/runtime/usbdesc.c"
g++ -std=c++17 -Wall $SAN -o "$OUT/fuzz_usbdesc" "$ROOT/tests/fuzz/fuzz_usbdesc.cpp" "$OUT/usbdesc.o"
exec "$OUT/fuzz_usbdesc" "${1:-200000}" "${2:-1}"
