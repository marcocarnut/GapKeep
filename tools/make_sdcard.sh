#!/bin/sh
#
# Prepares the files for a Pi Zero's SD card. Copy everything in the output
# directory to the root of a FAT32 card.
#
#   tools/make_sdcard.sh               -> sdcard/: development card for the rig
#                                         (docs/RIG.md): Circle's serial
#                                         bootloader at FLASHBAUD; kernels
#                                         arrive over the serial line. Its
#                                         apps/ holds the test card's apps
#                                         (tests/sdcard, tests/sdapps.txt).
#   tools/make_sdcard.sh --standalone  -> sdcard-standalone/: GapKeep itself
#                                         (production build), boots on its
#                                         own; the apps are in apps/ on the
#                                         card, one folder each, as in the
#                                         repository's apps/
#   tools/make_sdcard.sh --sealed      -> sdcard-sealed/: every app built
#                                         into kernel.img, which then has no
#                                         SD card code at all
#
#   --data DIR (with --standalone, or for the development card; more than
#   once is fine): every folder in DIR goes on the card as data/<name>, the
#   read-only data folders apps read with gk:data (docs/APPS.md, "Data
#   files"), e.g. DIR/pgp/alice.asc -> data/pgp/alice.asc. Their hashes,
#   as the launcher shows them, are printed. A sealed build reads no card,
#   so it has no data folders.
#
#   tools/make_sdcard.sh --standalone --data ~/gapkeep-data
#
# The Pi firmware (closed, Broadcom's) comes from the raspberrypi/firmware
# commit that Circle pins (circle/boot/Makefile); tools/firmware.sha256 pins
# the bytes too (checked against that commit's git blob ids when written).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
MODE=
DATA=
while [ $# -gt 0 ]; do
	case $1 in
	--standalone|--sealed) MODE=$1; shift ;;
	--data) [ -d "$2" ] || { echo "make_sdcard: --data $2 is not a folder" >&2; exit 2; }
		DATA="$DATA $(cd "$2" && pwd)"; shift 2 ;;
	*) echo "make_sdcard: unknown argument $1" >&2; exit 2 ;;
	esac
done
[ -z "$DATA" ] || [ "$MODE" != --sealed ] || {
	echo "make_sdcard: a sealed build reads no card: --data has no use" >&2; exit 2; }
set -- $MODE
cd "$(dirname "$0")/.."
make -C circle/boot all >/dev/null
( cd circle/boot && sha256sum -c --quiet ../../tools/firmware.sha256 ) || {
	echo "make_sdcard: the firmware files differ from tools/firmware.sha256" >&2; exit 1; }

if [ "$1" = "--standalone" ] || [ "$1" = "--sealed" ]; then
	if [ "$1" = "--sealed" ]; then
		OUT=sdcard-sealed
		tools/build.sh pi SEALED=1
	else
		OUT=sdcard-standalone
		tools/build.sh pi
	fi
	rm -rf $OUT && mkdir $OUT
	for f in bootcode.bin start.elf fixup.dat LICENCE.broadcom; do
		cp "circle/boot/$f" $OUT/
	done
	cp src/kernel.img $OUT/
	# kernel.img is GapKeep (GPL-3.0-or-later) on Circle (GPL-3.0), with
	# LVGL and QuickJS (MIT) and, unless sealed, FatFs (its own BSD-style
	# licence): their notices go with it
	cp LICENSE $OUT/LICENCE.gapkeep
	cp circle/LICENSE $OUT/LICENCE.circle
	cp circle/addon/lvgl/lvgl/LICENCE.txt $OUT/LICENCE.lvgl
	cp third_party/quickjs/LICENSE $OUT/LICENCE.quickjs
	[ $OUT = sdcard-sealed ] || cp circle/addon/fatfs/LICENSE.txt $OUT/LICENCE.fatfs
	# and zxing-cpp (the QR decoder), whose licence goes with it
	[ ! -f third_party/zxing-cpp/LICENSE ] || cp third_party/zxing-cpp/LICENSE $OUT/LICENCE.zxing-cpp
	# and libsecp256k1 and colorqr (MIT: their notices go with copies)
	cp third_party/secp256k1/COPYING $OUT/LICENCE.secp256k1
	cp lib/colorqr/LICENSE $OUT/LICENCE.colorqr
	# and the fonts (tools/make_fonts.py): Montserrat, Font Awesome Free
	# and JetBrains Mono, all under the SIL Open Font License
	cp src/runtime/fonts/LICENCE.montserrat src/runtime/fonts/LICENCE.fontawesome \
	   src/runtime/fonts/LICENCE.jetbrainsmono $OUT/
	if [ $OUT = sdcard-standalone ]; then
		mkdir $OUT/apps
		for a in apps/*/; do
			[ "$(basename "$a")" = launcher ] || cp -r "$a" $OUT/apps/
		done
	fi
	cat > $OUT/config.txt <<'CFG'
# GapKeep standalone card (Raspberry Pi Zero)
arm_64bit=0
initial_turbo=0
# GapKeep never uses the serial port: the firmware leaves it off too
enable_uart=0
# HDMI is output only: ignore CEC, so the TV can't send anything back
hdmi_ignore_cec=1
hdmi_ignore_cec_init=1
# use the whole screen: without this the firmware leaves a black border
# (overscan) on many monitors
disable_overscan=1
CFG
else
	OUT=sdcard
	rm -rf $OUT && mkdir $OUT
	for f in bootcode.bin start.elf fixup.dat LICENCE.broadcom kernel.img; do
		cp "circle/boot/$f" $OUT/
	done
	cp circle/LICENSE $OUT/LICENCE.circle	# kernel.img: Circle's bootloader
	cat > $OUT/config.txt <<'CFG'
# GapKeep development card: boots Circle's serial bootloader, which waits
# for a kernel on GPIO 14/15.
arm_64bit=0
initial_turbo=0
# fixed UART clock, so 921600 baud is exact enough on GPIO 14/15
init_uart_clock=48000000
hdmi_ignore_cec=1
hdmi_ignore_cec_init=1
CFG
	cp -r tests/sdcard/apps tests/sdcard/data $OUT/
fi

# data folders (--data): never part of an app's hash, so print theirs
if [ -n "$DATA" ]; then
	mkdir -p $OUT/data
	for d in $DATA; do
		for f in "$d"/*/; do
			[ -d "$f" ] || continue
			name=$(basename "$f")
			echo "$name" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$' || {
				echo "make_sdcard: $f: a data folder's name is a-z, 0-9 and -, at most 32" >&2; exit 1; }
			rm -rf "$OUT/data/$name"
			cp -r "$f" "$OUT/data/$name"
			python3 tools/bundle_apps.py --data-hash "$OUT/data/$name"
		done
	done
fi

( cd $OUT && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS )
echo "$OUT/ ready:"
cat $OUT/SHA256SUMS
