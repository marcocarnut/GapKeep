#!/usr/bin/env python3
"""Collects the test vectors for lib/js/bitcoin/psbt (tests/psbt/run_node.mjs)
into tests/psbt/vectors.json, from the sources in tests/psbt/README.md:

  BIP-173, BIP-350, BIP-174, BIP-370 (bitcoin/bips, the .mediawiki files)
  Electrum's tests (spesmilo/electrum, tests/*.py): read with Python's ast,
  never run.

and, with --electrum, Electrum itself (installed in a virtualenv) as an
oracle: for each PSBT and transaction, what Electrum says its txid, amounts,
fee and output addresses are, and the Base43 QR text it makes of it.

    python3 tests/psbt/extract_vectors.py BIPS_DIR ELECTRUM_TESTS_DIR [--electrum]

BIPS_DIR holds bip-0173.mediawiki ...; ELECTRUM_TESTS_DIR holds test_psbt.py,
test_transaction.py, test_bitcoin.py, test_wallet_vertical.py. The extra
vectors made by tests/psbt/make_electrum_psbts.py (electrum_made.json) are
merged in when present.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import ast
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def mediawiki_cases(path, start_marker):
    """(section heading, case name, hex) for each '* Case:' with a hex <pre>."""
    lines = open(path, encoding="utf-8").read().split("\n")
    i = next(k for k, l in enumerate(lines) if l.startswith(start_marker))
    out, section, case = [], None, None
    for l in lines[i:]:
        if l.startswith("==") and not l.startswith(start_marker):
            break
        m = re.match(r"\*\*? Bytes in Hex: <pre>([0-9a-f]+)</pre>", l)
        if m:
            out.append((section, case, m.group(1)))
            case = None
        elif l.startswith("* Case:"):
            case = l[len("* Case:"):].strip()
        elif l.strip() and not l.startswith("*"):
            section = l.strip()
    return out


def bip174(path):
    v = {"invalid": [], "valid": [], "signer_fails": [], "workflow": [], "extracted_tx": None}
    for section, case, hexdata in mediawiki_cases(path, "==Test Vectors=="):
        if section.startswith("The following are invalid"):
            v["invalid"].append({"name": case, "hex": hexdata})
        elif section.startswith("The following are valid"):
            v["valid"].append({"name": case, "hex": hexdata})
        elif section.startswith("Fails Signer checks"):
            v["signer_fails"].append({"name": case, "hex": hexdata})
        elif hexdata.startswith("70736274ff"):
            v["workflow"].append({"name": section[:80], "hex": hexdata})
        else:
            v["extracted_tx"] = hexdata
    return v


def bip370(path):
    v = {"invalid": [], "valid": [], "locktime": []}
    for section, case, hexdata in mediawiki_cases(path, "==Test Vectors=="):
        if section.startswith("The following are invalid"):
            v["invalid"].append({"name": case, "hex": hexdata})
        elif section.startswith("The following are valid"):
            v["valid"].append({"name": case, "hex": hexdata})
        else:
            m = re.search(r"computed to be (\d+)", section)
            v["locktime"].append({"name": case, "hex": hexdata, "locktime": int(m.group(1)) if m else None})
    return v


def tt_char(prefix):
    return {"0x20": " ", "0x7F": "\x7f", "0x80": "\x80", "0xFF": "\xff"}[prefix]


def bech32_vectors(path, title):
    """Valid strings, invalid strings, valid addresses (with scriptPubKey),
    invalid addresses, in the section `title`."""
    text = open(path, encoding="utf-8").read()
    text = text[text.index(title):]
    v = {"valid": [], "invalid": [], "valid_addresses": [], "invalid_addresses": []}
    mode = None
    for l in text.split("\n"):
        if "invalid segwit addresses" in l:
            mode = "invalid_addresses"
        elif "valid segwit addresses" in l:
            mode = "valid_addresses"
        elif "not valid" in l:
            mode = "invalid"
        elif "are valid" in l:
            mode = "valid"
        elif l.startswith("==") and mode == "invalid_addresses":
            break
        m = re.match(r"\* (?:(0x[0-9A-F]{2}) \+ )?<tt>([^<]*)</tt>(?: \+ (0x[0-9A-F]{2}))?(?::? ?<tt>([0-9a-f]+)</tt>)?", l)
        if not m or mode is None:
            continue
        s = (tt_char(m.group(1)) if m.group(1) else "") + m.group(2) + (tt_char(m.group(3)) if m.group(3) else "")
        if mode == "valid_addresses":
            v[mode].append({"address": s, "script": m.group(4)})
        else:
            v[mode].append(s)
    return v


# --- Electrum's tests, read as syntax trees -----------------------------------

def literal(node):
    """The value of a str/bytes literal, bytes.fromhex('..'), bfh('..'), or None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)):
        return node.value
    if isinstance(node, ast.Call) and len(node.args) == 1 and isinstance(node.args[0], ast.Constant):
        f = node.func
        name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
        if name in ("fromhex", "bfh"):
            return ("hex", node.args[0].value)
    return None


