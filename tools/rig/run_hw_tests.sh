#!/bin/sh
#
# Runs the QEMU scenarios (tests/*.txt) on the real Pi Zero through the rig
# (docs/RIG.md): builds a test kernel for the Pi, copies it and the rig tools
# to the rig, plays each scenario there and fetches screenshots and logs.
# Hardware runs always use a test build: screenshots come over the serial
# line, which production builds never read.
#
# Usage: tools/rig/run_hw_tests.sh [--rig user@host] [-o output-dir] [scenario.txt ...]
#        (default: every scenario). The rig's Linux host, as ssh reaches
#        it, is required: --rig, or $GK_RIG.
#
# Scenarios that need the test SD card (tests/sdcard: "Needs ... the test SD
# card") are skipped unless GK_RIG_SDAPPS=1 says the rig's card has its
# apps/ folder (tools/make_sdcard.sh puts it on the development card).
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/../.."
RIG=$GK_RIG
OUT=
while :; do
	case "$1" in
		--rig) RIG=$2; shift 2 ;;
		-o)    OUT=$2; shift 2 ;;
		*)     break ;;
	esac
done
if [ -z "$RIG" ]; then
	echo "run_hw_tests: which rig? Give its Linux host as ssh reaches it:" >&2
	echo "  GK_RIG=user@host $0 ...   or   $0 --rig user@host ...   (docs/RIG.md)" >&2
	exit 2
fi
OUT=${OUT:-$(mktemp -d -t gapkeep-hw-XXXXXX)}
mkdir -p "$OUT"
SCENARIOS=${*:-$(ls tests/*.txt)}

tools/build.sh pi TEST=1
make -C src -s kernel.hex TEST=1 >/dev/null
ssh "$RIG" 'mkdir -p gapkeep-rig/tests'
scp -q src/kernel.hex tools/rig/gkrig.py tools/rig/gadget.sh tools/serialshot.py \
	tools/qemu_harness.py "$RIG:gapkeep-rig/"
scp -q $SCENARIOS "$RIG:gapkeep-rig/tests/"

FAILED=0
for t in $SCENARIOS; do
	name=$(basename "$t" .txt)
	if head -2 "$t" | grep -q "the test SD card" && [ "$GK_RIG_SDAPPS" != 1 ]; then
		echo "SKIP  hw:$name   (set GK_RIG_SDAPPS=1 once the rig's card has tests/sdcard/apps)"
		continue
	fi
	if grep -q "^launch " "$t"; then
		echo "SKIP  hw:$name   (simulator only)"
		continue
	fi
	# the rig can't pull its card out, and runs test kernels only
	if grep -q "^eject" "$t" || head -1 "$t" | grep -q "Needs a sealed build"; then
		echo "SKIP  hw:$name   (QEMU and the simulator: tools/run_tests.sh)"
		continue
	fi
	if grep -q "^camera " "$t" && [ ! -f third_party/zxing-cpp/core/src/ReadBarcode.cpp ]; then
		echo "SKIP  hw:$name   (needs the QR decoder, third_party/zxing-cpp)"
		continue
	fi
	if ssh "$RIG" "cd gapkeep-rig && rm -rf out/$name && python3 -u gkrig.py run kernel.hex tests/$name.txt --out out/$name" \
		> "$OUT/$name.log" 2>&1; then
		echo "PASS  hw:$name"
	else
		echo "FAIL  hw:$name   (see $OUT/$name.log)"
		FAILED=1
	fi
	rm -rf "$OUT/$name"
	scp -qr "$RIG:gapkeep-rig/out/$name" "$OUT/$name" 2>/dev/null || true
done

# dice39's three QR exports, decoded from the hardware's screenshots
if [ -f "$OUT/dice39/07-words.png" ]; then
	if python3 tests/dice39/check_qr.py "$OUT/dice39" apps/dice39/vendor/wordlist.js \
		> "$OUT/dice39_qr.log" 2>&1; then
		echo "PASS  hw:dice39_qr"
	else
		echo "FAIL  hw:dice39_qr   (see $OUT/dice39_qr.log)"; FAILED=1
	fi
fi

echo "screenshots and logs: $OUT"
exit $FAILED
