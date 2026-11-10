#!/bin/sh
#
# Builds a release's downloads from the current commit: SD card images for
# the Pi Zero, and the same cards as folders, one of each per language.
#
#   gapkeep-<version>-en.img.zip     English, US keyboard
#   gapkeep-<version>-pt-BR.img.zip  Português (Brasil), ABNT2 keyboard
#   gapkeep-<version>-<lang>.zip     the card's files, to copy onto a card
#                                    formatted FAT32 instead of imaging it
#   RELEASE.txt                      the commit, and the hashes the launcher
#                                    shows (kernel and apps), to compare
#   SHA256SUMS                       of all of the above
#
# Usage: tools/make_release.sh [-o DIR] [--allow-dirty]
#   -o DIR         where to put them (default release/)
#   --allow-dirty  build from a tree with uncommitted changes; the names then
#                  say "dirty" and RELEASE.txt says it is not a release
#
# Each card is tools/make_sdcard.sh --standalone (production build: the Pi
# firmware, kernel.img, every app in apps/ but the built-in launcher, the
# licences, config.txt) plus a gapkeep.txt with the language and keyboard
# (docs/APPS.md, "Languages"), and its own SHA256SUMS.
#
# Reproducible: the same commit gives the same files, byte for byte, on
# another machine (tools/check_reproducible.sh --release checks it). The
# kernel is built with the pinned compiler (tools/toolchain.sh, required);
# every timestamp is the commit's (SOURCE_DATE_EPOCH), the FAT volume ID
# comes from the commit, files go into the image and the zips in a fixed
# order. Needs dosfstools and mtools (any version as of 2021: mkfs.fat
# --invariant, mtools honouring SOURCE_DATE_EPOCH), python3 (zipfile).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
OUT=
ALLOW_DIRTY=
while [ $# -gt 0 ]; do
	case $1 in
	-o) [ -n "$2" ] || { echo "make_release: -o needs a folder" >&2; exit 2; }
	    OUT=$2; shift 2 ;;
	--allow-dirty) ALLOW_DIRTY=1; shift ;;
	*) echo "usage: $0 [-o DIR] [--allow-dirty]" >&2; exit 2 ;;
	esac
done
if [ -n "$OUT" ]; then
	mkdir -p "$OUT"
	OUT=$(cd "$OUT" && pwd)
fi
cd "$(dirname "$0")/.."
ROOT=$(pwd)
[ -n "$OUT" ] || { OUT=$ROOT/release; mkdir -p "$OUT"; }

for t in mkfs.fat mcopy mmd mdir python3 sha256sum; do
	command -v $t >/dev/null || { echo "make_release: needs $t (dosfstools, mtools, python3)" >&2; exit 1; }
done
NM=toolchain/arm-none-eabi/bin/arm-none-eabi-nm
[ -x toolchain/arm-none-eabi/bin/arm-none-eabi-gcc ] || {
	echo "make_release: run tools/toolchain.sh first (the pinned compiler: reproducible builds)" >&2; exit 1; }

# --- what is being released ------------------------------------------------

VERSION=$(sed -n 's/^#define[[:space:]]*GAPKEEP_VERSION[[:space:]]*"\(.*\)".*/\1/p' src/runtime/version.h)
[ -n "$VERSION" ] || { echo "make_release: no GAPKEEP_VERSION in src/runtime/version.h" >&2; exit 1; }
COMMIT=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short=12 HEAD)
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
export SOURCE_DATE_EPOCH

# Dirty: changed or untracked files, a submodule at another commit (not the
# patches tools/build.sh applies to them), or ignored files in apps/ (they
# would go on the card)
DIRTY=$( { git status --porcelain --ignore-submodules=dirty
	   git status --porcelain --ignored=matching -- apps | grep '^!!' || true; } )
if [ -n "$DIRTY" ]; then
	if [ -z "$ALLOW_DIRTY" ]; then
		echo "make_release: the tree has changes (--allow-dirty builds anyway, not as a release):" >&2
		echo "$DIRTY" | head -20 >&2
		exit 1
	fi
	NAME=gapkeep-$VERSION-$SHORT-dirty
	echo "make_release: NOT A RELEASE: uncommitted changes, names say \"dirty\"" >&2
