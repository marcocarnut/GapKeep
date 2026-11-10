#!/bin/sh
#
# Builds src/kernel.img for QEMU or for the real Pi Zero.
#
# Usage: tools/build.sh qemu|pi [TEST=1 | SEALED=1]
#   (see src/Makefile for what TEST and SEALED build)
#
# The two targets need differently configured Circle libraries (QEMU lacks
# some peripherals the real board has). When the target changes, Circle,
# LVGL, QuickJS and the kernel are rebuilt from scratch; otherwise this is
# an ordinary incremental make.
#
# GapKeep's changes to Circle and zxing-cpp (patches/*/) are applied to the
# submodules first, once (tools/apply_patches.sh).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/.."
TARGET=$1; shift || true
case "$TARGET" in
	qemu) QEMUOPT=--qemu ;;
	pi)   QEMUOPT= ;;
	*)    echo "usage: $0 qemu|pi [TEST=1]" >&2; exit 2 ;;
esac
J=-j"$(nproc)"

# Reproducible builds: __DATE__ and __TIME__ (in the boot log) are the time
# of the last commit, not of the build.
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct 2>/dev/null || echo 0)
export SOURCE_DATE_EPOCH

tools/apply_patches.sh circle
tools/apply_patches.sh zxing-cpp

# Circle's configuration. USB: only hubs, keyboards and mice (boot
# protocol); every other class driver is left out of the image, since a USB
# device is the only way in from outside. (EXCLUDE_USB_TOUCHSCREEN also
# turns off the generic-HID path, whose report descriptor parser is the
# riskiest code a device could feed.)
CONFIG="-r 1 $QEMUOPT --keymap US --kernel-max-size 8 -d KERNEL_STACK_SIZE=0x100000"

# The compiler: the pinned one in toolchain/ (tools/toolchain.sh) if it is
# there, which makes builds reproducible; otherwise arm-none-eabi-* from PATH.
if [ -x toolchain/arm-none-eabi/bin/arm-none-eabi-gcc ]; then
	CONFIG="$CONFIG -p $(pwd)/toolchain/arm-none-eabi/bin/arm-none-eabi-"
else
	echo "build: using $(command -v arm-none-eabi-gcc) (tools/toolchain.sh fetches the pinned one)"
fi
for d in STORAGE GAMEPAD PRINTER NET BLUETOOTH MIDI AUDIO SERIAL TOUCHSCREEN; do
	CONFIG="$CONFIG -d EXCLUDE_USB_$d"
done

# Everything (Circle, LVGL, QuickJS, GapKeep) is compiled with stack
# canaries; src/runtime/stackguard.cpp sets the canary from the hardware RNG.
OPTIMIZE="-O2 -fstack-protector-strong"

if [ "$(cat .buildtarget 2>/dev/null)" != "$TARGET $CONFIG $OPTIMIZE" ]; then
	echo "build: configuring Circle for $TARGET (full rebuild)"
	( cd circle
	  ./configure $CONFIG -f >/dev/null
	  echo "OPTIMIZE = $OPTIMIZE" >> Config.mk
	  echo "FLASHBAUD = 921600" >> Config.mk
	  echo "USERBAUD = 115200" >> Config.mk
	  ./makeall --nosample clean >/dev/null )
	make -C lib/lvgl -s clean >/dev/null; rm -rf lib/lvgl/obj
	make -C lib/quickjs -s clean >/dev/null
	make -C lib/fatfs -s clean >/dev/null
	make -C lib/zxing -s clean >/dev/null
	make -C lib/secp256k1 -s clean >/dev/null
	make -C lib/colorqr -s clean >/dev/null
	make -C circle/addon/SDCard -s clean >/dev/null
	make -C src -s clean >/dev/null
	( cd circle && ./makeall --nosample $J >/dev/null )
	echo "$TARGET $CONFIG $OPTIMIZE" > .buildtarget
fi
( cd circle && ./makeall --nosample $J >/dev/null )	# picks up patched files
make -C lib/lvgl -s $J >/dev/null
make -C lib/quickjs -s $J >/dev/null
make -C lib/fatfs -s $J >/dev/null
make -C lib/secp256k1 -s $J >/dev/null
make -C lib/colorqr -s $J >/dev/null
# the QR decoder (QR scanners report "no QR decoder" without the submodule)
[ ! -f third_party/zxing-cpp/core/src/ReadBarcode.cpp ] || make -C lib/zxing -s $J >/dev/null
make -C circle/addon/SDCard -s $J >/dev/null
# QEMU builds keep the serial log: the tests read it (src/Makefile, LOG)
LOG=
case " $* " in *" TEST=1 "*) ;; *) [ "$TARGET" = qemu ] && LOG=LOG=serial ;; esac
make -C src -s $J $LOG "$@" >/dev/null
echo "build: src/kernel.img for $TARGET $* $LOG"
