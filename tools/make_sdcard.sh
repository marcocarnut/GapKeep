#!/bin/sh
#
# Prepares the files for the Pi Zero's SD card in sdcard/: the pinned Pi
# firmware and Circle's serial bootloader (at FLASHBAUD from circle/Config.mk).
# Copy everything in sdcard/ to the root of a FAT32 card. After that, kernels
# are sent over the serial line; the card never needs to change.
#
set -e
cd "$(dirname "$0")/.."
make -C circle/boot all >/dev/null
rm -rf sdcard && mkdir sdcard
for f in bootcode.bin start.elf fixup.dat LICENCE.broadcom kernel.img; do
	cp "circle/boot/$f" sdcard/
done
cat > sdcard/config.txt <<'CFG'
# zerogap development card: boots Circle's serial bootloader, which waits
# for a kernel on GPIO 14/15.
arm_64bit=0
initial_turbo=0
# fixed UART clock, so 921600 baud is exact enough on GPIO 14/15
init_uart_clock=48000000
CFG
( cd sdcard && sha256sum * > SHA256SUMS )
echo "sdcard/ ready (bootloader at $(grep '^FLASHBAUD' circle/Config.mk | cut -d= -f2 | tr -d ' ') baud):"
cat sdcard/SHA256SUMS
