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
# A later patch may change lines an earlier one changed (0009 replaces the
# mouse report parser that 0001 fixed), so "already applied" is decided for
# the whole series first: the files the patches touch, as the submodule's
# commit has them with every patch applied, compared with the working tree.
# Only when they differ is each patch checked on its own (a checkout made
# before the newest patches: the earlier ones are there, the new ones not).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/.."
case "$1" in
	circle) DIR=circle ;;
	zxing-cpp) DIR=third_party/zxing-cpp ;;
	*)      echo "usage: $0 circle|zxing-cpp" >&2; exit 2 ;;
esac
[ -e "$DIR/.git" ] || exit 0		# not checked out
ls patches/$1/*.patch >/dev/null 2>&1 || exit 0

# the whole series applied already?
series_applied() {
	TMP=$(mktemp -d)
	trap 'rm -rf "$TMP"' EXIT
	FILES=$(sed -n 's|^+++ b/||p' patches/$1/*.patch | sort -u)
	for f in $FILES; do
		mkdir -p "$TMP/$(dirname "$f")"
		git -C "$DIR" show "HEAD:$f" > "$TMP/$f" 2>/dev/null || rm -f "$TMP/$f"	# new file
	done
	for p in patches/$1/*.patch; do
		# outside a repository, git apply patches plain files
		( cd "$TMP" && git apply "$OLDPWD/$p" ) 2>/dev/null || return 1
	done
	for f in $FILES; do
		cmp -s "$TMP/$f" "$DIR/$f" || return 1
	done
	return 0
}
series_applied "$1" && exit 0

for p in patches/$1/*.patch; do
	if ! git -C "$DIR" apply --check -R "$PWD/$p" 2>/dev/null; then
		echo "apply_patches: $p" >&2
		git -C "$DIR" apply "$PWD/$p"
	fi
done
