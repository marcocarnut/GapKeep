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
#   JavaScript, aesKeyUnwrap), decrypts the message and decompresses it
#   (gk:zlib): the literal data must be the file.
#
# With GnuPG 2.4's defaults (its keys announce AEAD) it writes its OCB
# Encrypted Data packet (tag 20, LibrePGP: ocbedDecrypt), compressed: the
# *-ocb messages, one with small chunks (--chunk-size 12: many chunks).
# Then the keys' preferences are set without AEAD, and it writes SEIPD v1
# with an MDC (seipdV1Decrypt): the plain messages, uncompressed (-z 0).
# Refused: a changed byte (OCB; v1: in the middle, in the MDC), an OCB
# message without its final tag, or without its last chunk (the final tag
# kept).
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
	$G --export-secret-keys "$k@example.invalid" > "$D/$k.key"
done
cp "$WORK/passphrase" "$D/passphrase.txt"
# a creation time after the keys' (the simulator's clock may not be set)
echo $(( $(date +%s) + 1 )) > "$D/time.txt"
head -c 100000 /dev/urandom > "$D/message.bin"
head -c 70000 /dev/urandom > "$D/secret.bin"
# GnuPG's defaults: OCB, compressed
$G -r ed@example.invalid -o "$D/ed-ocb.msg" -e "$D/secret.bin"
$G -r rsa@example.invalid -o "$D/rsa-ocb.msg" -e "$D/secret.bin"
$G --chunk-size 12 -r ed@example.invalid -o "$D/ed-ocb-small.msg" -e "$D/secret.bin"
# then without AEAD: SEIPD v1, uncompressed
for k in ed rsa; do
	fpr=$(gpg --batch --with-colons --list-keys "$k@example.invalid" | awk -F: '/^fpr/ { print $10; exit }')
	printf 'setpref AES256 AES192 AES SHA512 SHA384 SHA256 SHA224 ZLIB BZIP2 ZIP\ny\nsave\n' |
		$G --command-fd 0 --edit-key "$fpr" >/dev/null 2>&1
	$G -z 0 -r $k@example.invalid -o "$D/$k.msg" -e "$D/secret.bin"
done
# changed and cut ones (no gpg here: it would try to decrypt them)
python3 -I - "$D" <<'EOF'
import sys
d = sys.argv[1]

def packets(b):
    """[(tag, body)], new-format packets (partial lengths joined), old-format ones"""
    out, i = [], 0
    while i < len(b):
        ctb = b[i]; i += 1
        if ctb & 0x40:
            tag, parts = ctb & 63, []
            while True:
                o = b[i]; i += 1
                if 224 <= o < 255:
                    n = 1 << (o & 31); parts.append(b[i:i + n]); i += n; continue
                if o < 192: n = o
                elif o < 224: n = ((o - 192) << 8) + b[i] + 192; i += 1
                else: n = int.from_bytes(b[i:i + 4], "big"); i += 4
                parts.append(b[i:i + n]); i += n
                break
            out.append((tag, b"".join(parts)))
        else:
            tag, lt = (ctb >> 2) & 15, ctb & 3
            n = {0: 1, 1: 2, 2: 4}[lt]
            ln = int.from_bytes(b[i:i + n], "big"); i += n
            out.append((tag, b[i:i + ln])); i += ln
    return out

def packet(tag, body):
    return bytes([0xc0 | tag, 0xff]) + len(body).to_bytes(4, "big") + body

for name, at in (("ed", None), ("rsa", -1)):			# v1: the middle, the MDC
    m = bytearray(open(f"{d}/{name}.msg", "rb").read())
    m[len(m) // 2 if at is None else at] ^= 0x10
    open(f"{d}/{name}-bad.msg", "wb").write(m)
m = bytearray(open(f"{d}/rsa-ocb.msg", "rb").read())		# OCB: a byte
m[len(m) // 2] ^= 0x10
open(f"{d}/rsa-ocb-bad.msg", "wb").write(m)
ps = packets(open(f"{d}/ed-ocb-small.msg", "rb").read())
pkesk = [packet(t, b) for t, b in ps if t == 1]
body = [b for t, b in ps if t == 20][0]
head, data, final = body[:19], body[19:-16], body[-16:]
open(f"{d}/ed-ocb-cut.msg", "wb").write(b"".join(pkesk) + packet(20, head + data))	# no final tag
step = (1 << (body[3] + 6)) + 16
chunks = (len(data) + step - 1) // step
assert chunks > 2, chunks
open(f"{d}/ed-ocb-nolast.msg", "wb").write(b"".join(pkesk) + packet(20, head + data[:(chunks - 1) * step] + final))
print(f"ed-ocb-small.msg: {chunks} chunks")
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

# decryption: the plaintext's hash, and the changed and cut messages refused
want=$(sha256sum "$D/secret.bin" | cut -d' ' -f1)
M=0
for msg in ed-ocb rsa-ocb ed-ocb-small ed rsa; do
	if grep -q "pgpinterop: decrypted $msg.msg: .*literal data, sha256 $want" "$WORK/sim.log"; then
		echo "decrypted $msg.msg: the file, as gpg encrypted it"; M=$((M + 1))
	else
		echo "FAIL: $msg.msg not decrypted to the file"; FAIL=1
	fi
done
for msg in rsa-ocb-bad ed-ocb-cut ed-ocb-nolast ed-bad rsa-bad; do
	if grep -q "pgpinterop: decrypted $msg.msg: refused (Error:" "$WORK/sim.log"; then
		echo "$msg.msg: refused"; M=$((M + 1))
	else
		echo "FAIL: $msg.msg not refused"; FAIL=1
	fi
done
echo "run_gpg_interop: $N of 4 signatures verified, $M of 10 decryptions right, with $(gpg --version | head -1)"
exit $FAIL
