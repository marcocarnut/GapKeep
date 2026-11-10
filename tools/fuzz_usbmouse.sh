#!/bin/sh
#
# Fuzzes the USB mouse's HID report descriptor parser (Circle's
# lib/usb/usbmousereport.cpp, patches/circle/0009) on this machine with
# AddressSanitizer and UBSan: tests/fuzz/fuzz_usbmouse.cpp.
#
#   tools/fuzz_usbmouse.sh [rounds] [seed]      (default 200000 rounds, seed 1)
#
# Any memory error, undefined behaviour, or descriptor handled wrongly (see
# the test's comment) stops it with a report. Needs the circle submodule.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/circle/Rules.mk" ] || { echo "fuzz_usbmouse: needs the circle submodule" >&2; exit 2; }
"$ROOT/tools/apply_patches.sh" circle
OUT=$ROOT/sim/build/fuzz
mkdir -p "$OUT"
SAN="-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1"
# the simulator's stand-in <circle/types.h>, then Circle's own headers
INC="-I $ROOT/sim/include -idirafter $ROOT/circle/include"
g++ -std=c++17 -Wall $SAN $INC -o "$OUT/fuzz_usbmouse" \
	"$ROOT/tests/fuzz/fuzz_usbmouse.cpp" "$ROOT/circle/lib/usb/usbmousereport.cpp"
exec "$OUT/fuzz_usbmouse" "${1:-200000}" "${2:-1}"
