#!/usr/bin/env python3
"""Compares src/crypto's SHA-1, SHA-256, SHA-512, HMAC, RIPEMD-160, HASH160
and PBKDF2 with Python's hashlib on random inputs (keys 0-299 bytes,
messages 0-599: across the block and padding boundaries). Run from the top of the tree:

    python3 tools/check_hashes.py [cases]

SPDX-License-Identifier: GPL-3.0-or-later
"""
import hashlib, hmac, os, subprocess, sys, tempfile

cases = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
names = {"SHA-1": "sha1", "SHA-256": "sha256", "SHA-512": "sha512"}

with tempfile.TemporaryDirectory() as tmp:
    exe = os.path.join(tmp, "hmactest")
    src = ["tests/native/test_hmac.c"] + [f"src/crypto/{f}.c" for f in ("sha1", "sha256", "sha512", "hmac", "ripemd160", "pbkdf2")]
    subprocess.run(["cc", "-O2", "-Wall", "-Werror", "-I", "src/crypto", "-o", exe] + src, check=True)
    out = subprocess.run([exe, str(cases)], check=True, capture_output=True, text=True).stdout

lines = out.splitlines()
print(lines[0])
if "PASS" not in lines[0]:
    sys.exit(1)
bad = 0
def ripemd160(data):
    try:
        return hashlib.new("ripemd160", data).hexdigest()
    except ValueError:  # OpenSSL 3 without the legacy provider
        return subprocess.run(["node", "-e", "process.stdout.write(require('crypto').createHash('ripemd160')"
                               ".update(Buffer.from(process.argv[1],'hex')).digest('hex'))", data.hex()],
                              check=True, capture_output=True, text=True).stdout

counts = {}
for line in lines[1:]:
    f = line.split(" ")
    if f[0] == "PBKDF2":
        alg, pw, salt, it, dk = names[f[1]], bytes.fromhex(f[2]), bytes.fromhex(f[3]), int(f[4]), f[5]
        ok = hashlib.pbkdf2_hmac(alg, pw, salt, it, len(dk) // 2).hex() == dk
    elif f[0] == "RIPEMD-160":
        m = bytes.fromhex(f[2])
        ok = ripemd160(m) == f[3] and ripemd160(hashlib.sha256(m).digest()) == f[4]
    else:
        name, k, m, d, mac = (f + [""] * 5)[:5]
        alg = names[name]
        k, m = bytes.fromhex(k), bytes.fromhex(m)
        ok = hashlib.new(alg, m).hexdigest() == d and hmac.new(k, m, alg).hexdigest() == mac
    counts[f[0]] = counts.get(f[0], 0) + 1
    if not ok:
        bad += 1
        print("MISMATCH", line[:80])
print(f"{len(lines) - 1} random cases against hashlib ({counts}): {bad} mismatches")
sys.exit(1 if bad else 0)
