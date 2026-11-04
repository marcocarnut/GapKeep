#!/bin/sh
#
# Fuzzes the QR decoder (quirc, through src/runtime/qrdecode.cpp) on this
# machine with AddressSanitizer and UBSan: tests/fuzz/fuzz_qr.cpp.
#
#   tools/fuzz_qr.sh [rounds] [seed]      (default 2000 rounds, seed 1)
#
# Any memory error stops it with a report. Needs third_party/quirc.
#
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
Q=$ROOT/third_party/quirc/lib
[ -f "$Q/quirc.c" ] || { echo "fuzz_qr: needs the QR decoder, third_party/quirc" >&2; exit 2; }
OUT=$ROOT/sim/build/fuzz
mkdir -p "$OUT"
SAN="-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1"
INC="-I $ROOT/src/runtime -I $ROOT/sim/include -I $ROOT/lib/lvgl -idirafter $ROOT/circle/addon -I $Q"
DEF="-DZG_SIM -DZG_HAVE_QUIRC -DLV_CONF_PATH=<zg_lv_conf.h>"
for c in "$Q"/*.c; do
	gcc $SAN $DEF -I "$Q" -c "$c" -o "$OUT/$(basename "$c" .c).o"
done
gcc $SAN $DEF $INC -c "$ROOT/circle/addon/lvgl/lvgl/src/libs/qrcode/qrcodegen.c" -o "$OUT/qrcodegen.o"
g++ $SAN $DEF $INC -o "$OUT/fuzz_qr" "$ROOT/tests/fuzz/fuzz_qr.cpp" \
	"$ROOT/src/runtime/qrdecode.cpp" "$ROOT/src/runtime/synthcam.cpp" \
	"$OUT"/decode.o "$OUT"/identify.o "$OUT"/quirc.o "$OUT"/version_db.o "$OUT/qrcodegen.o" -lm
exec "$OUT/fuzz_qr" "${1:-2000}" "${2:-1}"
