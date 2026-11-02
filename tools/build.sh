#!/bin/sh
#
# Builds src/kernel.img for QEMU or for the real Pi Zero.
#
# Usage: tools/build.sh qemu|pi [TEST=1]
#
# The two targets need differently configured Circle libraries (QEMU lacks
# some peripherals the real board has). When the target changes, Circle,
# LVGL, QuickJS and the kernel are rebuilt from scratch; otherwise this is
# an ordinary incremental make.
#
# zerogap's fixes to Circle (patches/circle/*.patch) are applied to the
# submodule first, once.
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

for p in patches/circle/*.patch; do
	if ! git -C circle apply --check -R "../$p" 2>/dev/null; then
		echo "build: applying $p"
		git -C circle apply "../$p"
	fi
done

if [ "$(cat .buildtarget 2>/dev/null)" != "$TARGET" ]; then
	echo "build: configuring Circle for $TARGET (full rebuild)"
	( cd circle
	  ./configure -r 1 $QEMUOPT --keymap US --kernel-max-size 8 \
		-d KERNEL_STACK_SIZE=0x100000 -f >/dev/null
	  echo "FLASHBAUD = 921600" >> Config.mk
	  echo "USERBAUD = 115200" >> Config.mk
	  ./makeall --nosample clean >/dev/null )
	make -C lib/lvgl -s clean >/dev/null; rm -rf lib/lvgl/obj
	make -C lib/quickjs -s clean >/dev/null
	make -C src -s clean >/dev/null
	( cd circle && ./makeall --nosample $J >/dev/null )
	echo "$TARGET" > .buildtarget
fi
( cd circle && ./makeall --nosample $J >/dev/null )	# picks up patched files
make -C lib/lvgl -s $J >/dev/null
make -C lib/quickjs -s $J >/dev/null
make -C src -s $J "$@" >/dev/null
echo "build: src/kernel.img for $TARGET $*"
