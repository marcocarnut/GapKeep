#!/bin/sh
#
# Fetches the pinned compiler into toolchain/: Arm GNU Toolchain 13.2.Rel1
# (arm-none-eabi, for x86_64 Linux hosts), checked against its SHA-256.
# tools/build.sh uses it when it is there, so builds don't depend on
# whatever compiler the system has: with it, the same sources give the same
# kernel.img, byte for byte (tools/check_reproducible.sh).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/.."
NAME=arm-gnu-toolchain-13.2.rel1-x86_64-arm-none-eabi
URL=https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/$NAME.tar.xz
SHA256=6cd1bbc1d9ae57312bcd169ae283153a9572bd6a8e4eeae2fedfbc33b115fdbb

[ "$(uname -m)" = x86_64 ] || { echo "toolchain: only x86_64 hosts are pinned" >&2; exit 1; }
mkdir -p toolchain
if [ ! -f toolchain/$NAME.tar.xz ]; then
	echo "toolchain: downloading $NAME (180 MB)"
	curl -fsSL -o toolchain/$NAME.tar.xz.part "$URL"
	mv toolchain/$NAME.tar.xz.part toolchain/$NAME.tar.xz
fi
echo "$SHA256  toolchain/$NAME.tar.xz" | sha256sum -c --quiet || {
	echo "toolchain: checksum mismatch, deleting the download" >&2
	rm -f toolchain/$NAME.tar.xz; exit 1; }
rm -rf toolchain/arm-none-eabi
mkdir toolchain/arm-none-eabi
tar -xJf toolchain/$NAME.tar.xz -C toolchain/arm-none-eabi --strip-components=1
toolchain/arm-none-eabi/bin/arm-none-eabi-gcc --version | head -1
