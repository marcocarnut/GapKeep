#!/bin/sh
#
# gk:crypto's OpenPGP primitives against GnuPG: makes two disposable keys
# (Ed25519 and RSA-3072, protected by a passphrase) in a throwaway
# GNUPGHOME, exports the secret keys as GnuPG does (S2K type 3, AES-CFB,
# SHA-1 check), and runs tests/pgp/pgpinterop in the simulator, which
# unlocks them and signs a file. gpg --verify must accept every signature;
# a wrong passphrase must not unlock.
#
# Usage: tests/pgp/run_gpg_interop.sh [work-dir]    (needs gpg; exit 0: pass)
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
cd "$(dirname "$0")/../.."
command -v gpg >/dev/null || { echo "run_gpg_interop: no gpg"; exit 2; }
WORK=${1:-$(mktemp -d -t gapkeep-gpg-XXXXXX)}
mkdir -p "$WORK"
GNUPGHOME="$WORK/gnupg"
export GNUPGHOME
rm -rf "$GNUPGHOME" "$WORK/pgp-interop"
mkdir -m 700 "$GNUPGHOME"
mkdir "$WORK/pgp-interop"
PASS="correct horse $$"
G="gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0"

echo "$PASS" | $G --quick-gen-key "GapKeep test Ed25519 <ed@example.invalid>" ed25519 sign never 2>/dev/null
echo "$PASS" | $G --quick-gen-key "GapKeep test RSA <rsa@example.invalid>" rsa3072 sign never 2>/dev/null
echo "$PASS" | $G --export-secret-keys "ed@example.invalid" > "$WORK/pgp-interop/ed.key"
echo "$PASS" | $G --export-secret-keys "rsa@example.invalid" > "$WORK/pgp-interop/rsa.key"
echo "$PASS" > "$WORK/pgp-interop/passphrase.txt"
# a creation time after the keys' (the simulator's clock may not be set)
echo $(( $(date +%s) + 1 )) > "$WORK/pgp-interop/time.txt"
head -c 100000 /dev/urandom > "$WORK/pgp-interop/message.bin"
sleep 1

make -C sim -s -j"$(nproc)" >/dev/null
tools/gksim --for 30 --data "$WORK/pgp-interop" tests/pgp/pgpinterop > "$WORK/sim.log" 2>&1 || true
grep "pgpinterop:" "$WORK/sim.log" | grep -v "signature " || true

FAIL=0
grep -q "pgpinterop: done" "$WORK/sim.log" || { echo "FAIL: the app did not finish"; FAIL=1; }
for name in ed rsa; do
	for what in "wrong passphrase refused" "secret key decrypted, SHA-1 check passed" "public key matches"; do
		grep -q "pgpinterop: $name: .*$what" "$WORK/sim.log" || { echo "FAIL: $name: $what"; FAIL=1; }
	done
done
N=0
for sig in ed-SHA-256 ed-SHA-512 rsa-SHA-256 rsa-SHA-512; do
	hex=$(sed -n "s/.*pgpinterop: signature $sig \([0-9a-f]*\).*/\1/p" "$WORK/sim.log")
	if [ -z "$hex" ]; then echo "FAIL: no signature $sig"; FAIL=1; continue; fi
	echo "$hex" | python3 -I -c 'import sys; sys.stdout.buffer.write(bytes.fromhex(sys.stdin.read().strip()))' \
		> "$WORK/$sig.sig"
	if gpg --batch --status-fd 1 --verify "$WORK/$sig.sig" "$WORK/pgp-interop/message.bin" \
		> "$WORK/$sig.verify" 2>&1 && grep -q "^\[GNUPG:\] GOODSIG" "$WORK/$sig.verify"; then
		echo "gpg --verify $sig: good signature"
		N=$((N + 1))
	else
		echo "FAIL: gpg --verify $sig:"; cat "$WORK/$sig.verify"; FAIL=1
	fi
done
# and a corrupted file must not verify
printf x >> "$WORK/pgp-interop/message.bin"
if gpg --batch --verify "$WORK/ed-SHA-256.sig" "$WORK/pgp-interop/message.bin" >/dev/null 2>&1; then
	echo "FAIL: a changed file verified"; FAIL=1
fi
echo "run_gpg_interop: $N of 4 signatures verified by $(gpg --version | head -1)"
exit $FAIL
