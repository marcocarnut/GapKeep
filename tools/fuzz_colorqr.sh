#!/bin/sh
#
# Fuzzes the colour QR decoder (lib/colorqr) as the scanner's "qr-color"
# detector calls it, after the real QR decoder (zxing-cpp, through
# src/runtime/qrdecode.cpp), with AddressSanitizer and UBSan:
# tests/fuzz/fuzz_colorqr.cpp, on the colour codes in tests/colorqr.
#
#   tools/fuzz_colorqr.sh [rounds] [seed]      (default 2000 rounds, seed 1)
#
# Needs third_party/zxing-cpp and Python's PIL (to turn the PNGs into PPM).
#
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZX=$ROOT/third_party/zxing-cpp/core/src
[ -f "$ZX/ReadBarcode.cpp" ] || { echo "fuzz_colorqr: needs the QR decoder, third_party/zxing-cpp" >&2; exit 2; }
"$ROOT/tools/apply_patches.sh" zxing-cpp
OUT=$ROOT/sim/build/fuzz
mkdir -p "$OUT"
# zxing-cpp as tools/fuzz_qr.sh checks it; colorqr also for float division
# by zero (IEEE gives infinity, which zxing-cpp relies on; colorqr asks for
# the stricter check)
SAN="-fsanitize=address,undefined,float-cast-overflow -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1"
# (FUZZ_FLOAT_DIV=0 leaves that out, to look past a known report)
CQSAN="$SAN"
[ "$FUZZ_FLOAT_DIV" = 0 ] || CQSAN="$SAN -fsanitize=float-divide-by-zero"
SOURCES=$(make -s --no-print-directory -f "$ROOT/lib/zxing/zxing.mk" --eval='print:;@echo $(ZXING_SOURCES)' print)
DEFINES=$(make -s --no-print-directory -f "$ROOT/lib/zxing/zxing.mk" --eval='print:;@echo $(ZXING_DEFINES)' print)
INC="-I $ROOT/src/runtime -I $ROOT/sim/include -I $ROOT/lib/lvgl -idirafter $ROOT/circle/addon -I $ROOT/lib/zxing -I $ZX"
DEF="-DZG_SIM -DZG_HAVE_ZXING -DLV_CONF_PATH=<zg_lv_conf.h> $DEFINES"
CXX="g++ -std=c++20 -fno-exceptions -fno-rtti $SAN $DEF"
# zxing-cpp's objects, as tools/fuzz_qr.sh builds them (without its test exports)
OBJS=
for c in $SOURCES; do
	o=$OUT/cq-zx-$(echo "$c" | tr / _ | sed 's/\.cpp$/.o/')
	if [ ! -f "$o" ] || [ "$ZX/$c" -nt "$o" ] || [ "$0" -nt "$o" ]; then
		$CXX $INC -c "$ZX/$c" -o "$o"
	fi
	OBJS="$OBJS $o"
done
for c in cq_qr cq_ra cq_decode; do
	gcc -std=gnu99 $CQSAN -DCQ_PROFILE -I "$ROOT/lib/colorqr/include" -I "$ROOT/lib/colorqr/src" \
		-c "$ROOT/lib/colorqr/src/$c.c" -o "$OUT/$c.o"
	OBJS="$OBJS $OUT/$c.o"
done
$CXX $INC -I "$ROOT/lib/colorqr/include" -o "$OUT/fuzz_colorqr" "$ROOT/tests/fuzz/fuzz_colorqr.cpp" \
	"$ROOT/src/runtime/qrdecode.cpp" $OBJS -lm
FRAMES=
for p in "$ROOT"/tests/colorqr/*.png; do
	f=$OUT/$(basename "$p" .png).ppm
	python3 -c "import sys; from PIL import Image; Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2])" "$p" "$f"
	FRAMES="$FRAMES $f"
done
exec "$OUT/fuzz_colorqr" "${1:-2000}" "${2:-1}" $FRAMES
