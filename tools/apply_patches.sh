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
# mouse report parser that 0001 fixed), so whether a patch is applied can't
# be told from the patch alone. Instead the series is replayed on a copy of
# the files it touches, as the submodule's commit has them: after none of
# the patches, after the first, after the first two... The longest of
# these prefixes that the working tree matches is what is applied; the
# patches after it are applied now. So a checkout made before the newest
# patches gets just those, and one with the whole series gets nothing.
# A working tree that matches no prefix (edited by hand, or the submodule
# moved to another commit) is an error, and nothing is changed.
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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT=$PWD

# every file the series touches, those it creates too
FILES=$(sed -n -e 's|^+++ b/||p' -e 's|^--- a/||p' patches/$1/*.patch | sort -u)
for f in $FILES; do
	mkdir -p "$TMP/$(dirname "$f")"
	git -C "$DIR" show "HEAD:$f" > "$TMP/$f" 2>/dev/null || rm -f "$TMP/$f"	# new file
done

# whether the working tree's files are the copy's (a file absent from both
# is the same)
matches() {
	for f in $FILES; do
		if [ -e "$TMP/$f" ]; then
			cmp -s "$TMP/$f" "$DIR/$f" || return 1
		elif [ -e "$DIR/$f" ]; then
			return 1
		fi
	done
	return 0
}

APPLIED=-1		# the longest prefix the working tree matches
N=0
matches && APPLIED=0
for p in patches/$1/*.patch; do
	N=$((N + 1))
	# outside a repository, git apply patches plain files
	if ! ( cd "$TMP" && git apply "$ROOT/$p" ) 2>/dev/null; then
		echo "apply_patches: $p does not apply on top of the patches before it" >&2
		exit 1
	fi
	matches && APPLIED=$N
done

if [ $APPLIED -lt 0 ]; then
	echo "apply_patches: $DIR matches none of the series' steps: its files were changed" \
	     "by hand, or it is not at the commit the patches are for. To start again:" \
	     "git -C $DIR checkout -- . && git -C $DIR clean -fd -- \$(files the patches add)" >&2
	exit 1
fi

N=0
for p in patches/$1/*.patch; do
	N=$((N + 1))
	if [ $N -gt $APPLIED ]; then
		echo "apply_patches: $p" >&2
		git -C "$DIR" apply "$ROOT/$p"
	fi
done
