#!/bin/sh
#
# Makes an SD card image for QEMU (qemu_harness.py --sd): an MBR with one
# FAT32 partition from 1 MiB on, like a real card, holding a copy of a
# directory's contents (e.g. a folder with apps/ in it).
#
# Usage: tools/make_sd_image.sh <image> [<dir>]     (needs mtools, dosfstools)
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
IMG=$1; DIR=$2
[ -n "$IMG" ] || { echo "usage: $0 <image> [<dir>]" >&2; exit 2; }
SIZE_MB=64	# QEMU wants a power of two
rm -f "$IMG"
truncate -s ${SIZE_MB}M "$IMG"
# MBR: partition 1, type 0x0C (FAT32 LBA), from sector 2048 to the end
python3 - "$IMG" $SIZE_MB <<'PY'
import struct, sys
img, mb = sys.argv[1], int(sys.argv[2])
start, count = 2048, mb * 2048 - 2048
entry = struct.pack('<B3sB3sII', 0, b'\xfe\xff\xff', 0x0c, b'\xfe\xff\xff', start, count)
with open(img, 'r+b') as f:
    f.seek(446); f.write(entry)
    f.seek(510); f.write(b'\x55\xaa')
PY
mkfs.vfat -F 32 --offset 2048 -n GAPKEEP "$IMG" $(( (SIZE_MB - 1) * 1024 )) >/dev/null
if [ -n "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
	MTOOLS_SKIP_CHECK=1 mcopy -s -Q -i "$IMG@@1M" "$DIR"/* ::/
fi
