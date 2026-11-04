#!/bin/sh
#
# Fuzzes the QR decoder (zxing-cpp's QR code reader, through
# src/runtime/qrdecode.cpp) on this machine with AddressSanitizer and UBSan:
# tests/fuzz/fuzz_qr.cpp.
#
#   tools/fuzz_qr.sh [rounds] [seed]      (default 2000 rounds, seed 1)
#
# Any memory error, undefined behaviour, failed assertion or fatal error
# (what zxing-cpp would throw: a stop on the Pi) stops it with a report.
# Needs third_party/zxing-cpp.
#
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZX=$ROOT/third_party/zxing-cpp/core/src
[ -f "$ZX/ReadBarcode.cpp" ] || { echo "fuzz_qr: needs the QR decoder, third_party/zxing-cpp" >&2; exit 2; }
"$ROOT/tools/apply_patches.sh" zxing-cpp
OUT=$ROOT/sim/build/fuzz
mkdir -p "$OUT"
SAN="-fsanitize=address,undefined,float-cast-overflow -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1"
# the sources and defines of the real builds (lib/zxing/zxing.mk)
SOURCES=$(make -s --no-print-directory -f "$ROOT/lib/zxing/zxing.mk" --eval='print:;@echo $(ZXING_SOURCES)' print)
DEFINES=$(make -s --no-print-directory -f "$ROOT/lib/zxing/zxing.mk" --eval='print:;@echo $(ZXING_DEFINES)' print)
INC="-I $ROOT/src/runtime -I $ROOT/sim/include -I $ROOT/lib/lvgl -idirafter $ROOT/circle/addon -I $ROOT/lib/zxing -I $ZX"
DEF="-DZG_SIM -DZG_HAVE_ZXING -DLV_CONF_PATH=<zg_lv_conf.h> $DEFINES"
# as the simulator and the kernel build them: C++20, no exceptions, no RTTI;
# ZXING_BUILD_FOR_TEST exports the payload decoder, for the direct rounds
CXX="g++ -std=c++20 -fno-exceptions -fno-rtti $SAN $DEF -DZXING_BUILD_FOR_TEST"
OBJS=
for c in $SOURCES; do
	o=$OUT/zx-$(echo "$c" | tr / _ | sed 's/\.cpp$/.o/')
	if [ ! -f "$o" ] || [ "$ZX/$c" -nt "$o" ] || [ "$0" -nt "$o" ]; then
		$CXX $INC -c "$ZX/$c" -o "$o"
	fi
	OBJS="$OBJS $o"
done
# qrcodegen with its internals visible (QRCODEGEN_TEST), for crafted codes
gcc $SAN $DEF -DQRCODEGEN_TEST $INC -c "$ROOT/circle/addon/lvgl/lvgl/src/libs/qrcode/qrcodegen.c" -o "$OUT/qrcodegen.o"
$CXX $INC -o "$OUT/fuzz_qr" "$ROOT/tests/fuzz/fuzz_qr.cpp" \
	"$ROOT/src/runtime/qrdecode.cpp" "$ROOT/src/runtime/synthcam.cpp" \
	$OBJS "$OUT/qrcodegen.o" -lm
exec "$OUT/fuzz_qr" "${1:-2000}" "${2:-1}"
