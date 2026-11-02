#!/bin/sh
#
# Checks that builds are reproducible: makes two fresh checkouts of HEAD in
# different directories, builds each with the pinned compiler
# (tools/toolchain.sh), and compares the kernel images byte for byte.
#
# Usage: tools/check_reproducible.sh [build options]   (default: pi)
#        e.g. tools/check_reproducible.sh pi SEALED=1
#
# Prints the SHA-256 of the kernel image, which anyone building the same
# commit the same way must get too.
#
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
[ -x toolchain/arm-none-eabi/bin/arm-none-eabi-gcc ] || {
	echo "check_reproducible: run tools/toolchain.sh first" >&2; exit 1; }
ARGS=${*:-pi}
WORK=$(mktemp -d -t zerogap-repro-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

for n in 1 2; do
	dir=$WORK/build$n/zerogap-$n		# different paths on purpose
	git clone -q "$ROOT" "$dir"
	( cd "$dir"			# submodules from the local copies: no network
	  git config submodule.circle.url "$ROOT/circle"
	  git config submodule.third_party/quickjs.url "$ROOT/third_party/quickjs"
	  git -c protocol.file.allow=always submodule -q update --init
	  git -C circle config submodule.addon/lvgl/lvgl.url "$ROOT/circle/addon/lvgl/lvgl"
	  git -c protocol.file.allow=always -C circle submodule -q update --init addon/lvgl/lvgl
	  ln -s "$ROOT/toolchain" toolchain
	  tools/build.sh $ARGS >/dev/null )
	sha256sum "$dir/src/kernel.img" | cut -d' ' -f1 > "$WORK/hash$n"
	echo "build $n: $(cat "$WORK/hash$n")"
done

if cmp -s "$WORK/hash1" "$WORK/hash2"; then
	echo "reproducible: kernel.img ($ARGS) is the same in both builds"
else
	echo "NOT reproducible: the two builds differ" >&2
	exit 1
fi
