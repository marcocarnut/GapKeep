#!/bin/sh
#
# Runs every QEMU scenario in tests/, plus the native and Node tests.
# Normal scenarios run against a production kernel (only the launcher built
# in) with apps/ on its SD card, as tools/make_sdcard.sh --standalone makes
# it; those marked "Needs a test build" against a test build (every app
# built in, test-only apps too) with the test SD card (tests/sdcard).
# Leaves a production kernel.img behind.
#
# Usage: tools/run_tests.sh [output-dir]
#
set -e
cd "$(dirname "$0")/.."
OUT=${1:-$(mktemp -d -t zerogap-tests-XXXXXX)}
mkdir -p "$OUT"
FAILED=0

run() {	# scenario, SD card image
	name=$(basename "$1" .txt)
	# a real camera, sensors, ...: tests/picamera.txt says "# Rig only"
	if grep -q "^# Rig only" "$1"; then
		echo "SKIP  $name   (rig only: tools/rig/run_hw_tests.sh)"
		return
	fi
	if grep -q "^launch " "$1"; then
		echo "SKIP  $name   (simulator only: tools/run_sim_tests.sh)"
		return
	fi
	if grep -q "^camera " "$1" && [ ! -f third_party/zxing-cpp/core/src/ReadBarcode.cpp ]; then
		echo "SKIP  $name   (needs the QR decoder, third_party/zxing-cpp)"
		return
	fi
	if python3 tools/qemu_harness.py --sd "$2" --out "$OUT/$name" "$1" > "$OUT/$name.log" 2>&1; then
		echo "PASS  $name"
	else
		echo "FAIL  $name   (see $OUT/$name.log)"
		FAILED=1
	fi
}

# scenarios whose first line says "Needs a test build" run against make TEST=1
needs_test_build() { head -1 "$1" | grep -q "Needs a test build"; }

check() {	# name, command...
	name=$1; shift
	if "$@" > "$OUT/$name.log" 2>&1; then echo "PASS  $name"; else echo "FAIL  $name   (see $OUT/$name.log)"; FAILED=1; fi
}
check native_sha256 sh -c 'cc -O2 -I src/crypto tests/native/test_sha256.c src/crypto/sha256.c -o "$0/sha256test" && "$0/sha256test"' "$OUT"
check native_hmac python3 tools/check_hashes.py
check native_secp python3 tools/check_secp.py
check secp256k1_suite python3 tools/check_secp.py --suite 2
check dice39_node node tests/dice39/run_node.mjs
check totp_node node --experimental-default-type=module tests/totp/run_node.mjs
check codex32_node node --experimental-default-type=module tests/codex32/run_node.mjs
check psbt_node node --experimental-default-type=module tests/psbt/run_node.mjs
check signer_node node --experimental-default-type=module tests/signer/run_node.mjs

# the two SD cards
mkdir -p "$OUT/card-apps/apps"
for a in apps/*/; do
	[ "$(basename "$a")" = launcher ] || cp -r "$a" "$OUT/card-apps/apps/"
done
tools/make_sd_image.sh "$OUT/sd-apps.img" "$OUT/card-apps"
tools/make_sd_image.sh "$OUT/sd-test.img" tests/sdcard

tools/build.sh qemu >/dev/null
for t in tests/*.txt; do
	needs_test_build "$t" || run "$t" "$OUT/sd-apps.img"
done

# the kernel hash the launcher shows must be that of kernel.img
if [ -f "$OUT/boot_launcher/serial.log" ]; then
	check kernel_hash tests/check_kernel_hash.sh "$OUT/boot_launcher/serial.log" src/kernel.img
fi

# dice39's three QR exports, decoded from the screenshots, must agree
if [ -f "$OUT/dice39/07-words.png" ]; then
	check dice39_qr python3 tests/dice39/check_qr.py "$OUT/dice39" apps/dice39/vendor/wordlist.js
fi

tools/build.sh qemu TEST=1 >/dev/null
for t in tests/*.txt; do
	! needs_test_build "$t" || run "$t" "$OUT/sd-test.img"
done

# the public keys the Signer shows, decoded from the screenshots
if [ -f "$OUT/signer/23-descriptor.png" ]; then
	check signer_descriptor python3 tests/signer/check_descriptor.py "$OUT/signer"
fi
if [ -f "$OUT/signer/30-part-00.png" ]; then
	check signer_bbqr node --experimental-default-type=module tests/signer/check_bbqr.mjs "$OUT/signer"
fi

tools/build.sh qemu >/dev/null	# back to the production app set

echo "screenshots and logs: $OUT"
exit $FAILED
