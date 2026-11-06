#!/bin/sh
#
# Plays the test scenarios (tests/*.txt) on the simulator (sim/): the same
# runtime as on the Pi, natively, with a folder for the SD card. As
# tools/run_tests.sh does on QEMU: normal scenarios against the production
# app set (the launcher built in, apps/ on the card), those marked "Needs a
# test build" against the test set with tests/sdcard. Scenarios that talk to
# the serial port ("send": crash tests, memory protection) need real
# hardware or QEMU and are skipped.
#
# Usage: tools/run_sim_tests.sh [-o output-dir] [scenario.txt ...]
#
set -e
cd "$(dirname "$0")/.."
OUT=
if [ "$1" = "-o" ]; then OUT=$2; shift 2; fi
OUT=${OUT:-$(mktemp -d -t zerogap-sim-XXXXXX)}
mkdir -p "$OUT"
SCENARIOS=${*:-$(ls tests/*.txt)}
FAILED=0

make -C sim -s -j"$(nproc)" >/dev/null
make -C sim -s -j"$(nproc)" TEST=1 >/dev/null

# the production card: apps/ without the launcher (built in)
rm -rf "$OUT/card-apps"
mkdir -p "$OUT/card-apps/apps"
for a in apps/*/; do
	[ "$(basename "$a")" = launcher ] || cp -r "$a" "$OUT/card-apps/apps/"
done

for t in $SCENARIOS; do
	name=$(basename "$t" .txt)
	if grep -q "^# Rig only" "$t"; then
		echo "SKIP  sim:$name   (rig only: tools/rig/run_hw_tests.sh)"
		continue
	fi
	if grep -q "^send " "$t"; then
		echo "SKIP  sim:$name   (needs the serial port)"
		continue
	fi
	if grep -q "^camera " "$t" && [ ! -f third_party/zxing-cpp/core/src/ReadBarcode.cpp ]; then
		echo "SKIP  sim:$name   (needs the QR decoder, third_party/zxing-cpp)"
		continue
	fi
	if head -1 "$t" | grep -q "Needs a test build"; then
		sim=sim/build/zgsim-test; card=tests/sdcard
	else
		sim=sim/build/zgsim; card=$OUT/card-apps
	fi
	if python3 tools/qemu_harness.py --sim "$sim" --card "$card" --out "$OUT/$name" "$t" \
		> "$OUT/$name.log" 2>&1; then
		echo "PASS  sim:$name"
	else
		echo "FAIL  sim:$name   (see $OUT/$name.log)"
		FAILED=1
	fi
done

if [ -f "$OUT/dice39/07-words.png" ]; then
	if python3 tests/dice39/check_qr.py "$OUT/dice39" apps/dice39/vendor/wordlist.js > "$OUT/dice39_qr.log" 2>&1; then
		echo "PASS  sim:dice39_qr"
	else
		echo "FAIL  sim:dice39_qr   (see $OUT/dice39_qr.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/signer/23-descriptor.png" ]; then
	if python3 tests/signer/check_descriptor.py "$OUT/signer" > "$OUT/signer_descriptor.log" 2>&1; then
		echo "PASS  sim:signer_descriptor"
	else
		echo "FAIL  sim:signer_descriptor   (see $OUT/signer_descriptor.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/dice39_import/12-zpub.png" ]; then
	if python3 tests/dice39/check_zpub.py "$OUT/dice39_import" > "$OUT/dice39_zpub.log" 2>&1; then
		echo "PASS  sim:dice39_zpub"
	else
		echo "FAIL  sim:dice39_zpub   (see $OUT/dice39_zpub.log)"; FAILED=1
	fi
fi

# the API description (docs/api/zerogap-api.yaml) against the real runtime
if python3 tools/check_api.py sim/build/zgsim-test > "$OUT/check_api.log" 2>&1; then
	echo "PASS  sim:check_api"
else
	echo "FAIL  sim:check_api   (see $OUT/check_api.log)"; FAILED=1
fi

# apps that carry a copy of another app's library (tools/share_libs.py)
if python3 tools/share_libs.py --check > "$OUT/share_libs.log" 2>&1; then
	echo "PASS  sim:share_libs"
else
	echo "FAIL  sim:share_libs   (see $OUT/share_libs.log)"; FAILED=1
fi

echo "screenshots and logs: $OUT"
exit $FAILED
