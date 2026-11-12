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
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/.."
OUT=
if [ "$1" = "-o" ]; then OUT=$2; shift 2; fi
OUT=${OUT:-$(mktemp -d -t gapkeep-sim-XXXXXX)}
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
	if head -1 "$t" | grep -q "Needs a sealed build"; then
		echo "SKIP  sim:$name   (a sealed kernel: tools/run_tests.sh)"
		continue
	fi
	if grep -q "^# Rig only" "$t"; then
		echo "SKIP  sim:$name   (rig only: tools/rig/run_hw_tests.sh)"
		continue
	fi
	if grep -q "^send " "$t"; then
		echo "SKIP  sim:$name   (needs the serial port)"
		continue
	fi
	if grep -q "^monitor \|^# QEMU only" "$t"; then
		echo "SKIP  sim:$name   (QEMU only: tools/run_tests.sh)"
		continue
	fi
	if grep -q "^camera " "$t" && [ ! -f third_party/zxing-cpp/core/src/ReadBarcode.cpp ]; then
		echo "SKIP  sim:$name   (needs the QR decoder, third_party/zxing-cpp)"
		continue
	fi
	# "# Needs USB/IP": a device served at GK_TEST_USBIP (default
	# 127.0.0.1:3241), or the scenario is skipped
	if grep -q "^# Needs USB/IP" "$t"; then
		server=${GK_TEST_USBIP:-127.0.0.1:3241}
		if ! python3 -I -c 'import socket, sys; h, p = sys.argv[1].rsplit(":", 1); socket.create_connection((h.strip("[]"), int(p)), 1).close()' "$server" 2>/dev/null; then
			echo "SKIP  sim:$name   (no USB/IP server at $server: GK_TEST_USBIP=host:port)"
			continue
		fi
	fi
	if head -1 "$t" | grep -q "Needs a test build"; then
		sim=sim/build/gksim-test; card=tests/sdcard
	else
		sim=sim/build/gksim; card=$OUT/card-apps
	fi
	# "# Built with: EPAPER=... ...": a simulator built with that panel of its
	# own, as a sealed kernel's (sim/Makefile)
	built=$(sed -n 's/^# Built with: //p' "$t")
	if [ -n "$built" ]; then
		# shellcheck disable=SC2086
		make -C sim -s -j"$(nproc)" TEST=1 $built >/dev/null
		sim=sim/build/gksim-test-epaper
	fi
	# "# Card: empty": an SD card without apps (a screen that depends on nothing else)
	if grep -q "^# Card: empty" "$t"; then
		card=$OUT/card-empty; mkdir -p "$card"
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

if [ -f "$OUT/epaper/04-panel1-rewritten.png" ]; then
	if python3 tests/epaper/check_panel.py "$OUT/epaper" > "$OUT/epaper_panel.log" 2>&1; then
		echo "PASS  sim:epaper_panel"
	else
		echo "FAIL  sim:epaper_panel   (see $OUT/epaper_panel.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/epaper_shares/codex32-seedqr.png" ]; then
	if python3 tests/epaper/check_shares.py "$OUT/epaper_shares" > "$OUT/epaper_shares_check.log" 2>&1; then
		echo "PASS  sim:epaper_shares_check"
	else
		echo "FAIL  sim:epaper_shares_check   (see $OUT/epaper_shares_check.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/epaper_rotate/r270-u.png" ]; then
	if python3 tests/epaper/check_rotation.py "$OUT/epaper_rotate" > "$OUT/epaper_rotation.log" 2>&1; then
		echo "PASS  sim:epaper_rotation"
	else
		echo "FAIL  sim:epaper_rotation   (see $OUT/epaper_rotation.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/signer/23-descriptor.png" ]; then
	if python3 tests/signer/check_descriptor.py "$OUT/signer" > "$OUT/signer_descriptor.log" 2>&1; then
		echo "PASS  sim:signer_descriptor"
	else
		echo "FAIL  sim:signer_descriptor   (see $OUT/signer_descriptor.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/signer/30-part-00.png" ]; then
	if node --experimental-default-type=module tests/signer/check_bbqr.mjs "$OUT/signer" > "$OUT/signer_bbqr.log" 2>&1; then
		echo "PASS  sim:signer_bbqr"
	else
		echo "FAIL  sim:signer_bbqr   (see $OUT/signer_bbqr.log)"; FAILED=1
	fi
