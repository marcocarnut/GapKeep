#!/bin/sh
#
# Runs every QEMU scenario in tests/. Normal scenarios run against the
# production app set; tests/crash.txt needs the test-only apps (make TEST=1).
# Leaves a production kernel.img behind.
#
# Usage: tools/run_tests.sh [output-dir]
#
set -e
cd "$(dirname "$0")/.."
OUT=${1:-$(mktemp -d -t zerogap-tests-XXXXXX)}
mkdir -p "$OUT"
FAILED=0

run() {
	name=$(basename "$1" .txt)
	if python3 tools/qemu_harness.py --out "$OUT/$name" "$1" > "$OUT/$name.log" 2>&1; then
		echo "PASS  $name"
	else
		echo "FAIL  $name   (see $OUT/$name.log)"
		FAILED=1
	fi
}

make -C src -s -j"$(nproc)" >/dev/null
for t in tests/*.txt; do
	[ "$t" = tests/crash.txt ] || run "$t"
done

make -C src -s -j"$(nproc)" TEST=1 >/dev/null
run tests/crash.txt

make -C src -s -j"$(nproc)" >/dev/null	# back to the production app set

echo "screenshots and logs: $OUT"
exit $FAILED
