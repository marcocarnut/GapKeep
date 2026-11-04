#!/usr/bin/env python3
"""Compares src/crypto's SHA-1, SHA-256, SHA-512 and HMAC with Python's
hashlib on random inputs (keys 0-299 bytes, messages 0-599: across the
block and padding boundaries). Run from the top of the tree:

    python3 tools/check_hashes.py [cases]

SPDX-License-Identifier: GPL-3.0-or-later
"""
import hashlib, hmac, os, subprocess, sys, tempfile

cases = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
names = {"SHA-1": "sha1", "SHA-256": "sha256", "SHA-512": "sha512"}

with tempfile.TemporaryDirectory() as tmp:
    exe = os.path.join(tmp, "hmactest")
    src = ["tests/native/test_hmac.c"] + [f"src/crypto/{f}.c" for f in ("sha1", "sha256", "sha512", "hmac")]
    subprocess.run(["cc", "-O2", "-Wall", "-Werror", "-I", "src/crypto", "-o", exe] + src, check=True)
    out = subprocess.run([exe, str(cases)], check=True, capture_output=True, text=True).stdout

lines = out.splitlines()
print(lines[0])
if "PASS" not in lines[0]:
    sys.exit(1)
bad = 0
for line in lines[1:]:
    name, k, m, d, mac = (line.split(" ") + [""] * 5)[:5]
    alg = names[name]
    k, m = bytes.fromhex(k), bytes.fromhex(m)
    if hashlib.new(alg, m).hexdigest() != d or hmac.new(k, m, alg).hexdigest() != mac:
        bad += 1
        print("MISMATCH", name, len(k), len(m))
print(f"{len(lines) - 1} random cases against hashlib: {bad} mismatches")
sys.exit(1 if bad else 0)