def functions(path):
    """(class name, class is TESTNET, function node) for each test method."""
    tree = ast.parse(open(path, encoding="utf-8").read())
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef):
            continue
        testnet = any(isinstance(s, ast.Assign) and any(getattr(t, "id", "") == "TESTNET" for t in s.targets)
                      and getattr(s.value, "value", False) for s in cls.body)
        for fn in cls.body:
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name.startswith("test"):
                yield cls.name, testnet, fn


def strings_in(fn):
    out = []
    for node in ast.walk(fn):
        v = literal(node)
        if v is not None:
            out.append(v)
    return out


def as_text(v):
    if isinstance(v, tuple):
        return v[1]
    return v.decode("ascii", "replace") if isinstance(v, bytes) else v


def electrum_psbt(path):
    """test_psbt.py: per test, the class (valid/invalid/...) and the PSBTs as
    hex or Base64 (both are the same PSBT in BIP-174's cases)."""
    out = []
    for cls, testnet, fn in functions(path):
        items = []
        for v in strings_in(fn):
            t = as_text(v)
            if t.startswith("70736274ff") or t.startswith("cHNidP"):
                items.append(t)
        if items:
            out.append({"class": cls, "test": fn.name, "psbts": items})
    return out


B43 = re.compile(r"^[0-9A-Z$*+\-./:]+$")
HEX = re.compile(r"^(?:[0-9a-f]{2})+$")


def electrum_transaction(path):
    v = {"txids": [], "tx_from_any": [], "address_from_script": []}
    for cls, testnet, fn in functions(path):
        src = strings_in(fn)
        if fn.name.startswith("test_txid_"):
            # raw_tx = '...'; txid = '...'
            texts = [as_text(s) for s in src]
            hexes = [t for t in texts if HEX.match(t)]
            if len(hexes) >= 2 and len(hexes[-1]) == 64:
                v["txids"].append({"test": fn.name, "hex": hexes[0], "txid": hexes[-1]})
        elif fn.name == "test_tx_from_any":
            for node in ast.walk(fn):
                if isinstance(node, ast.Dict):
                    for k, val in zip(node.keys, node.values):
                        if isinstance(val, ast.Call) and val.args:
                            raw = literal(val.args[0])
                            if raw is None:
                                continue
                            v["tx_from_any"].append({"name": k.value, "text": as_text(raw),
                                                     "binary": isinstance(raw, bytes) or isinstance(raw, tuple)})
        elif fn.name == "test_get_address_from_output_script":
            for node in ast.walk(fn):
                if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "assertEqual" and len(node.args) == 2:
                    want, call = node.args
                    if isinstance(call, ast.Call) and call.args and isinstance(call.args[0], ast.Constant):
                        v["address_from_script"].append({"script": call.args[0].value,
                                                         "address": want.value if isinstance(want, ast.Constant) else None})
    return v


def electrum_bitcoin(path):
    v = {"base43": [], "base58": [], "base58check": [], "addresses": []}
    for cls, testnet, fn in functions(path):
        texts = [as_text(s) for s in strings_in(fn)]
        if fn.name in ("test_base43", "test_base58", "test_base58check"):
            v[fn.name[5:]].append({"hex": texts[0], "encoded": texts[1]})
        elif fn.name == "test_address_to_script":
            for node in ast.walk(fn):
                if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "assertEqual" and len(node.args) == 2:
                    a, b = node.args
                    # address_to_script('addr'[, net=...]).hex() == 'script'
                    call = a.func.value if isinstance(a, ast.Call) and isinstance(a.func, ast.Attribute) else None
                    if isinstance(call, ast.Call) and getattr(call.func, "id", "") == "address_to_script":
                        net = "testnet" if any(k.arg == "net" for k in call.keywords) else "mainnet"
                        v["addresses"].append({"address": call.args[0].value, "script": b.value, "network": net})
    return v


