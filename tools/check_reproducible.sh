#!/bin/sh
#
# Checks that builds are reproducible: makes two fresh checkouts of HEAD in
# different directories, builds each with the pinned compiler
# (tools/toolchain.sh), and compares the kernel images byte for byte.
#
# Usage: tools/check_reproducible.sh [build options]   (default: pi)
#        e.g. tools/check_reproducible.sh pi SEALED=1
#        tools/check_reproducible.sh --release
#
# Prints the SHA-256 of the kernel image, which anyone building the same
# commit the same way must get too. With --release, each checkout runs
# tools/make_release.sh instead, and every file it makes (images, zips,
# RELEASE.txt) must be the same in both: their SHA256SUMS are printed.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
[ -x toolchain/arm-none-eabi/bin/arm-none-eabi-gcc ] || {
	echo "check_reproducible: run tools/toolchain.sh first" >&2; exit 1; }
ARGS=${*:-pi}
RELEASE=
[ "$ARGS" != --release ] || RELEASE=1
WORK=$(mktemp -d -t gapkeep-repro-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

for n in 1 2; do
	dir=$WORK/build$n/gapkeep-$n		# different paths on purpose
	git clone -q "$ROOT" "$dir"
	( cd "$dir"			# submodules from the local copies: no network
	  git config submodule.circle.url "$ROOT/circle"
	  git config submodule.third_party/quickjs.url "$ROOT/third_party/quickjs"
	  git config submodule.third_party/zxing-cpp.url "$ROOT/third_party/zxing-cpp"
	  git config submodule.third_party/secp256k1.url "$ROOT/third_party/secp256k1"
	  git -c protocol.file.allow=always submodule -q update --init
	  git -C circle config submodule.addon/lvgl/lvgl.url "$ROOT/circle/addon/lvgl/lvgl"
	  git -c protocol.file.allow=always -C circle submodule -q update --init addon/lvgl/lvgl
	  ln -s "$ROOT/toolchain" toolchain
	  # the Pi firmware, if this checkout has it (else Circle downloads it)
	  if ( cd "$ROOT/circle/boot" && sha256sum -c --quiet "$ROOT/tools/firmware.sha256" ) >/dev/null 2>&1; then
		for f in $(awk '{print $2}' "$ROOT/tools/firmware.sha256"); do cp "$ROOT/circle/boot/$f" circle/boot/; done
	  fi
	  if [ -n "$RELEASE" ]; then
		tools/make_release.sh -o "$WORK/release$n" >/dev/null
	  else
		tools/build.sh $ARGS >/dev/null
	  fi )
	if [ -n "$RELEASE" ]; then
		cp "$WORK/release$n/SHA256SUMS" "$WORK/hash$n"
		echo "build $n:"; cat "$WORK/hash$n"
	else
		sha256sum "$dir/src/kernel.img" | cut -d' ' -f1 > "$WORK/hash$n"
		echo "build $n: $(cat "$WORK/hash$n")"
	fi
done

if cmp -s "$WORK/hash1" "$WORK/hash2"; then
	if [ -n "$RELEASE" ]; then
		echo "reproducible: every release file is the same in both builds"
	else
		echo "reproducible: kernel.img ($ARGS) is the same in both builds"
	fi
else
	echo "NOT reproducible: the two builds differ" >&2
	exit 1
fi
