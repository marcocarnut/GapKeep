#!/bin/sh
#
# The DigiMacro app against the real firmware: starts a fresh simulated
# DigiMacro (simavr-softusb's bridge: firmware 18 on a simulated Digispark,
# served over USB/IP) on a free port, plays tests/digimacro.txt on the
# simulator against it, then checks with check_board.py that the board
# types what the app wrote, the TOTP code included. The board is always
# stopped afterwards; another session's board (port 3240) is never touched.
#
#   tests/digimacro/run_softusb.sh [output-dir]
#
# Exit 0 on success, 1 on failure, 77 when there is no simavr-softusb
# (SOFTUSB, default ~/claude/code/simavr-softusb/harness) to run it with.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/../.."
SOFTUSB=${SOFTUSB:-$HOME/claude/code/simavr-softusb/harness}
if [ ! -f "$SOFTUSB/Makefile" ] || [ ! -x "$SOFTUSB/usbip_bridge" ]; then
	echo "run_softusb: no simavr-softusb at $SOFTUSB (SOFTUSB=...)"
	exit 77
fi
OUT=${1:-$(mktemp -d -t gapkeep-digimacro-XXXXXX)}
mkdir -p "$OUT"
STATE=$(mktemp -d -t gapkeep-dmboard-XXXXXX)		# empty: a fresh board
PORT=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')

make -C "$SOFTUSB" -s asm-bridge STATE="$STATE" PORT="$PORT" BRIDGEFLAGS="-W off -A off -q" \
	> "$OUT/board.log" 2>&1 &
stop() {
	# the bridge listening on our port, and nothing else
	pid=$(ss -ltnp 2>/dev/null | sed -n "s/.*127\.0\.0\.1:$PORT .*pid=\([0-9]*\).*/\1/p" | head -1)
	[ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
	wait 2>/dev/null || true
	rm -rf "$STATE"
}
trap stop EXIT
i=0
until ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; do
	i=$((i + 1))
	[ $i -lt 120 ] || { echo "run_softusb: the board did not come up (see $OUT/board.log)"; exit 1; }
	sleep 0.5
done

make -C sim -s -j"$(nproc)" TEST=1 >/dev/null
START=$(date +%s)
GK_TEST_USBIP=127.0.0.1:$PORT GK_TEST_PAD=$STATE/asm-pad \
	python3 tools/qemu_harness.py --sim sim/build/gksim-test --card tests/sdcard --out "$OUT/scenario" \
	tests/digimacro.txt > "$OUT/scenario.log" 2>&1 || { echo "run_softusb: the scenario failed (see $OUT/scenario.log)"; exit 1; }
python3 -I tests/digimacro/check_board.py 127.0.0.1 "$PORT" "$STATE/asm-pad" "$OUT/scenario/serial.log" "$START" \
	> "$OUT/check_board.log" 2>&1 || { echo "run_softusb: the board does not type what was written (see $OUT/check_board.log)"; exit 1; }
echo "run_softusb: the app wrote the board, and it types what it was given ($OUT)"
