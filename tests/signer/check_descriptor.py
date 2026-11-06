#!/usr/bin/env python3
"""
Checks the public keys the Signer showed in a tests/signer.txt run: each
screenshot's QR code (decoded with zbarimg) must be the descriptor or zpub
this script makes on its own, from BIP-84's published zpub for the all-"abandon"
test phrase and its master fingerprint. The checksum is computed here from
BIP-380's definition, in Python: nothing is shared with the app.

Usage: check_descriptor.py <screenshot-dir>
       check_descriptor.py --vectors    prints multipath descriptors with
                                        checksums, for descriptor_vectors.json
"""
import hashlib
import json
import subprocess
import sys

FINGERPRINT = "73c5da0a"
BIP84_ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
XPUB = bytes.fromhex("0488b21e")
TPUB = bytes.fromhex("043587cf")


def b58decode(text):
    n = 0
    for c in text:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes(82, "big")
    return raw[:-4]


def b58encode(payload):
    raw = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return out


def with_version(key, version):
    return b58encode(version + b58decode(key)[4:])


# BIP-380, "Checksum"
CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ "
SUM_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GEN = (0xf5dee51989, 0xa9fdca3312, 0x1bab10e32d, 0x3706b1677a, 0x644d626ffd)


def polymod(values):
    c = 1
    for v in values:
        c0 = c >> 35
        c = ((c & 0x7ffffffff) << 5) ^ v
        for i, g in enumerate(GEN):
            if c0 >> i & 1:
                c ^= g
    return c


def checksum(text):
    values, cls, count = [], 0, 0
    for ch in text:
        pos = CHARSET.index(ch)
        values.append(pos & 31)
        cls = cls * 3 + (pos >> 5)
        count += 1
        if count == 3:
            values.append(cls)
            cls, count = 0, 0
    if count:
        values.append(cls)
    c = polymod(values + [0] * 8) ^ 1
    return "".join(SUM_CHARS[(c >> (5 * (7 - i))) & 31] for i in range(8))


def full(body):
    return "%s#%s" % (body, checksum(body))


XPUB84 = with_version(BIP84_ZPUB, XPUB)
SHOTS = {"23-descriptor": full("wpkh([%s/84h/0h/0h]%s/<0;1>/*)" % (FINGERPRINT, XPUB84)), "23-zpub": BIP84_ZPUB}


def vectors():
    tpub = with_version(BIP84_ZPUB, TPUB)
    bodies = ["wpkh([%s/84h/0h/0h]%s/<0;1>/*)" % (FINGERPRINT, XPUB84),
              "sh(wpkh([%s/49h/1h/0h]%s/<0;1>/*))" % (FINGERPRINT, tpub),
              "pkh([%s/44h/0h/7h]%s/<0;1>/*)" % (FINGERPRINT, XPUB84)]
    return [full(b) for b in bodies]


def main():
    if sys.argv[1:] == ["--vectors"]:
        print(json.dumps(vectors(), indent=1))
        return
    failed = 0
    for name, want in SHOTS.items():
        got = subprocess.run(["zbarimg", "-q", "--raw", "%s/%s.png" % (sys.argv[1], name)],
                             capture_output=True, text=True).stdout.strip()
        if got == want:
            print("ok   %s" % name)
        else:
            print("FAIL %s: the QR code is not the expected key (%d characters, want %d)" % (name, len(got), len(want)))
            failed = 1
    sys.exit(failed)


if __name__ == "__main__":
    main()
