#!/bin/sh
#
# Checks what tools/make_release.sh made: the SHA256SUMS; each image's
# partition, volume name, files (the same as the folder zip's, every one
# matching the card's own SHA256SUMS) and gapkeep.txt; then boots each
# image in QEMU and checks that GapKeep reads the card: the language and
# keyboard of its gapkeep.txt, every app with the hash RELEASE.txt gives,
# the launcher and the clock translated.
#
# Usage: tools/check_release.sh [DIR]     (default release/)
#
# QEMU can't run the image's kernel.img (built for the Pi): it boots a QEMU
# build of the same commit (tools/build.sh qemu, made here) with the image
# as its SD card. The image is 256 MiB, a power of two, as QEMU wants.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
DIR=${1:-$(dirname "$0")/../release}
DIR=$(cd "$DIR" && pwd)
cd "$(dirname "$0")/.."
WORK=$(mktemp -d -t gapkeep-check-release-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
export MTOOLS_SKIP_CHECK=1 TZ=UTC LC_ALL=C
SHOTS=$(mktemp -d -t gapkeep-release-shots-XXXXXX)	# kept: the screenshots
FAILED=0
fail() { echo "FAIL  $*"; FAILED=1; }

( cd "$DIR" && sha256sum -c --quiet SHA256SUMS ) && echo "PASS  SHA256SUMS" || fail "SHA256SUMS"

tools/build.sh qemu >/dev/null

for zip in "$DIR"/gapkeep-*.img.zip; do
	name=$(basename "$zip" .img.zip)
	case $name in
	*-en)    lang=en;    keyboard=us ;;
	*-pt-BR) lang=pt-BR; keyboard=br-abnt2 ;;
	*)       fail "$name: which language?"; continue ;;
	esac
	w=$WORK/$name; mkdir -p "$w"
	python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$w"
	python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$DIR/$name.zip" "$w"
	img=$w/$name.img

	# one FAT32 partition (0x0C) from 4 MiB to the end, named GAPKEEP
	python3 - "$img" <<'PY' && echo "PASS  $name: partition" || fail "$name: partition"
import os, struct, sys
b = open(sys.argv[1], 'rb').read(512)
t, start, count = b[450], *struct.unpack('<II', b[454:462])
assert b[510:] == b'\x55\xaa' and t == 0x0c and start == 8192, (t, start)
assert (start + count) * 512 == os.path.getsize(sys.argv[1])
assert b[462:510] == bytes(48)
PY
	minfo -i "$img@@4M" | grep -q 'volume label=GAPKEEP ' && echo "PASS  $name: volume GAPKEEP" ||
		fail "$name: volume label"

	# the image's files: those of the folder zip, matching the card's SHA256SUMS
	mkdir "$w/fromimage"
	mcopy -s -m -i "$img@@4M" '::/*' "$w/fromimage/"
	diff -r "$w/fromimage" "$w/$name" >/dev/null && echo "PASS  $name: image = folder zip" ||
		fail "$name: the image's files differ from $name.zip"
	( cd "$w/fromimage" && sha256sum -c --quiet SHA256SUMS ) &&
	[ "$(cd "$w/fromimage" && find . -type f ! -name SHA256SUMS | wc -l)" = "$(wc -l < "$w/fromimage/SHA256SUMS")" ] &&
		echo "PASS  $name: files ($(wc -l < "$w/fromimage/SHA256SUMS")) match the card's SHA256SUMS" ||
		fail "$name: card SHA256SUMS"
	for f in bootcode.bin start.elf fixup.dat config.txt kernel.img gapkeep.txt LICENCE.broadcom LICENCE.gapkeep; do
		[ -f "$w/fromimage/$f" ] || fail "$name: no $f"
	done
	[ ! -e "$w/fromimage/apps/launcher" ] || fail "$name: the launcher is built in, not on the card"
	grep -qx "language = $lang" "$w/fromimage/gapkeep.txt" &&
	grep -qx "keyboard = $keyboard" "$w/fromimage/gapkeep.txt" &&
		echo "PASS  $name: gapkeep.txt: language = $lang, keyboard = $keyboard" || fail "$name: gapkeep.txt"

	# boot it (a QEMU kernel, the image as the card)
	s=$w/boot.txt
	{
		echo "expect language $lang, numbers .* \\(gapkeep.txt\\) 60"
		echo "expect layout $keyboard \\(gapkeep.txt\\) 60"
		# every app on the card, with the hash RELEASE.txt gives
		for a in "$w"/fromimage/apps/*/; do
			id=$(basename "$a")
			h=$(awk -v id="$id" '$2 == id {print $1}' "$DIR/RELEASE.txt")
			[ -n "$h" ] || fail "$name: apps/$id is not in RELEASE.txt"
			echo "expect apps/$id: $id .* sha256 $h 60"
		done
		echo "expect Keyboard attached \\(layout $keyboard\\) 60"
		echo "expect launcher ready 60"
		echo "expect sd card: ok 0 problem 10"
		[ $lang = en ] || echo "expect launcher lang/$lang.json: \\d+ translations, 0 ignored 10"
		echo "wait 2"
		echo "shot launcher"
		echo "key i"
		echo "wait 1"
		echo "shot system-info"
		echo "key ret"
		echo "tile clock"
		echo "expect clock ready 30"
		[ $lang = en ] || echo "expect clock lang/$lang.json: \\d+ translations, 0 ignored 10"
		echo "wait 1"
		echo "shot clock"
	} > "$s"
	out=$SHOTS/$name
	if python3 tools/qemu_harness.py --sd "$img" --out "$out" "$s" > "$w/qemu.log" 2>&1; then
		echo "PASS  $name: boots in QEMU (screenshots in $out)"
	else
		fail "$name: QEMU ($out)"; tail -5 "$w/qemu.log"
	fi
done
exit $FAILED
