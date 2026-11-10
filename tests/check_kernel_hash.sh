#!/bin/sh
#
# The launcher logs the hash the running kernel computed of its own image
# ("kernel: <build> <bytes> <sha256>"). It must cover the whole of
# kernel.img, and equal its SHA-256: what the System dialog tells people to
# check (sha256sum kernel.img). Every kind of build: tools/run_tests.sh
# checks a production, a test and a sealed one.
#
# Usage: tests/check_kernel_hash.sh <serial.log> <kernel.img>
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
line=$(grep -a "app:launcher: kernel:" "$1" | head -1)
bytes=$(echo "$line" | awk '{print $5}')
logged=$(echo "$line" | awk '{print $6}')
size=$(wc -c < "$2")
actual=$(sha256sum < "$2" | cut -d' ' -f1)
echo "logged: $logged ($bytes bytes)"
echo "actual: $actual ($size bytes)"
[ -n "$logged" ] && [ "$bytes" = "$size" ] && [ "$logged" = "$actual" ]