fi

if [ -f "$OUT/dice39_import/12-zpub.png" ]; then
	if python3 tests/dice39/check_zpub.py "$OUT/dice39_import" > "$OUT/dice39_zpub.log" 2>&1; then
		echo "PASS  sim:dice39_zpub"
	else
		echo "FAIL  sim:dice39_zpub   (see $OUT/dice39_zpub.log)"; FAILED=1
	fi
fi

# the launcher in the pseudo-language, as recorded (tests/i18n/check_shot.py)
if [ -f "$OUT/i18n_qps/launcher-qps.png" ]; then
	if python3 tests/i18n/check_shot.py tests/i18n/launcher-qps.png "$OUT/i18n_qps/launcher-qps.png" \
		> "$OUT/i18n_qps_shot.log" 2>&1; then
		echo "PASS  sim:i18n_qps_shot"
	else
		echo "FAIL  sim:i18n_qps_shot   (see $OUT/i18n_qps_shot.log)"; FAILED=1
	fi
fi

# every app's translations (tools/i18n.py; glossary warnings are shown, and
# don't fail), and the tool on the test app's
for a in apps/*/; do
	[ -d "$a/lang" ] || continue
	name=i18n_$(basename "$a")
	if python3 tools/i18n.py check "$a" > "$OUT/$name.log" 2>&1; then
		echo "PASS  sim:$name"
		# the glossary's words to avoid: for the reviewer, not failures
		grep "warning:" "$OUT/$name.log" | sed 's/^/      /' || true
	else
		echo "FAIL  sim:$name   (see $OUT/$name.log)"; FAILED=1
	fi
done
if python3 tests/i18n/check_tool.py > "$OUT/i18n_tool.log" 2>&1; then
	echo "PASS  sim:i18n_tool"
else
	echo "FAIL  sim:i18n_tool   (see $OUT/i18n_tool.log)"; FAILED=1
fi

# the API description (docs/api/gapkeep-api.yaml) against the real runtime
if python3 tools/check_api.py sim/build/gksim-test > "$OUT/check_api.log" 2>&1; then
	echo "PASS  sim:check_api"
else
	echo "FAIL  sim:check_api   (see $OUT/check_api.log)"; FAILED=1
fi

# the wipes of secrets survive the compiler (src/crypto/wipe.h)
if tests/native/check_wipes.sh "$OUT/wipes" > "$OUT/wipes.log" 2>&1; then
	echo "PASS  sim:wipes"
else
	echo "FAIL  sim:wipes   (see $OUT/wipes.log)"; FAILED=1
fi

# OpenPGP signatures made with gk:crypto, checked by GnuPG (if it is here)
if command -v gpg >/dev/null; then
	if tests/pgp/run_gpg_interop.sh "$OUT/gpg_interop" > "$OUT/gpg_interop.log" 2>&1; then
		echo "PASS  sim:gpg_interop"
	else
		echo "FAIL  sim:gpg_interop   (see $OUT/gpg_interop.log)"; FAILED=1
	fi
else
	echo "SKIP  sim:gpg_interop   (no gpg)"
fi

# apps that carry a copy of another app's library (tools/share_libs.py)
if python3 tools/share_libs.py --check > "$OUT/share_libs.log" 2>&1; then
	echo "PASS  sim:share_libs"
else
	echo "FAIL  sim:share_libs   (see $OUT/share_libs.log)"; FAILED=1
fi

# the USB mouse's report descriptor parser (Circle, patches/circle/0009):
# its fixed cases and a short fuzz run (tools/fuzz_usbmouse.sh for long ones)
if [ -f circle/Rules.mk ]; then
	if tools/fuzz_usbmouse.sh 20000 > "$OUT/fuzz_usbmouse.log" 2>&1; then
		echo "PASS  sim:fuzz_usbmouse"
	else
		echo "FAIL  sim:fuzz_usbmouse   (see $OUT/fuzz_usbmouse.log)"; FAILED=1
	fi
fi

# gk:zlib's decompression (zlib's inflate): seeds, then a short fuzz run
# (tools/fuzz_inflate.sh for long ones)
if tools/fuzz_inflate.sh 20000 > "$OUT/fuzz_inflate.log" 2>&1; then
	echo "PASS  sim:fuzz_inflate"
else
	echo "FAIL  sim:fuzz_inflate   (see $OUT/fuzz_inflate.log)"; FAILED=1
fi

# gk:usb's descriptor parsers (src/runtime/usbdesc.c): fixed cases and a
# short fuzz run (tools/fuzz_usbdesc.sh for long ones)
if tools/fuzz_usbdesc.sh 20000 > "$OUT/fuzz_usbdesc.log" 2>&1; then
	echo "PASS  sim:fuzz_usbdesc"
else
	echo "FAIL  sim:fuzz_usbdesc   (see $OUT/fuzz_usbdesc.log)"; FAILED=1
fi

# libraries outside apps (lib/js), under Node
if command -v node >/dev/null; then
	if node --experimental-default-type=module tests/i18n/run_node.mjs > "$OUT/i18n_node.log" 2>&1; then
		echo "PASS  sim:i18n_node"
	else
		echo "FAIL  sim:i18n_node   (see $OUT/i18n_node.log)"; FAILED=1
	fi
	# the browser IDE's keyboard (sim/web/textinput.js; end to end with
	# sim/build/web/gksim-test.js if it was built)
	if node --experimental-default-type=module tests/web/textinput.mjs > "$OUT/web_textinput.log" 2>&1; then
		echo "PASS  sim:web_textinput"
	else
		echo "FAIL  sim:web_textinput   (see $OUT/web_textinput.log)"; FAILED=1
	fi
	# gk:crypto's long operations in the WebAssembly build (if it was built)
	if node --experimental-default-type=module tests/web/pgpcrypto.mjs > "$OUT/web_pgpcrypto.log" 2>&1; then
		echo "PASS  sim:web_pgpcrypto"
	else
		echo "FAIL  sim:web_pgpcrypto   (see $OUT/web_pgpcrypto.log)"; FAILED=1
	fi
	# the e-paper panel in the WebAssembly build, as the IDE shows it (if it was built)
	if node --experimental-default-type=module tests/web/epaper.mjs > "$OUT/web_epaper.log" 2>&1; then
		echo "PASS  sim:web_epaper"
	else
		echo "FAIL  sim:web_epaper   (see $OUT/web_epaper.log)"; FAILED=1
	fi
	if node --experimental-default-type=module tests/bbqr/run_node.mjs > "$OUT/bbqr.log" 2>&1 \
		&& python3 tests/bbqr/check_capacity.py >> "$OUT/bbqr.log" 2>&1; then
		echo "PASS  sim:bbqr"
	else
		echo "FAIL  sim:bbqr   (see $OUT/bbqr.log)"; FAILED=1
	fi
	if node --experimental-default-type=module tests/btc/run_node.mjs > "$OUT/btc.log" 2>&1; then
		echo "PASS  sim:btc"
	else
		echo "FAIL  sim:btc   (see $OUT/btc.log)"; FAILED=1
	fi
	# dice39's and codex32's e-paper pages, for every panel (apps/dice39/lib/epaperlayout.js)
	if node tests/epaper/layout_node.mjs > "$OUT/epaper_layout.log" 2>&1; then
		echo "PASS  sim:epaper_layout"
	else
		echo "FAIL  sim:epaper_layout   (see $OUT/epaper_layout.log)"; FAILED=1
	fi
	# Sneakernet's levels and codes, and the levels tests/sneakernet.txt plays
	if node --experimental-default-type=module tests/sneakernet/run_node.mjs > "$OUT/sneakernet_node.log" 2>&1; then
		echo "PASS  sim:sneakernet_node"
	else
		echo "FAIL  sim:sneakernet_node   (see $OUT/sneakernet_node.log)"; FAILED=1
	fi
else
	echo "SKIP  sim:bbqr   (needs Node)"
fi

echo "screenshots and logs: $OUT"
exit $FAILED
