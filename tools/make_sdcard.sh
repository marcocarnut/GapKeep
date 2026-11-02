#!/bin/sh
#
# Prepares the files for a Pi Zero's SD card. Copy everything in the output
# directory to the root of a FAT32 card.
#
#   tools/make_sdcard.sh               -> sdcard/: development card for the rig
#                                         (docs/RIG.md): Circle's serial
#                                         bootloader at FLASHBAUD; kernels
#                                         arrive over the serial line
#   tools/make_sdcard.sh --standalone  -> sdcard-standalone/: zerogap itself
#                                         (production build), boots on its own
#
set -e
cd "$(dirname "$0")/.."
make -C circle/boot all >/dev/null

if [ "$1" = "--standalone" ]; then
	OUT=sdcard-standalone
	tools/build.sh pi
	rm -rf $OUT && mkdir $OUT
	for f in bootcode.bin start.elf fixup.dat LICENCE.broadcom; do
		cp "circle/boot/$f" $OUT/
	done
	cp src/kernel.img $OUT/
	cat > $OUT/config.txt <<'CFG'
# zerogap standalone card (Raspberry Pi Zero)
arm_64bit=0
initial_turbo=0
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
	cat > $OUT/config.txt <<'CFG'
# zerogap development card: boots Circle's serial bootloader, which waits
# for a kernel on GPIO 14/15.
arm_64bit=0
initial_turbo=0
# fixed UART clock, so 921600 baud is exact enough on GPIO 14/15
init_uart_clock=48000000
CFG
fi

( cd $OUT && sha256sum * > SHA256SUMS )
echo "$OUT/ ready:"
cat $OUT/SHA256SUMS
