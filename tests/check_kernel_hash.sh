#!/bin/sh
#
# The launcher logs the hash the running kernel computed of its own code and
# constants ("kernel: <build> <bytes> <sha256>"). It must equal the SHA-256
# of that many bytes at the start of kernel.img: what the System dialog tells
# people to check.
#
# Usage: tests/check_kernel_hash.sh <serial.log> <kernel.img>
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
line=$(grep -a "app:launcher: kernel:" "$1" | head -1)
bytes=$(echo "$line" | awk '{print $5}')
logged=$(echo "$line" | awk '{print $6}')
actual=$(head -c "$bytes" "$2" | sha256sum | cut -d' ' -f1)
echo "logged: $logged ($bytes bytes)"
echo "actual: $actual"
[ -n "$logged" ] && [ "$logged" = "$actual" ]
