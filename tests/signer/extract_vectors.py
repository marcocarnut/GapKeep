#!/usr/bin/env python3
"""Reads the published test vectors the signer's tests use and writes
tests/signer/vectors.json (sources and versions: tests/signer/README.md).

    python3 tests/signer/extract_vectors.py SOURCES_DIR

SOURCES_DIR holds, as fetched (nothing in them is run):
    bip-0032.mediawiki bip-0049.mediawiki bip-0084.mediawiki
    bip-0086.mediawiki bip-0143.mediawiki       (bitcoin/bips)
    bip341-wallet.json      (bitcoin/bips bip-0341/wallet-test-vectors.json)
    trezor-vectors.json     (trezor/python-mnemonic vectors.json)
    slip-0132.md            (satoshilabs/slips)

SPDX-License-Identifier: GPL-3.0-or-later
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def text(d, name):
    with open(os.path.join(d, name), encoding="utf-8") as f:
        return f.read()


def bip32(d):
    t = text(d, "bip-0032.mediawiki")
    vectors = []
    for block in re.split(r"===Test vector \d===", t)[1:5]:
        seed = re.search(r"Seed \(hex\): ([0-9a-f]+)", block).group(1)
        chains = []
        for m in re.finditer(r"\* Chain (m[^\n]*)\n\*\* ext pub: (\w+)\n\*\* ext prv: (\w+)", block):
            path = re.sub(r"<sub>H</sub>", "'", m.group(1)).strip()
            chains.append({"path": path, "xpub": m.group(2), "xprv": m.group(3)})
        vectors.append({"seed": seed, "chains": chains})
    tv5 = re.split(r"===Test vector 5===", t)[1].split("==Acknowledgements==")[0]
    invalid = [{"key": m.group(1), "why": m.group(2)} for m in re.finditer(r"^\* (\w+) \((.*)\)?$", tv5, re.M)]
    for i in invalid:
        i["why"] = i["why"].rstrip(")")
    return {"valid": vectors, "invalid": invalid}


def kv(block):
    """'name = value' lines of a BIP's <pre> block, in order."""
    return [(m.group(1), m.group(2).strip()) for m in re.finditer(r"^\s*(\w+)\s*=\s*(.+?)\s*$", block, re.M)]


def bip84(d):
    t = text(d, "bip-0084.mediawiki").split("==Test vectors==")[1].split("</pre>")[0]
    pairs = kv(t)
    out = {"mnemonic": pairs[0][1], "rootpub": dict(pairs)["rootpub"], "account": "m/84'/0'/0'",
           "xpub": dict(pairs)["xpub"], "addresses": []}
    paths = re.findall(r"= (m/84'/0'/0'/\d/\d)", t)
    pubs = [v for k, v in pairs if k == "pubkey"]
    addrs = [v for k, v in pairs if k == "address"]
    for p, k, a in zip(paths, pubs, addrs):
        out["addresses"].append({"path": p, "pubkey": k, "address": a})
    return out


def bip49(d):
    t = text(d, "bip-0049.mediawiki").split("==Test vectors==")[1].split("</pre>")[0]
    v = dict(kv(t))
    return {"mnemonic": v["masterseedWords"], "account": "m/49'/1'/0'",
            "xpub": v["account0Xpub"].split()[0], "path": "m/49'/1'/0'/0/0",
            "pubkey": v["account0recvPublicKeyHex"][2:], "address": v["address"].split()[-2]}


def bip86(d):
    t = text(d, "bip-0086.mediawiki").split("==Test vectors==")[1].split("</pre>")[0]
    pairs = kv(t)
    v = dict(pairs)
    out = {"mnemonic": v["mnemonic"], "rootpub": v["rootpub"], "account": "m/86'/0'/0'", "xpub": [x for k, x in pairs if k == "xpub"][0], "addresses": []}
    paths = re.findall(r"= (m/86'/0'/0'/\d/\d)", t)
    cur = None
    for k, val in pairs:
        if k == "internal_key":
            cur = {"path": paths[len(out["addresses"])], "internal_key": val}
        elif cur is not None and k in ("output_key", "scriptPubKey", "address"):
            cur[k] = val
            if k == "address":
                out["addresses"].append(cur)
                cur = None
    return out


def bip143(d):
    t = text(d, "bip-0143.mediawiki")
    out = []
    for name in ("Native P2WPKH", "P2SH-P2WPKH"):
        s = t.split("=== %s ===" % name)[1].split("\n=== ")[0]
        unsigned = re.search(r"unsigned transaction:\s*([0-9a-f]+)", s).group(1)
        keys = re.findall(r"private key\s*: ([0-9a-f]{64})", s)
        script_code = re.search(r"scriptCode:\s*([0-9a-f]+)", s).group(1)
        amount = re.search(r"amount:\s*([0-9a-f]{16})", s).group(1)
        sighash = re.search(r"sigHash:\s*([0-9a-f]{64})", s).group(1)
        sig = re.search(r"signature:\s*([0-9a-f]+)", s).group(1)
        signed = re.search(r"serialized signed transaction is: ([0-9a-f]+)", s).group(1)
        spk = re.findall(r"scriptPubKey\s*: ([0-9a-f]+),? value: ([\d.]+)", s)
        out.append({"name": name, "unsigned": unsigned, "keys": keys, "scriptCode": script_code[2:],
                    "amount": int.from_bytes(bytes.fromhex(amount), "little"), "sighash": sighash,
                    "signature": sig, "signed": signed,
                    "spent": [{"script": a, "btc": b} for a, b in spk],
                    "input": 1 if name == "Native P2WPKH" else 0})
    return out


def bip341(d):
    v = json.loads(text(d, "bip341-wallet.json"))
    k = v["keyPathSpending"][0]
    return {"given": k["given"], "intermediary": k["intermediary"], "inputSpending": k["inputSpending"],
            "fullySignedTx": k["auxiliary"]["fullySignedTx"],
            "scriptPubKey": [{"internalPubkey": s["given"]["internalPubkey"],
                              "merkleRoot": s["intermediary"]["merkleRoot"],
                              "tweak": s["intermediary"]["tweak"],
                              "tweakedPubkey": s["intermediary"]["tweakedPubkey"]}
                             for s in v["scriptPubKey"]]}


def slip132(d):
    out = []
    for m in re.finditer(r"^Bitcoin(?: Testnet)?\s*\| `0x([0-9a-f]{8})` - `(\w+)` \| `0x([0-9a-f]{8})` - `(\w+)` \|", text(d, "slip-0132.md"), re.M):
        out.append({"pub": m.group(1), "pubName": m.group(2), "prv": m.group(3), "prvName": m.group(4)})
    return out


def main():
    d = sys.argv[1]
    trezor = json.loads(text(d, "trezor-vectors.json"))
    data = {
        "bip39_trezor": trezor["english"],
        "bip39_japanese": trezor["japanese"][:4],
        "bip32": bip32(d),
        "bip84": bip84(d),
        "bip49": bip49(d),
        "bip86": bip86(d),
        "bip143": bip143(d),
        "bip341": bip341(d),
        "slip132": slip132(d),
    }
    with open(os.path.join(HERE, "vectors.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote tests/signer/vectors.json:", {k: len(v) for k, v in data.items()})


if __name__ == "__main__":
    main()
