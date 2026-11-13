#!/bin/sh
#
# The wipes of secrets must survive the compiler. A memset() of a buffer
# that is not read again is a dead store, and GCC removes it at -O2 unless
# the build happens to say -ffreestanding (the kernel's does, the
# simulator's and other builds don't). So every wipe goes through
# gk_wipe() (src/crypto/wipe.h), out of line in its own file. This compiles
# the crypto sources at -O2 without -ffreestanding, as the ARM1176 kernel
# would be (with the pinned compiler if it is there, else this machine's),
# and checks that each gk_wipe() call in a file is still a call in its
# assembly; and, first, that this compiler does remove a dead memset, so
# the check would see one.
#
# Usage: tests/native/check_wipes.sh [work-dir]
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/../.."
OUT=${1:-$(mktemp -d -t gapkeep-wipes-XXXXXX)}
mkdir -p "$OUT"

if [ -x toolchain/arm-none-eabi/bin/arm-none-eabi-gcc ]; then
	CC="toolchain/arm-none-eabi/bin/arm-none-eabi-gcc -mcpu=arm1176jzf-s -marm -mfloat-abi=hard -mfpu=vfp"
elif command -v arm-none-eabi-gcc >/dev/null; then
	CC="arm-none-eabi-gcc -mcpu=arm1176jzf-s -marm -mfloat-abi=hard -mfpu=vfp"
else
	CC=cc
fi
CFLAGS="-O2 -fstack-protector-strong -std=gnu99"
SECP=third_party/secp256k1
INC="-I src/crypto -I $SECP/include -I lib/mbedtls -I third_party/mbedtls/include -I third_party/monocypher/src"
INC="$INC -I third_party/monocypher/src/optional -DMBEDTLS_CONFIG_FILE=\"gk_mbedtls_config.h\""
CALL='^[[:space:]]*(bl|b|call|jmp)[[:space:]]+gk_wipe'
FAILED=0

# the compiler drops a dead memset here, and keeps gk_wipe()
cat > "$OUT/probe.c" <<'EOF'
#include <string.h>
#include "wipe.h"
void use (unsigned char *p);
void with_memset (void) { unsigned char k[256]; use (k); memset (k, 0, sizeof k); }
void with_wipe (void) { unsigned char k[256]; use (k); gk_wipe (k, sizeof k); }
EOF
$CC $CFLAGS $INC -S -o "$OUT/probe.s" "$OUT/probe.c"
# (256 bytes: a memset kept would be a call)
memsets=$(awk '/^with_memset:/,/\.size[[:space:]]+with_memset/' "$OUT/probe.s" | grep -Ec '^[[:space:]]*(bl|b|call|jmp)[[:space:]]+memset' || true)
wipes=$(grep -Ec "$CALL" "$OUT/probe.s" || true)
if [ "$memsets" -ne 0 ] || [ "$wipes" -ne 1 ]; then
	echo "probe: the compiler kept a dead memset ($memsets) or lost gk_wipe ($wipes calls):"
	echo "       this check can't tell (see $OUT/probe.s)"
	FAILED=1
else
	echo "probe: $CC drops a dead memset and keeps gk_wipe()"
fi

for f in src/crypto/*.c; do
	case $f in */wipe.c) continue ;; esac
	s=$OUT/$(basename "$f" .c).s
	$CC $CFLAGS $INC -S -o "$s" "$f"
	want=$(grep -c 'gk_wipe (' "$f" || true)
	got=$(grep -Ec "$CALL" "$s" || true)
	if [ "$got" -lt "$want" ]; then
		echo "FAIL $f: $want gk_wipe() calls in the source, $got in the assembly ($s)"
		FAILED=1
	else
		echo "ok   $f: $want gk_wipe() calls, $got in the assembly"
	fi
	# no wipe by hand: a "volatile" loop is the old way (and only as good
	# as its author); memset of a secret is the bug this check is about
	if grep -n 'volatile' "$f" | grep -v '__asm__' >/dev/null; then
		echo "FAIL $f: a volatile wipe by hand: use gk_wipe()"
		FAILED=1
	fi
done

exit $FAILED
