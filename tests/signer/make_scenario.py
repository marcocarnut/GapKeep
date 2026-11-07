#!/usr/bin/env python3
"""
tests/signer.txt from tests/signer/signer.txt.in: fills in Electrum's QR
codes (tests/signer/electrum.json) and those tests/signer/run_node.mjs makes
(--made-out). The codes are public test data ("abandon ... about").

  python3 tests/signer/make_scenario.py
"""
import hashlib
import json
import os
import re
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ELECTRUM = ["mainnet-p2wpkh-watch-only", "testnet-p2wpkh-seed", "testnet-p2pkh-qr"]


def main():
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "made.json")
        subprocess.check_call(["node", "--experimental-default-type=module",
                               os.path.join(HERE, "run_node.mjs"), "--made-out", out],
                              stdout=subprocess.DEVNULL, cwd=ROOT)
        with open(out) as f:
            made = json.load(f)
    with open(os.path.join(HERE, "electrum.json")) as f:
        cases = {c["name"]: c for c in json.load(f)["cases"]}
    for i, name in enumerate(ELECTRUM):
        made["electrum%d" % (i + 1)] = cases[name]["qr"]
    for i, part in enumerate(made.pop("big")):
        made["big%d" % i] = part
    total = i + 1
    made["bigparts"] = str(total)
    made["bigrest"] = "\n".join("mark\ncamera qr %s\nexpect signer: BBQr part: %d of %d 15" % (made["big%d" % n], n + 1, total)
                                 for n in range(1, total - 1))
    made["biglast"] = made["big%d" % (total - 1)]
    # as many shots as the series can have parts, and a few: they wrap around
    shots = "\n".join("mark\nkey ret\nexpect signer: part \\d+ of \\d+, \\d+ modules 10\nwait 0.5\nshot %s-part-%02d" % ("%s", n) for n in range(24))
    made["txshots"] = shots.replace("%s", "30")
    made["psbtshots"] = shots.replace("%s", "31")
    file = cases["testnet-p2pkh-file"]
    made["p2pkhfile"] = file["qr"]
    made["p2pkhhash"] = hashlib.sha256(bytes.fromhex(file["electrum_final_tx"])).hexdigest()[:16]
    # a legacy transaction has no witness: its id is Electrum's bytes, hashed here
    final = bytes.fromhex(file["electrum_final_tx"])
    made["p2pkhtxid"] = hashlib.sha256(hashlib.sha256(final).digest()).digest()[::-1].hex()
    def codes(parts):
        return "\n".join("mark\ncamera qr %s" % part + ("\nexpect signer: BBQr part: %d of %d 15" % (n + 1, len(parts)) if n + 1 < len(parts) else "")
                         for n, part in enumerate(parts))
    made["msHalfCodes"] = codes(made.pop("msHalf"))
    made["msNoXpubsCodes"] = codes(made.pop("msNoXpubs"))
    made["msRefutedCodes"] = codes(made.pop("msRefuted"))
    legacy = made.pop("legacy")
    made["legacycodes"] = "\n".join("mark\ncamera qr %s" % part + ("\nexpect signer: BBQr part: %d of %d 15" % (n + 1, len(legacy)) if n + 1 < len(legacy) else "")
                                     for n, part in enumerate(legacy))
    made["backspaces"] = "\n".join(["key backspace"] * len("notakey"))
    with open(os.path.join(HERE, "signer.txt.in")) as f:
        text = f.read()
    text = re.sub(r"@(\w+)@", lambda m: made[m.group(1)], text)
    with open(os.path.join(ROOT, "tests", "signer.txt"), "w") as f:
        f.write(text)


if __name__ == "__main__":
    main()
