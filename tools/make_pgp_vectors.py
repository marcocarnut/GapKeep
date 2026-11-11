#!/usr/bin/env python3
"""Writes tests/apps/pgpcrypto/vectors.js: the known answers the pgpcrypto
test app checks gk:crypto's OpenPGP primitives with, on the simulator, in
QEMU and on a Pi Zero. Taken from the files in tests/native (Wycheproof's
Ed25519 and RSA PKCS #1 v1.5 vectors, NIST CAVP's CFB128 MMT files), plus
RSA keys of each size made here with Python's cryptography, which also
signs (PKCS #1 v1.5 is deterministic: the app must get the same bytes).

    python3 tools/make_pgp_vectors.py

Run from the top of the tree. The keys are new each run: commit the result.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import hashlib, json, math, os, random, re, sys

from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
from cryptography.hazmat.primitives import hashes

OUT = "tests/apps/pgpcrypto/vectors.js"
HASHES = {"SHA-1": "sha1", "SHA-224": "sha224", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512"}
CHASH = {"SHA-224": hashes.SHA224, "SHA-256": hashes.SHA256, "SHA-384": hashes.SHA384, "SHA-512": hashes.SHA512}


def hx(x):
    return format(x, "x").rjust((x.bit_length() + 7) // 8 * 2, "0")


def factor(n, e, d):
    k, t = d * e - 1, 0
    while k % 2 == 0:
        k, t = k // 2, t + 1
    rnd = random.Random(1)
    while True:
        x = pow(rnd.randrange(2, n - 1), k, n)
        for _ in range(t):
            y = x * x % n
            if y == 1 and x not in (1, n - 1):
                p = math.gcd(x - 1, n)
                return min(p, n // p), max(p, n // p)
            x = y


def main():
    v = {}
    # Ed25519: all of Wycheproof's (acceptable: either answer)
    j = json.load(open("tests/native/wycheproof/ed25519_test.json"))
    v["ed25519Wycheproof"] = [[g["publicKey"]["pk"], t["msg"], t["sig"], t["result"][0], t["tcId"]]
                              for g in j["testGroups"] for t in g["tests"]]

    # RSA verification: Wycheproof 2048/SHA-256, up to 4 of each kind
    j = json.load(open("tests/native/wycheproof/rsa_signature_2048_sha256_test.json"))
    seen, tests = {}, []
    for g in j["testGroups"]:
        for t in g["tests"]:
            kind = (t["result"], tuple(t["flags"]))
            if seen.get(kind, 0) >= 4:
                continue
            seen[kind] = seen.get(kind, 0) + 1
            tests.append([g["publicKey"]["modulus"], g["publicKey"]["publicExponent"],
                          hashlib.sha256(bytes.fromhex(t["msg"])).hexdigest(), t["sig"], t["result"][0], t["tcId"]])
    v["rsaVerifyWycheproof"] = tests

    # RSA signing: Wycheproof's 2048-bit SHA-256 groups (p, q, u recovered)
    j = json.load(open("tests/native/wycheproof/rsa_pkcs1_2048_sig_gen_test.json"))
    tests = []
    for g in j["testGroups"]:
        if g["sha"] != "SHA-256":
            continue
        k = g["privateKey"]
        n, e, d = (int(k[x], 16) for x in ("modulus", "publicExponent", "privateExponent"))
        p, q = factor(n, e, d)
        key = {"n": hx(n), "e": hx(e), "d": hx(d), "p": hx(p), "q": hx(q), "u": hx(pow(p, -1, q))}
        for t in g["tests"]:
            tests.append([key, hashlib.sha256(bytes.fromhex(t["msg"])).hexdigest(), t["sig"], t["tcId"]])
    v["rsaSignWycheproof"] = tests

    # a key of each size, and a signature with each hash
    keys = []
    for bits in (2048, 3072, 4096):
        k = rsa.generate_private_key(65537, bits)
        pn = k.private_numbers()
        p, q = sorted((pn.p, pn.q))
        n = pn.public_numbers.n
        key = {"n": hx(n), "e": hx(65537), "d": hx(pn.d), "p": hx(p), "q": hx(q), "u": hx(pow(p, -1, q))}
        sigs = {}
        for name in ("SHA-224", "SHA-256", "SHA-384", "SHA-512"):
            digest = hashlib.new(HASHES[name], b"GapKeep").digest()
            sigs[name] = k.sign(digest, padding.PKCS1v15(), Prehashed(CHASH[name]())).hex()
        sha1 = hashlib.sha1(b"GapKeep").digest()
        sigs["SHA-1"] = k.sign(sha1, padding.PKCS1v15(), Prehashed(hashes.SHA1())).hex()
        keys.append({"bits": bits, "key": key, "sigs": sigs})
    v["rsaKeys"] = keys

    # RSA-1024: verified (old signatures), never imported
    k = rsa.generate_private_key(65537, 1024)
    pn = k.private_numbers()
    p, q = sorted((pn.p, pn.q))
    digest = hashlib.sha256(b"GapKeep").digest()
    v["rsa1024"] = {"key": {"n": hx(pn.public_numbers.n), "e": hx(65537), "d": hx(pn.d), "p": hx(p), "q": hx(q),
                            "u": hx(pow(p, -1, q))},
                    "digest": digest.hex(),
                    "sig": k.sign(digest, padding.PKCS1v15(), Prehashed(hashes.SHA256())).hex()}

    # RSA decryption with implicit rejection: the draft's 2048- and 4096-bit
    # keys and cases (draft-irtf-cfrg-rsa-guidance-10, Appendix B)
    v["rsaDecryptDraft"] = [k for k in json.load(open("tests/native/rsa_implicit_rejection.json"))
                            if k["name"] in ("2048-bit key", "4096-bit key")]

    # Wycheproof RSA decryption (2048): valid ones decrypt to msg, invalid
    # ones to implicit rejection's message (check_pgp.py's reference);
    # those not as long as n or not below it are refused (null)
    sys.path.insert(0, "tools")
    from check_pgp import rsa_decrypt_ref
    j = json.load(open("tests/native/wycheproof/rsa_pkcs1_2048_test.json"))
    groups = []
    for g in j["testGroups"]:
        k = g["privateKey"]
        n, e, d, p, q = (int(k[x], 16) for x in ("modulus", "publicExponent", "privateExponent", "prime1", "prime2"))
        tests = []
        for t in g["tests"]:
            c = bytes.fromhex(t["ct"])
            if len(c) != (n.bit_length() + 7) // 8 or int.from_bytes(c, "big") >= n:
                want = None
            elif t["result"] == "valid":
                want = t["msg"]
            else:
                want = rsa_decrypt_ref(n, d, c).hex()
            tests.append([t["ct"], want, t["tcId"]])
        groups.append({"key": {"n": hx(n), "e": hx(e), "d": hx(d), "p": hx(p), "q": hx(q)}, "tests": tests})
    v["rsaDecryptWycheproof"] = groups

    # X25519: Wycheproof, up to 6 of each kind, every zero shared secret
    j = json.load(open("tests/native/wycheproof/x25519_test.json"))
    seen, tests = {}, []
    for g in j["testGroups"]:
        for t in g["tests"]:
            kind = tuple(t["flags"])
            zero = t["shared"] == "00" * 32
            if not zero and seen.get(kind, 0) >= 6:
                continue
            seen[kind] = seen.get(kind, 0) + 1
            tests.append([t["private"], t["public"], None if zero else t["shared"], t["tcId"]])
    v["x25519Wycheproof"] = tests

    # AES key wrap: Wycheproof, up to 6 of each kind
    j = json.load(open("tests/native/wycheproof/aes_wrap_test.json"))
    seen, tests = {}, []
    for g in j["testGroups"]:
        for t in g["tests"]:
            kind = (t["result"], tuple(t["flags"]))
            if seen.get(kind, 0) >= 6:
                continue
            seen[kind] = seen.get(kind, 0) + 1
            tests.append([t["key"], t["msg"], t["ct"], t["result"][0], t["tcId"]])
    v["aesWrapWycheproof"] = tests

    # AEAD packets (OCB): v2 SEIPD and GnuPG's OCB packet, made by
    # check_pgp.py's independent encoder (Python's cryptography's OCB)
    from check_pgp import aead_packet
    rnd = random.Random(9)
    tests = []
    for packet, keylen, c, size in ((18, 16, 0, 0), (18, 24, 0, 200), (18, 32, 2, 1000), (20, 16, 0, 64),
                                    (20, 24, 1, 129), (20, 32, 16, 3000), (18, 16, 4, 2500), (20, 16, 2, 1)):
        sk, plain = rnd.randbytes(keylen), rnd.randbytes(size)
        data, chunks = aead_packet(packet, sk, plain, c, rnd.randbytes(32 if packet == 18 else 15))
        tests.append({"packet": packet, "key": sk.hex(), "data": data.hex(), "plain": plain.hex(), "chunks": chunks})
    v["aeadPackets"] = tests
    # for timing: 256 KiB of zeros, 16 KiB chunks, in base64
    import base64
    sk = rnd.randbytes(16)
    data, chunks = aead_packet(20, sk, bytes(256 * 1024), 8, rnd.randbytes(15))
    v["aeadBig"] = {"packet": 20, "key": sk.hex(), "data": base64.b64encode(data).decode(), "size": 256 * 1024}

    # gk:zlib: small streams both ways, 1 MiB that compresses well, and 33
    # MiB of zeros (a bomb: over the largest maxOutput)
    import zlib as Z
    def deflate(data, fmt, level=9):
        c = Z.compressobj(level, Z.DEFLATED, -15 if fmt == "raw" else 15)
        return (c.compress(data) + c.flush()).hex()
    text = b"GapKeep inflate test, " * 50
    v["zlibSmall"] = [{"format": f, "data": deflate(d, f, l), "plain": d.hex()}
                      for f in ("raw", "zlib") for d, l in ((b"", 9), (b"x", 0), (text, 9), (rnd.randbytes(500), 6))]
    mib = b"".join(bytes([i % 251]) * 64 for i in range(16384))
    v["zlibMiB"] = {"format": "zlib", "data": deflate(mib, "zlib"), "sha256": hashlib.sha256(mib).hexdigest()}
    v["zlibBomb"] = {"format": "zlib", "data": deflate(bytes(33 << 20), "zlib")}

    # AES-CFB128: CAVP's MMT files (both ways)
    tests = []
    for size in (128, 192, 256):
        mode, rec = None, {}
        for line in open(f"tests/native/cavp/CFB128MMT{size}.rsp"):
            line = line.strip()
            if line in ("[ENCRYPT]", "[DECRYPT]"):
                mode = line[1]
            m = re.match(r"(\w+) = (\w*)", line)
            if m:
                rec[m.group(1)] = m.group(2)
                if m.group(1) == ("CIPHERTEXT" if mode == "E" else "PLAINTEXT"):
                    tests.append([mode, rec["KEY"], rec["IV"], rec["PLAINTEXT"], rec["CIPHERTEXT"]])
                    rec = {}
    v["aesCfbMmt"] = tests

    with open(OUT, "w") as f:
        f.write("// Generated by tools/make_pgp_vectors.py: known answers for main.js.\n")
        f.write("// SPDX-License-Identifier: GPL-3.0-or-later\n")
        for name, value in v.items():
            f.write(f"export const {name} = {json.dumps(value, separators=(',', ':'))};\n")
    print(f"{OUT}: {os.path.getsize(OUT)} bytes")


if __name__ == "__main__":
    main()
