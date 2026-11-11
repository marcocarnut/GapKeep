#!/bin/sh
#
# gk:crypto's OpenPGP primitives against GnuPG, in a throwaway GNUPGHOME:
#
# - signing: two disposable keys (Ed25519 and RSA-3072, protected by a
#   passphrase) exported as GnuPG does (S2K type 3, AES-CFB, SHA-1 check);
#   tests/pgp/pgpinterop, in the simulator, unlocks them and signs a file;
#   gpg --verify must accept every signature, and refuse a changed file;
# - decryption: each key gets an encryption subkey (Cv25519, RSA-3072);
#   gpg --encrypt to each; the app finds its PKESK, recovers the session
#   key (RSA: RsaPrivateKey.decrypt; Cv25519: X25519, RFC 6637's KDF in
#   JavaScript, aesKeyUnwrap) and decrypts the SEIPD v1 packet
#   (seipdV1Decrypt): the literal data must be the file; a changed byte in
#   the ciphertext or the MDC must be refused.
#
# GnuPG 2.4 encrypts with OCB (its "AEAD encrypted data", tag 20) to keys
# that announce AEAD, as its own new keys do: the keys' preferences are set
# without it, so it writes SEIPD v1 with an MDC (tag 18). One message is
# uncompressed (-z 0); one is compressed (the default), which the app
# decrypts and recognises (decompression is not there yet).
#
# No prompt can ever reach the desktop: the agent may only use loopback
# (gpg-agent.conf: pinentry-program /bin/false), every call that needs a
# secret key gets the passphrase from a file, and the agent is killed on
# exit.
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
WORK=$(cd "$WORK" && pwd)
GNUPGHOME="$WORK/gnupg"
export GNUPGHOME
rm -rf "$GNUPGHOME" "$WORK/pgp-interop"
mkdir -m 700 "$GNUPGHOME"
printf 'allow-loopback-pinentry\npinentry-program /bin/false\n' > "$GNUPGHOME/gpg-agent.conf"
trap 'gpgconf --homedir "$GNUPGHOME" --kill gpg-agent >/dev/null 2>&1 || true' EXIT INT TERM
mkdir "$WORK/pgp-interop"
D="$WORK/pgp-interop"
PASS="correct horse $$"
( umask 077; printf '%s\n' "$PASS" > "$WORK/passphrase" )
G="gpg --batch --quiet --pinentry-mode loopback --passphrase-file $WORK/passphrase --trust-model always"

$G --quick-gen-key "GapKeep test Ed25519 <ed@example.invalid>" ed25519 sign never 2>/dev/null
$G --quick-gen-key "GapKeep test RSA <rsa@example.invalid>" rsa3072 sign never 2>/dev/null
for k in ed rsa; do
	fpr=$(gpg --batch --with-colons --list-keys "$k@example.invalid" | awk -F: '/^fpr/ { print $10; exit }')
	algo=cv25519; [ $k = rsa ] && algo=rsa3072
	$G --quick-add-key "$fpr" $algo encr never 2>/dev/null
	printf 'setpref AES256 AES192 AES SHA512 SHA384 SHA256 SHA224 ZLIB BZIP2 ZIP\ny\nsave\n' |
		$G --command-fd 0 --edit-key "$fpr" >/dev/null 2>&1
	$G --export-secret-keys "$k@example.invalid" > "$D/$k.key"