else
	NAME=gapkeep-$VERSION
	git tag --points-at HEAD | grep -qx "v$VERSION" ||
		echo "make_release: note: HEAD is not tagged v$VERSION" >&2
fi

# --- the card --------------------------------------------------------------

# The Pi firmware: Circle's boot/Makefile downloads it (checked against
# tools/firmware.sha256 by make_sdcard.sh). In a git worktree, take the
# main checkout's copy if it has one, rather than downloading again.
fw_ok() { ( cd "$1" && sha256sum -c --quiet "$ROOT/tools/firmware.sha256" ) >/dev/null 2>&1; }
if ! fw_ok circle/boot; then
	MAIN=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
	if [ "$MAIN" != "$ROOT" ] && fw_ok "$MAIN/circle/boot"; then
		for f in $(awk '{print $2}' tools/firmware.sha256); do cp "$MAIN/circle/boot/$f" circle/boot/; done
	fi
fi

echo "make_release: building $NAME (commit $SHORT): tools/make_sdcard.sh --standalone"
WORK=$(mktemp -d -t gapkeep-release-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
tools/make_sdcard.sh --standalone > "$WORK/build.log" 2>&1 || {
	tail -30 "$WORK/build.log" >&2; echo "make_release: the build failed" >&2; exit 1; }
CARD=$ROOT/sdcard-standalone

# what the launcher shows: the SHA-256 of the kernel's code and constants,
# the first (__data_start - MEM_KERNEL_START) bytes of kernel.img
# (src/runtime/js_sys.cpp, tests/check_kernel_hash.sh)
DATA_START=$($NM src/kernel.elf | awk '$3 == "__data_start" {print $1}')
[ -n "$DATA_START" ] || { echo "make_release: no __data_start in src/kernel.elf" >&2; exit 1; }
HASHED=$(( 0x$DATA_START - 0x8000 ))
KHASH=$(head -c $HASHED "$CARD/kernel.img" | sha256sum | cut -d' ' -f1)
KFILE=$(sha256sum "$CARD/kernel.img" | cut -d' ' -f1)

# a FAT32 image: an MBR, one partition (type 0x0C) from 4 MiB to the end,
# as Raspberry Pi OS lays out its boot partition; 256 MiB in all (a power
# of two, which QEMU needs), 2 KiB clusters. Mostly empty, so it costs
# little in the zip, and leaves room to add apps.
SIZE_MB=256
VOLID=$(echo "$COMMIT" | cut -c1-8)
make_image() {	# image, folder
	img=$1; dir=$2
	rm -f "$img"
	truncate -s ${SIZE_MB}M "$img"
	python3 - "$img" $SIZE_MB <<'PY'
import struct, sys
img, mb = sys.argv[1], int(sys.argv[2])
start, count = 8192, mb * 2048 - 8192
entry = struct.pack('<B3sB3sII', 0, b'\xfe\xff\xff', 0x0c, b'\xfe\xff\xff', start, count)
with open(img, 'r+b') as f:
    f.seek(446); f.write(entry)
    f.seek(510); f.write(b'\x55\xaa')
PY
	# --invariant: no time or random values (the volume label's date);
	# -i: the volume ID, from the commit
	mkfs.fat --invariant -i "$VOLID" -F 32 -s 4 --offset 8192 -n GAPKEEP \
		"$img" $(( (SIZE_MB - 4) * 1024 )) >/dev/null
	# folders, then files, in a fixed order; every date is
	# SOURCE_DATE_EPOCH, in UTC
	export TZ=UTC MTOOLS_SKIP_CHECK=1 LC_ALL=C
	( cd "$dir" && find . -mindepth 1 -type d | sort ) | while IFS= read -r d; do
		mmd -i "$img@@4M" "::/${d#./}"
	done
	( cd "$dir" && find . -type f | sort ) | while IFS= read -r f; do
		mcopy -i "$img@@4M" "$dir/${f#./}" "::/${f#./}"
	done
	unset TZ MTOOLS_SKIP_CHECK LC_ALL
}

# a zip: entries in a fixed order, each dated SOURCE_DATE_EPOCH (UTC),
# rw-r--r-- (folders rwxr-xr-x), deflated at level 9
make_zip() {	# zip, folder, name inside the zip
	python3 - "$@" <<'PY'
import os, sys, time, zipfile
out, src, top = sys.argv[1], sys.argv[2], sys.argv[3]
when = time.gmtime(max(int(os.environ['SOURCE_DATE_EPOCH']), 315532800))[:6]
entries = []
if os.path.isfile(src):
    entries.append((top, src))
else:
    for d, dirs, files in os.walk(src):
        rel = os.path.relpath(d, src)
        base = top if rel == '.' else top + '/' + rel.replace(os.sep, '/')
        entries.append((base + '/', None))
        entries += [(base + '/' + f, os.path.join(d, f)) for f in files]
entries.sort()
with zipfile.ZipFile(out + '.tmp', 'w') as z:
    for name, path in entries:
        info = zipfile.ZipInfo(name, when)
        info.create_system = 3
        if path is None:
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b'')
        else:
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(path, 'rb') as f:
                z.writestr(info, f.read(), compresslevel=9)
os.replace(out + '.tmp', out)
PY
}

