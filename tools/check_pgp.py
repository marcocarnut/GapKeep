#!/usr/bin/env python3
"""Checks src/crypto's OpenPGP primitives (S2K, AES-CFB, Ed25519, RSA
PKCS #1 v1.5), built for the host with the vendored Monocypher and Mbed
TLS as the kernel builds them (tests/native/test_pgp.c), against:

  - known answers: RFC 9580's S2K examples (A.9.1 to A.11.1, the largest
    count), NIST CAVP's CFB128 files (tests/native/cavp: GFSbox, KeySbox,
    MMT), Wycheproof (tests/native/wycheproof: Ed25519, RSA PKCS #1 v1.5
    signing and verification);
  - an independent implementation: the S2K below, written from RFC 9580,
    and Python's cryptography package (OpenSSL) for AES-CFB, Ed25519 and
    RSA, on random inputs and random keys;
  - negative cases: wrong sizes, inconsistent RSA keys, SHA-1 signing.

    python3 tools/check_pgp.py [--cases N] [--wycheproof DIR] [--cavp DIR]

--wycheproof and --cavp add directories of more vector files of the same
kinds (the whole Wycheproof testvectors_v1 set, NIST's KAT_AES.zip). Run
from the top of the tree. Needs cc and Python's cryptography.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse, glob, hashlib, json, os, random, re, subprocess, sys, tempfile

from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import hashes, serialization

HASHES = {"SHA-1": "sha1", "SHA-224": "sha224", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512"}
CHASH = {"SHA-1": hashes.SHA1, "SHA-224": hashes.SHA224, "SHA-256": hashes.SHA256,
         "SHA-384": hashes.SHA384, "SHA-512": hashes.SHA512}
# rsa.h's error codes
BAD_SIZE, BAD_KEY, BAD_HASH = "error -1", "error -2", "error -4"

failures = []


def check(ok, what):
    if not ok:
        failures.append(what)
        if len(failures) <= 20:
            print("FAIL", what)


def h(b):
    return b.hex() if b else "-"


def i2b(x):
    return x.to_bytes((x.bit_length() + 7) // 8, "big")


# --- RFC 9580, 3.7.1: an independent S2K -----------------------------------

def s2k(hash_name, kind, pw, salt, coded, length):
    count = (16 + (coded & 15)) << ((coded >> 4) + 6)
    out, i = b"", 0
    while len(out) < length:
        m = hashlib.new(HASHES[hash_name])
        m.update(b"\0" * i)
        if kind == 0:
            m.update(pw)
        elif kind == 1 or count < len(salt + pw):
            m.update(salt + pw)
        else:
            data = salt + pw
            full, rem = divmod(count, len(data))
            m.update(data * full + data[:rem])
        out += m.digest()
        i += 1
    return out[:length]


# --- RSA: recover p and q from n, e, d (Wycheproof gives only those) --------

def factor(n, e, d):
    k = d * e - 1
    t = 0
    while k % 2 == 0:
        k //= 2
        t += 1
    rnd = random.Random(1)
    while True:
        g = rnd.randrange(2, n - 1)
        x = pow(g, k, n)
        for _ in range(t):
            y = pow(x, 2, n)
            if y == 1 and x not in (1, n - 1):
                p = __import__("math").gcd(x - 1, n)
                q = n // p
                return min(p, q), max(p, q)
            x = y


class Native:
    def __init__(self, exe):
        self.p = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        first = self.p.stdout.readline().strip()
        print(first)
        if "PASS" not in first:
            sys.exit(1)

    def __call__(self, *args):
        self.p.stdin.write(" ".join(str(a) for a in args) + "\n")
        return self.p.stdout.readline().strip()


def build():
    tmp = tempfile.mkdtemp()
    exe = os.path.join(tmp, "pgptest")
    mbed = "third_party/mbedtls/library/"
    mbed_src = re.search(r"MBEDTLS_SOURCES\s*=\s*((?:[^\n]*\\\n)*[^\n]*)",
                         open("lib/mbedtls/mbedtls.mk").read()).group(1).replace("\\", " ").split()
    src = ["tests/native/test_pgp.c"] + [f"src/crypto/{f}.c" for f in
                                          ("sha1", "sha256", "sha512", "hmac", "s2k", "aes", "ed25519", "rsa", "wipe")]
    src += [mbed + f for f in mbed_src]
    src += ["third_party/monocypher/src/monocypher.c", "third_party/monocypher/src/optional/monocypher-ed25519.c"]
    subprocess.run(["cc", "-O2", "-Wall", "-I", "src/crypto", "-I", "lib/mbedtls", "-I", "third_party/mbedtls/include",
                    "-I", "third_party/monocypher/src", "-I", "third_party/monocypher/src/optional",
                    "-DMBEDTLS_CONFIG_FILE=\"gk_mbedtls_config.h\"", "-o", exe] + src, check=True)
    return exe


def check_s2k(native, rnd, cases):
    # RFC 9580, A.9.1, A.10.1, A.11.1: SHA2-256, 65011712 bytes, "password"
    for salt, key in [("a5ae579d1fc5d82b", "154967e590aa1f923e1c0ac64c88f23d"),
                      ("56a298d2f5e36453", "e80de243a362d93b9dc607ede96a7356"),
                      ("e9d39785b2070008", "250281715bba7828ef71ef64c4784753")]:
        check(native("s2k", 3, "SHA-256", h(b"password"), salt, 255, 16) == key, "S2K RFC 9580 salt " + salt)
    for c in range(cases):
        kind = rnd.choice((0, 1, 3))
        name = rnd.choice(list(HASHES))
        pw = rnd.randbytes(rnd.choice((0, 1, 8, 20, 100, 1016, 1017, 1100, rnd.randrange(300))))
        salt = rnd.randbytes(8)
        coded = rnd.randrange(0x70)
        length = rnd.randrange(1, 65)
        want = s2k(name, kind, pw, salt, coded, length).hex()
        got = native("s2k", kind, name, h(pw), h(salt), coded, length)
        check(got == want, f"S2K {kind} {name} pw {len(pw)} count {coded} len {length}")
    check(native("s2k", 2, "SHA-256", "-", "0102030405060708", 0, 16) == "error -2", "S2K type 2 refused")


def check_aes(native, rnd, cases, cavp_dirs):
    n = 0
    for d in cavp_dirs:
        for f in sorted(glob.glob(os.path.join(d, "CFB128*.rsp"))):
            mode = None
            rec = {}
            for line in open(f):
                line = line.strip()
                if line in ("[ENCRYPT]", "[DECRYPT]"):
                    mode = line[1:4].lower()
                m = re.match(r"(\w+) = (\w*)", line)
                if m:
                    rec[m.group(1)] = m.group(2)
                if m and m.group(1) == ("CIPHERTEXT" if mode == "enc" else "PLAINTEXT") and "KEY" in rec:
                    src, dst = (rec["PLAINTEXT"], rec["CIPHERTEXT"]) if mode == "enc" else (rec["CIPHERTEXT"], rec["PLAINTEXT"])
                    check(native("aes", mode, rec["KEY"], rec["IV"], src) == dst.lower(),
                          f"AES {os.path.basename(f)} {mode} {rec.get('COUNT')}")
                    rec = {}
                    n += 1
    print(f"  CAVP CFB128: {n} vectors")
    for c in range(cases):
        key = rnd.randbytes(rnd.choice((16, 24, 32)))
        iv = rnd.randbytes(16)
        data = rnd.randbytes(rnd.choice((0, 1, 15, 16, 17, 31, 32, 33, rnd.randrange(1000))))
        enc = Cipher(algorithms.AES(key), modes.CFB(iv)).encryptor().update(data)
        check(native("aes", "enc", h(key), h(iv), h(data)) == (enc.hex() or "-"), f"AES enc {len(key)} {len(data)}")
        check(native("aes", "dec", h(key), h(iv), h(enc)) == (data.hex() or "-"), f"AES dec {len(key)} {len(data)}")
    check(native("aes", "enc", h(bytes(20)), h(bytes(16)), "00") == "error -2", "AES 20-byte key refused")


def check_ed25519(native, rnd, cases, wy_dirs):
    counts = {}
    for d in wy_dirs:
        for f in sorted(glob.glob(os.path.join(d, "ed25519_test.json"))):
            for g in json.load(open(f))["testGroups"]:
                pk = g["publicKey"]["pk"]
                for t in g["tests"]:
                    got = native("ed25519v", h(bytes.fromhex(t["sig"])), pk, h(bytes.fromhex(t["msg"])))
                    key = (t["result"], got)
                    counts[key] = counts.get(key, 0) + 1
                    if t["result"] != "acceptable":
                        check(got == ("1" if t["result"] == "valid" else "0"),
                              f"Wycheproof Ed25519 {t['tcId']} {t['result']} {t['flags']}")
    print(f"  Wycheproof Ed25519 (result, ours): {counts}")
    for c in range(cases):
        seed, msg = rnd.randbytes(32), rnd.randbytes(rnd.randrange(300))
        k = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
        pub = k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        want = pub.hex() + " " + k.sign(msg).hex()
        check(native("ed25519", h(seed), h(msg)) == want, f"Ed25519 sign {len(msg)}")
        sig = bytearray(k.sign(msg))
        check(native("ed25519v", h(sig), h(pub), h(msg)) == "1", "Ed25519 verify")
        sig[rnd.randrange(64)] ^= 1 << rnd.randrange(8)
        check(native("ed25519v", h(sig), h(pub), h(msg)) == "0", "Ed25519 verify corrupted")


def rsa_numbers(n, e, d):
    p, q = factor(n, e, d)
    return p, q, pow(p, -1, q)


def check_rsa(native, rnd, cases, wy_dirs):
    # Wycheproof verification: the digest of msg, then ours; sizes outside
    # 2048-4096 are always refused
    counts = {}
    for d in wy_dirs:
        for f in sorted(glob.glob(os.path.join(d, "rsa_signature_*_test.json"))):
            j = json.load(open(f))
            for g in j["testGroups"]:
                if g.get("sha") not in HASHES:
                    continue
                n, e = g["publicKey"]["modulus"], g["publicKey"]["publicExponent"]
                for t in g["tests"]:
                    digest = hashlib.new(HASHES[g["sha"]], bytes.fromhex(t["msg"])).digest()
                    got = native("rsaverify", g["sha"], h(digest), h(bytes.fromhex(t["sig"])), n, e)
                    want = "1" if t["result"] == "valid" and 2048 <= g["keySize"] <= 4096 else "0"
                    key = (os.path.basename(f)[14:-10], t["result"], got)
                    counts[key] = counts.get(key, 0) + 1
                    if t["result"] != "acceptable":
                        check(got == want, f"Wycheproof {os.path.basename(f)} {t['tcId']} {t['flags']}")
        # Wycheproof signing: the same signature (deterministic), or refused
        for f in sorted(glob.glob(os.path.join(d, "rsa_pkcs1_*_sig_gen_test.json"))):
            for g in json.load(open(f))["testGroups"]:
                k = g["privateKey"]
                n, e, dd = (int(k[x], 16) for x in ("modulus", "publicExponent", "privateExponent"))
                p, q, u = rsa_numbers(n, e, dd)
                for t in g["tests"]:
                    digest = hashlib.new(HASHES[g["sha"]], bytes.fromhex(t["msg"])).digest()
                    got = native("rsasign", g["sha"], h(digest), h(i2b(n)), h(i2b(e)), h(i2b(dd)),
                                 h(i2b(p)), h(i2b(q)), h(i2b(u)))
                    if not 2048 <= g["keySize"] <= 4096:
                        want = BAD_SIZE
                    elif g["sha"] == "SHA-1":
                        want = BAD_HASH
                    else:
                        want = t["sig"]
                    key = (os.path.basename(f)[10:-14], g["sha"], t["result"], got == want)
                    counts[key] = counts.get(key, 0) + 1
                    check(got == want, f"Wycheproof {os.path.basename(f)} {t['tcId']} {g['sha']}")
                    if g["sha"] == "SHA-1" and 2048 <= g["keySize"] <= 4096:
                        check(native("rsaverify", "SHA-1", h(digest), t["sig"], h(i2b(n)), h(i2b(e))) == "1",
                              f"Wycheproof SHA-1 verify {t['tcId']}")
    for k in sorted(counts):
        print("  Wycheproof RSA", k, counts[k])

    # random keys, made by OpenSSL: the same signatures, both ways
    for c in range(cases):
        bits = rnd.choice((2048, 2048, 3072, 4096, 2056, 3071))
        key = rsa.generate_private_key(65537, bits)
        pn = key.private_numbers()
        p, q = sorted((pn.p, pn.q))
        n, e, d = pn.public_numbers.n, pn.public_numbers.e, pn.d
        u = pow(p, -1, q)
        name = rnd.choice(["SHA-224", "SHA-256", "SHA-384", "SHA-512"])
        digest = rnd.randbytes(hashlib.new(HASHES[name]).digest_size)
        want = key.sign(digest, padding.PKCS1v15(), Prehashed(CHASH[name]())).hex()
        nums = [h(i2b(x)) for x in (n, e, d, p, q)]
        check(native("rsasign", name, h(digest), *nums, h(i2b(u))) == want, f"RSA-{bits} sign {name}")
        # with leading zeros, the primes the other way round, without u
        check(native("rsasign", name, h(digest), "00" + nums[0], "0000" + nums[1], nums[2], nums[4], nums[3])
              == want, f"RSA-{bits} sign, q < p, no u")
        check(native("rsaverify", name, h(digest), want, nums[0], nums[1]) == "1", f"RSA-{bits} verify")
        sig1 = key.sign(digest[:20], padding.PKCS1v15(), Prehashed(hashes.SHA1())).hex()
        check(native("rsaverify", "SHA-1", h(digest[:20]), sig1, nums[0], nums[1]) == "1", "RSA verify SHA-1")
        # negatives
        bad = bytearray(bytes.fromhex(want))
        bad[rnd.randrange(len(bad))] ^= 1 << rnd.randrange(8)
        check(native("rsaverify", name, h(digest), h(bad), nums[0], nums[1]) == "0", "RSA verify corrupted")
        other = "SHA-512" if name != "SHA-512" else "SHA-384"
        check(native("rsaverify", other, h(digest), want, nums[0], nums[1]) == "0", "RSA verify wrong hash name")
        check(native("rsaverify", name, h(digest[:-1]), want, nums[0], nums[1]) == "0", "RSA verify short digest")
        check(native("rsaverify", name, h(digest), want[2:], nums[0], nums[1]) == "0", "RSA verify short signature")
        check(native("rsasign", "SHA-1", h(digest[:20]), *nums) == BAD_HASH, "RSA sign SHA-1 refused")
        check(native("rsasign", name, h(digest[:-1]), *nums) == BAD_HASH, "RSA sign short digest")
        check(native("rsasign", name, h(digest), nums[0], nums[1], h(i2b(d + 2)), nums[3], nums[4]) == BAD_KEY,
              "RSA d off")
        check(native("rsasign", name, h(digest), nums[0], nums[1], nums[2], nums[3], h(i2b(q + 2))) == BAD_KEY,
              "RSA q off")
        check(native("rsasign", name, h(digest), *nums, h(i2b(pow(q, -1, p)))) == BAD_KEY,
              "RSA PKCS #1's u refused")
        check(native("rsasign", name, h(digest), nums[0], h(i2b(3)), nums[2], nums[3], nums[4]) == BAD_KEY,
              "RSA e off")
    # sizes
    for bits in (1024, 2040, 4104):
        key = rsa.generate_private_key(65537, bits)
        pn = key.private_numbers()
        nums = [h(i2b(x)) for x in (pn.public_numbers.n, 65537, pn.d, pn.p, pn.q)]
        check(native("rsasign", "SHA-256", h(bytes(32)), *nums) == BAD_SIZE, f"RSA-{bits} refused")
        sig = key.sign(bytes(32), padding.PKCS1v15(), Prehashed(hashes.SHA256())).hex()
        check(native("rsaverify", "SHA-256", h(bytes(32)), sig, nums[0], nums[1]) == "0", f"RSA-{bits} verify refused")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=200)
    ap.add_argument("--wycheproof", action="append", default=[])
    ap.add_argument("--cavp", action="append", default=[])
    args = ap.parse_args()
    rnd = random.Random(2026)
    native = Native(build())
    check_s2k(native, rnd, args.cases)
    print("S2K done")
    check_aes(native, rnd, args.cases, ["tests/native/cavp"] + args.cavp)
    print("AES-CFB done")
    check_ed25519(native, rnd, args.cases, ["tests/native/wycheproof"] + args.wycheproof)
    print("Ed25519 done")
    check_rsa(native, rnd, max(4, args.cases // 20), ["tests/native/wycheproof"] + args.wycheproof)
    print("RSA done")
    print(f"check_pgp: {len(failures)} failures")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