done
cp "$WORK/passphrase" "$D/passphrase.txt"
# a creation time after the keys' (the simulator's clock may not be set)
echo $(( $(date +%s) + 1 )) > "$D/time.txt"
head -c 100000 /dev/urandom > "$D/message.bin"
head -c 70000 /dev/urandom > "$D/secret.bin"
# encrypted: uncompressed to both keys, compressed to the RSA key
$G -z 0 -r ed@example.invalid -o "$D/ed.msg" -e "$D/secret.bin"
$G -z 0 -r rsa@example.invalid -o "$D/rsa.msg" -e "$D/secret.bin"
$G -r rsa@example.invalid -o "$D/rsa-z.msg" -e "$D/secret.bin"
# changed: a byte of the ciphertext's middle, the last (the MDC's)
python3 -I - "$D" <<'EOF'
import sys
d = sys.argv[1]
for name, at in (("ed", None), ("rsa", -1)):
    m = bytearray(open(f"{d}/{name}.msg", "rb").read())
    m[len(m) // 2 if at is None else at] ^= 0x10
    open(f"{d}/{name}-bad.msg", "wb").write(m)
EOF
sleep 1

make -C sim -s -j"$(nproc)" >/dev/null
tools/gksim --for 60 --data "$D" tests/pgp/pgpinterop > "$WORK/sim.log" 2>&1 || true
grep "pgpinterop:" "$WORK/sim.log" | grep -v "signature " || true

FAIL=0
grep -q "pgpinterop: done" "$WORK/sim.log" || { echo "FAIL: the app did not finish"; FAIL=1; }
for name in ed rsa; do
	for what in "wrong passphrase refused" "secret key decrypted, SHA-1 check passed" "public key matches" \
		    "encryption subkey decrypted"; do
		grep -q "pgpinterop: $name: .*$what" "$WORK/sim.log" || { echo "FAIL: $name: $what"; FAIL=1; }
	done
done
N=0
for sig in ed-SHA-256 ed-SHA-512 rsa-SHA-256 rsa-SHA-512; do
	hex=$(sed -n "s/.*pgpinterop: signature $sig \([0-9a-f]*\).*/\1/p" "$WORK/sim.log")
	if [ -z "$hex" ]; then echo "FAIL: no signature $sig"; FAIL=1; continue; fi
	echo "$hex" | python3 -I -c 'import sys; sys.stdout.buffer.write(bytes.fromhex(sys.stdin.read().strip()))' \
		> "$WORK/$sig.sig"
	if gpg --batch --status-fd 1 --verify "$WORK/$sig.sig" "$D/message.bin" \
		> "$WORK/$sig.verify" 2>&1 && grep -q "^\[GNUPG:\] GOODSIG" "$WORK/$sig.verify"; then
		echo "gpg --verify $sig: good signature"
		N=$((N + 1))
	else
		echo "FAIL: gpg --verify $sig:"; cat "$WORK/$sig.verify"; FAIL=1
	fi
done
cp "$D/message.bin" "$WORK/changed.bin"
printf x >> "$WORK/changed.bin"
if gpg --batch --verify "$WORK/ed-SHA-256.sig" "$WORK/changed.bin" >/dev/null 2>&1; then
	echo "FAIL: a changed file verified"; FAIL=1
fi

# decryption: the plaintext's hash, and the changed messages refused
want=$(sha256sum "$D/secret.bin" | cut -d' ' -f1)
M=0
for msg in ed rsa; do
	if grep -q "pgpinterop: decrypted $msg.msg: literal data, sha256 $want" "$WORK/sim.log"; then
		echo "decrypted $msg.msg: the file, as gpg encrypted it"; M=$((M + 1))
	else
		echo "FAIL: $msg.msg not decrypted to the file"; FAIL=1
	fi
	if grep -q "pgpinterop: decrypted $msg-bad.msg: refused (Error:" "$WORK/sim.log"; then
		echo "$msg-bad.msg: refused"; M=$((M + 1))
	else
		echo "FAIL: $msg-bad.msg not refused"; FAIL=1
	fi
done
if grep -q "pgpinterop: decrypted rsa-z.msg: compressed data" "$WORK/sim.log"; then
	echo "decrypted rsa-z.msg: compressed data (not decompressed yet)"; M=$((M + 1))
else
	echo "FAIL: rsa-z.msg not decrypted"; FAIL=1
fi
echo "run_gpg_interop: $N of 4 signatures verified, $M of 5 decryptions right, with $(gpg --version | head -1)"
exit $FAIL