LANGS="en pt-BR"
for lang in $LANGS; do
	case $lang in
	en)    keyboard=us;       about="English, US keyboard" ;;
	pt-BR) keyboard=br-abnt2; about="Português (Brasil), teclado ABNT2" ;;
	esac
	stage=$WORK/$NAME-$lang
	cp -r "$CARD" "$stage"
	cat > "$stage/gapkeep.txt" <<EOF
# GapKeep's settings, read at boot (docs/APPS.md, "Languages";
# docs/CLOCK.md, "gapkeep.txt")
language = $lang
keyboard = $keyboard
EOF
	( cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z |
	  xargs -0 sha256sum > SHA256SUMS )
	make_image "$WORK/$NAME-$lang.img" "$stage"
	make_zip "$OUT/$NAME-$lang.img.zip" "$WORK/$NAME-$lang.img" "$NAME-$lang.img"
	make_zip "$OUT/$NAME-$lang.zip" "$stage" "$NAME-$lang"
	echo "make_release: $NAME-$lang ($about)"
done

# --- RELEASE.txt and SHA256SUMS ------------------------------------------------

{
	if [ -n "$DIRTY" ]; then
		echo "NOT A RELEASE: built from $COMMIT with uncommitted changes"
		echo
	fi
	echo "GapKeep $VERSION"
	echo "commit $COMMIT ($(git log -1 --format=%cd --date=iso-strict))"
	echo
	echo "Images (write with Raspberry Pi Imager or balenaEtcher):"
	for lang in $LANGS; do
		case $lang in
		en)    echo "  $NAME-en.img.zip     English, US keyboard" ;;
		pt-BR) echo "  $NAME-pt-BR.img.zip  Português (Brasil), ABNT2 keyboard" ;;
		esac
	done
	echo "Or the same cards' files, to copy to a FAT32 card: $NAME-<lang>.zip"
	echo
	echo "The hashes the launcher shows (press i for the kernel's):"
	echo "  kernel  $KHASH"
	echo "          (SHA-256 of the first $HASHED bytes of kernel.img; the whole"
	echo "          file's is $KFILE)"
	echo "  apps    (python3 tools/bundle_apps.py --hash apps/<app>)"
	for a in apps/*/; do
		h=$(python3 tools/bundle_apps.py --hash "$a")
		[ "$(basename "$a")" != launcher ] || h="$h (built in)"
		echo "          $h"
	done
	echo
	echo "To check a download: sha256sum -c SHA256SUMS. To check the build:"
	echo "check out the commit, run tools/make_release.sh; the files must be"
	echo "the same, byte for byte (README.md, \"Releases\")."
} > "$OUT/RELEASE.txt"

( cd "$OUT" && sha256sum RELEASE.txt $(for l in $LANGS; do echo "$NAME-$l.img.zip $NAME-$l.zip"; done) > SHA256SUMS )
echo "make_release: in $OUT:"
( cd "$OUT" && ls -l RELEASE.txt SHA256SUMS $(for l in $LANGS; do echo "$NAME-$l.img.zip $NAME-$l.zip"; done) | awk '{print "  " $5 "\t" $9}' )
cat "$OUT/SHA256SUMS"
