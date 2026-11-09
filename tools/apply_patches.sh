#!/bin/sh
#
# Applies GapKeep's fixes to third-party code: patches/<name>/*.patch to
# the submodule, each once (already applied: skipped). Called by
# tools/build.sh, sim/Makefile and tools/fuzz_qr.sh.
# The patches are in order (0001-..., 0002-...): each applies on top of
# the ones before it.
#
#   tools/apply_patches.sh circle|zxing-cpp
#
set -e
cd "$(dirname "$0")/.."
case "$1" in
	circle) DIR=circle ;;
	zxing-cpp) DIR=third_party/zxing-cpp ;;
	*)      echo "usage: $0 circle|zxing-cpp" >&2; exit 2 ;;
esac
[ -e "$DIR/.git" ] || exit 0		# not checked out
for p in patches/$1/*.patch; do
	[ -f "$p" ] || continue
	if ! git -C "$DIR" apply --check -R "$PWD/$p" 2>/dev/null; then
		echo "apply_patches: $p" >&2
		git -C "$DIR" apply "$PWD/$p"
	fi
done