def electrum_wallet_qr(path):
    """test_wallet_vertical.py: the QR texts Electrum's to_qr_data() made,
    and every PSBT in hex, with the network of their test class."""
    qr, psbts, seen = [], [], set()
    for cls, testnet, fn in functions(path):
        for v in strings_in(fn):
            t = as_text(v)
            if t in seen:
                continue
            if len(t) > 100 and B43.match(t) and not HEX.match(t):
                qr.append({"test": fn.name, "text": t, "network": "testnet" if testnet else "mainnet"})
                seen.add(t)
            elif t.startswith("70736274ff") and HEX.match(t):
                psbts.append({"test": fn.name, "hex": t, "network": "testnet" if testnet else "mainnet"})
                seen.add(t)
    return qr, psbts


# --- Electrum as the oracle ---------------------------------------------------

def oracle(vectors):
    from electrum import constants
    from electrum.transaction import tx_from_any, PartialTransaction
    from electrum.bitcoin import base_encode

    def facts(raw, network):
        (constants.BitcoinTestnet if network == "testnet" else constants.BitcoinMainnet).set_as_network()
        tx = tx_from_any(raw)
        f = {"txid": tx.txid(), "outputs": [{"address": o.address, "value": o.value} for o in tx.outputs()]}
        if isinstance(tx, PartialTransaction):
            f["input_value"] = tx.input_value() if all(i.value_sats() is not None for i in tx.inputs()) else None
            f["fee"] = tx.get_fee()
            f["qr"] = tx.to_qr_data()[0]
            f["inputs"] = [{"prevout": i.prevout.to_str(), "value": i.value_sats(), "address": i.address,
                            "fingerprints": sorted({fp.hex() for fp, _ in i.bip32_paths.values()})}
                           for i in tx.inputs()]
        else:
            f["qr"] = base_encode(tx.serialize_as_bytes(), base=43)
        return f

    for group in ("wallet_qr", "wallet_psbts"):
        for v in vectors["electrum"][group]:
            v["electrum"] = facts(v.get("text") or v["hex"], v["network"])
    for v in vectors["bip174"]["valid"] + vectors["bip174"]["workflow"]:
        try:
            v["electrum"] = facts(v["hex"], "testnet")
        except Exception as e:  # Electrum refuses some valid BIP-174 PSBTs (e.g. 0 inputs)
            v["electrum_refuses"] = repr(e)[:120]
    constants.BitcoinMainnet.set_as_network()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    bips, etests = args
    vectors = {
        "sources": {
            "bips": "https://github.com/bitcoin/bips (bip-0173, bip-0350, bip-0174, bip-0370 .mediawiki)",
            "electrum": "https://github.com/spesmilo/electrum tests/ (see README.md for the commit)",
        },
        "bip173": bech32_vectors(os.path.join(bips, "bip-0173.mediawiki"), "===Test vectors==="),
        "bip350": bech32_vectors(os.path.join(bips, "bip-0350.mediawiki"), "===Test vectors for Bech32m==="),
        "bip174": bip174(os.path.join(bips, "bip-0174.mediawiki")),
        "bip370": bip370(os.path.join(bips, "bip-0370.mediawiki")),
        "electrum": {
            "psbt": electrum_psbt(os.path.join(etests, "test_psbt.py")),
            "transaction": electrum_transaction(os.path.join(etests, "test_transaction.py")),
            "bitcoin": electrum_bitcoin(os.path.join(etests, "test_bitcoin.py")),
        },
    }
    qr, psbts = electrum_wallet_qr(os.path.join(etests, "test_wallet_vertical.py"))
    vectors["electrum"]["wallet_qr"] = qr
    vectors["electrum"]["wallet_psbts"] = psbts
    if "--electrum" in sys.argv:
        oracle(vectors)
    made = os.path.join(HERE, "electrum_made.json")
    if os.path.exists(made):
        vectors["electrum_made"] = json.load(open(made))
    out = os.path.join(HERE, "vectors.json")
    with open(out, "w") as f:
        json.dump(vectors, f, indent=1)
        f.write("\n")
    counts = {k: len(v) if isinstance(v, list) else {kk: len(vv) for kk, vv in v.items() if isinstance(vv, list)}
              for k, v in vectors.items() if k != "sources"}
    print(out, json.dumps(counts))


if __name__ == "__main__":
    main()
