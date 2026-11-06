#!/usr/bin/env python3
"""
Checks the account public keys dice39 showed in a tests/dice39_import.txt
run: each screenshot's QR code (decoded with zbarimg) must be the zpub or
the output descriptor that this script derives on its own, from the
scenario's test phrase, with Python's hashlib, a few lines of secp256k1 and
BIP-380's checksum as tests/signer/check_descriptor.py computes it (nothing
shared with the app).

The phrase is BIP-39's all-"abandon" test vector, never a real seed. For
account 0 and no passphrase, the zpub must also be BIP-84's published test
vector, and the descriptor the signer's (tests/signer/check_descriptor.py).

Usage: check_zpub.py <screenshot-dir>
"""
import hashlib
import hmac
import subprocess
import sys

PHRASE = "abandon " * 11 + "about"
# (screenshot, passphrase, account, "zpub" or "descriptor")
SHOTS = [("12-descriptor", "", 0, "descriptor"), ("12-zpub", "", 0, "zpub"),
         ("13-zpub-account1-pass", "TREZOR", 1, "zpub"),
         ("13-descriptor-account1-pass", "TREZOR", 1, "descriptor")]
BIP84_DESCRIPTOR = ("wpkh([73c5da0a/84h/0h/0h]xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPsh"
                    "WcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V/<0;1>/*)#qf45pmyh")
BIP84_ZPUB = ("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs")

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        m = 3 * a[0] * a[0] * pow(2 * a[1], P - 2, P)
    else:
        m = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P)
    x = (m * m - a[0] - b[0]) % P
    return (x, (m * (a[0] - x) - a[1]) % P)


def mul(k, pt=G):
    r = None
    while k:
        if k & 1:
            r = add(r, pt)
        pt = add(pt, pt)
        k >>= 1
    return r


def ser_pub(k):
    x, y = mul(k)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


def hash160(b):
    return hashlib.new("ripemd160", hashlib.sha256(b).digest()).digest()


def b58check(b):
    b = b + hashlib.sha256(hashlib.sha256(b).digest()).digest()[:4]
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = alphabet[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


# BIP-380, "Checksum"
CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ "
SUM_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GEN = (0xf5dee51989, 0xa9fdca3312, 0x1bab10e32d, 0x3706b1677a, 0x644d626ffd)


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
    c = 1
    for v in values + [0] * 8:
        c0 = c >> 35
        c = ((c & 0x7ffffffff) << 5) ^ v
        for i, g in enumerate(GEN):
            if c0 >> i & 1:
                c ^= g
    c ^= 1
    return "".join(SUM_CHARS[(c >> (5 * (7 - i))) & 31] for i in range(8))


def account_keys(phrase, passphrase, account):
    """-> (zpub, descriptor)"""
    zpub, xpub, fp = account_zpub(phrase, passphrase, account)
    body = "wpkh([%s/84h/0h/%dh]%s/<0;1>/*)" % (fp, account, xpub)
    return zpub, "%s#%s" % (body, checksum(body))


def account_zpub(phrase, passphrase, account):
    seed = hashlib.pbkdf2_hmac("sha512", phrase.encode(), ("mnemonic" + passphrase).encode(), 2048)
    i = hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()
    k, c = int.from_bytes(i[:32], "big"), i[32:]
    master_fp = hash160(ser_pub(k))[:4]
    parent_fp = b""
    for index in (84 + 2**31, 0 + 2**31, account + 2**31):
        parent_fp = hash160(ser_pub(k))[:4]
        i = hmac.new(c, b"\0" + k.to_bytes(32, "big") + index.to_bytes(4, "big"), hashlib.sha512).digest()
        k, c = (int.from_bytes(i[:32], "big") + k) % N, i[32:]
    raw = bytes([3]) + parent_fp + index.to_bytes(4, "big") + c + ser_pub(k)
    return b58check(bytes.fromhex("04b24746") + raw), b58check(bytes.fromhex("0488b21e") + raw), master_fp.hex()


def decode(png):
    out = subprocess.run(["zbarimg", "--quiet", "--raw", png], capture_output=True, check=True).stdout
    return out.decode().strip()


def main():
    shots = sys.argv[1]
    zpub0, _, fp = account_zpub(PHRASE, "", 0)
    assert zpub0 == BIP84_ZPUB, "this script disagrees with BIP-84's vector: %s" % zpub0
    assert fp == "73c5da0a", fp
    assert account_keys(PHRASE, "", 0)[1] == BIP84_DESCRIPTOR, "this script disagrees with the signer's descriptor"
    for name, passphrase, account, form in SHOTS:
        zpub, descriptor = account_keys(PHRASE, passphrase, account)
        want = zpub if form == "zpub" else descriptor
        got = decode("%s/%s.png" % (shots, name))
        assert got == want, "%s: the QR code holds %s, expected %s" % (name, got, want)
    print("dice39 key QR codes match: %d keys (zpubs and descriptors), BIP-84's vector among them" % len(SHOTS))


if __name__ == "__main__":
    main()
