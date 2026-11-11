#!/usr/bin/env python3
"""Extracts the implicit-rejection test vectors (Appendix B) of
draft-irtf-cfrg-rsa-guidance into tests/native/rsa_implicit_rejection.json:
for each key (2048, 2049, 3072 and 4096 bits) its numbers and, for each
case, the ciphertext and the message RSAES-PKCS1-v1_5 decryption with
implicit rejection must return (the real one, or the synthetic one for
bad padding).

    curl -O https://www.ietf.org/archive/id/draft-irtf-cfrg-rsa-guidance-10.txt
    python3 tools/extract_rsa_guidance.py draft-irtf-cfrg-rsa-guidance-10.txt

The draft is data: read, never run.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import json, re, sys

from cryptography.hazmat.primitives import serialization

OUT = "tests/native/rsa_implicit_rejection.json"


def main():
    lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("Appendix B.  Test Vectors"))
    keys, key, case, mode, buf = [], None, None, None, []

    def flush():
        nonlocal mode, buf
        if mode == "pem":
            pem = "\n".join(buf).encode()
            k = serialization.load_pem_private_key(pem, None)
            pn = k.private_numbers()
            h = lambda x: format(x, "x").rjust((x.bit_length() + 7) // 8 * 2, "0")
            key["key"] = {"n": h(pn.public_numbers.n), "e": h(pn.public_numbers.e), "d": h(pn.d),
                          "p": h(pn.p), "q": h(pn.q)}
        elif mode == "c":
            case["c"] = "".join(buf)
        elif mode == "hex":
            case["m"] = "".join(buf)
        mode, buf = None, []

    for line in lines[start:]:
        s = line.strip()
        if re.match(r"^B\.\d+\.  \d+-bit key", line):
            flush()
            key = {"name": s.split("  ", 1)[1], "cases": []}
            keys.append(key)
        elif re.match(r"^B\.\d+\.\d+\.  ", line):
            flush()
            title = s.split("  ", 1)[1]
            if title != "Private key":
                case = {"name": title}
                key["cases"].append(case)
        elif s == "-----BEGIN PRIVATE KEY-----":
            mode, buf = "pem", [s]
        elif s == "-----END PRIVATE KEY-----":
            buf.append(s)
            flush()
        elif s == "Hex encoded ciphertext:":
            flush()
            mode = "c"
        elif re.match(r"^Hex encoded (decrypted )?message:$", s):
            flush()
            mode = "hex"
        elif re.match(r"^ASCII encoded (decrypted )?message:$", s):
            flush()
            mode = "ascii"
        elif s == "The result of decryption is a message of length 0.":
            flush()
            case["m"] = ""
        elif mode == "pem" and re.match(r"^[A-Za-z0-9+/=]+$", s):
            buf.append(s)
        elif mode in ("c", "hex") and re.match(r"^[0-9a-f]+$", s):
            buf.append(s)
        elif mode == "ascii" and s:
            case["m"] = s.encode().hex()
            mode = None
        elif re.match(r"^\d+\.  ", line) or line.startswith("Appendix C"):
            break
    flush()
    for k in keys:
        assert "key" in k and all("c" in c and "m" in c for c in k["cases"]), k["name"]
    json.dump(keys, open(OUT, "w"), indent=1)
    print(f"{OUT}: {len(keys)} keys, {sum(len(k['cases']) for k in keys)} cases")


if __name__ == "__main__":
    main()
