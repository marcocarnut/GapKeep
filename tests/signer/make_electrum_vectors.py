#!/usr/bin/env python3
"""Electrum end to end, for tests/signer/run_node.mjs: makes PSBTs with
Electrum as its QR codes carry them, signs them with Electrum too (to compare
signatures byte for byte), then checks that Electrum accepts what the
signer library makes of them. Writes tests/signer/electrum.json.

Needs Electrum in a throwaway virtualenv (nothing system-wide), as
tests/psbt/README.md describes:

    python3 -m venv /tmp/el && /tmp/el/bin/pip install cryptography \\
        https://codeload.github.com/spesmilo/electrum/tar.gz/<commit>
    /tmp/el/bin/python tests/signer/make_electrum_vectors.py           # 1. make
    node --experimental-default-type=module tests/signer/run_node.mjs \\
        --electrum-out /tmp/signed.json                                 # 2. sign
    /tmp/el/bin/python tests/signer/make_electrum_vectors.py --check /tmp/signed.json   # 3. check

Step 3 loads each signed PSBT and each final transaction the way Electrum's
"Load transaction" does (tx_from_any on the QR text), checks every signature
with Electrum's own sighash code, that the PSBT is complete, and that
Electrum's finalized transaction is byte for byte ours; then stores what it
accepted in electrum.json, which run_node.mjs compares with from then on.

Wallets come from the public BIP-39 test mnemonic "abandon ... about"
(no real funds), funded by made-up transactions taken on trust, as in
tests/psbt/make_electrum_psbts.py. Electrum 4.8 has no taproot wallets, so
taproot is tested with BIP-341's and BIP-86's vectors instead.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import asyncio
import copy
import json
import os
import sys
import tempfile

from electrum import constants, keystore, util
from electrum.simple_config import SimpleConfig
from electrum.wallet_db import WalletDB
from electrum.wallet import Standard_Wallet
from electrum.transaction import Transaction, PartialTransaction, PartialTxOutput, tx_from_any
from electrum.address_synchronizer import TX_HEIGHT_UNCONFIRMED
from electrum.fee_policy import FixedFeePolicy
from electrum.bitcoin import address_to_script, base_encode
from electrum.version import ELECTRUM_VERSION

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "electrum.json")
MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
SEED = keystore.bip39_to_seed(MNEMONIC, passphrase="")


def new_wallet(config, ks):
    db = WalletDB('', storage=None, upgrade=True)
    db.put('keystore', ks.dump())
    db.put('gap_limit', 5)
    db.put('gap_limit_for_change', 3)
    w = Standard_Wallet(db, config=config)
    w.synchronize()
    return w


def seed_wallet(config, derivation, xtype):
    return new_wallet(config, keystore.from_bip43_rootseed(SEED, derivation=derivation, xtype=xtype))


def fund(wallets, amounts, salt):
    """A made-up transaction paying `amounts` to the first wallet's receiving
    addresses, given to every wallet (they share their addresses)."""
    addrs = wallets[0].get_receiving_addresses()
    raw = bytearray()
    raw += (2).to_bytes(4, 'little')
    raw += b'\x01' + bytes([salt] * 32) + (0).to_bytes(4, 'little') + b'\x00' + (0xfffffffd).to_bytes(4, 'little')
    raw += bytes([len(amounts)])
    for i, a in enumerate(amounts):
        spk = address_to_script(addrs[i % len(addrs)])
        raw += a.to_bytes(8, 'little') + bytes([len(spk)]) + spk
    raw += (0).to_bytes(4, 'little')
    for w in wallets:
        w.adb.receive_tx_callback(Transaction(raw.hex()), tx_height=TX_HEIGHT_UNCONFIRMED)


def paths(tx):
    return sorted({(fp.hex(), "/".join(str(p) for p in path))
                   for i in tx.inputs() for fp, path in i.bip32_paths.values()})


def case(name, network, note, maker, signer, outputs, fee, account, xpub, qr=True):
    """maker: the wallet that makes the PSBT; signer: a wallet with the keys
    (the same one, or the seed wallet behind a watch-only one)."""
    tx = maker.make_unsigned_transaction(outputs=outputs, fee_policy=FixedFeePolicy(fee), rbf=True)
    tx.locktime = 2_500_000 if network == "testnet" else 900_000
    if qr:
        text, _ = tx.to_qr_data()
    else:   # "Save to file" / "Copy to clipboard": previous transactions kept
        text = base_encode(tx.serialize_as_bytes(), base=43)
    loaded = tx_from_any(text)
    theirs = copy.deepcopy(loaded)
    signed = signer.sign_transaction(theirs, password=None)
    sigs = []
    if signed is not None:
        for txin in theirs.inputs():
            sigs.append({k.hex(): v.hex() for k, v in txin.sigs_ecdsa.items()})
    data = {"name": name, "network": network, "note": note, "qr": text, "account": account, "xpub": xpub,
            "derivations": paths(loaded), "electrum_sigs": sigs,
            "electrum_signed_qr": signed.to_qr_data()[0] if signed is not None else None,
            "electrum_final_tx": signed.serialize() if signed is not None and signed.is_complete() else None,
            "outputs": [{"address": o.address, "value": o.value, "mine": maker.is_mine(o.address),
                         "change": maker.is_change(o.address)} for o in loaded.outputs()]}
    return data


async def make():
    config = SimpleConfig({'electrum_path': tempfile.mkdtemp()})
    out = []

    constants.BitcoinTestnet.set_as_network()
    dest_t = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"   # BIP-173's test address
    pay = lambda addr, v: [PartialTxOutput.from_address_and_value(addr, v)]

    w = seed_wallet(config, "m/84'/1'/0'", "p2wpkh")
    fund([w], [1_000_000, 250_000], 11)
    out.append(case("testnet-p2wpkh-seed", "testnet", "BIP-39 seed wallet in Electrum, P2WPKH: two inputs, change",
                    w, w, pay(dest_t, 1_100_000), 1410, "m/84'/1'/0'", w.keystore.get_master_public_key()))

    w = seed_wallet(config, "m/49'/1'/0'", "p2wpkh-p2sh")
    fund([w], [400_000], 12)
    out.append(case("testnet-p2sh-p2wpkh-seed", "testnet", "BIP-39 seed wallet, P2SH-P2WPKH", w, w,
                    pay(dest_t, 150_000), 1660, "m/49'/1'/0'", w.keystore.get_master_public_key()))

    w = seed_wallet(config, "m/44'/1'/0'", "standard")
    fund([w], [300_000], 13)
    out.append(case("testnet-p2pkh-qr", "testnet",
                    "BIP-39 seed wallet, P2PKH, as its QR code: the previous transaction is left out, so no signing",
                    w, w, pay(dest_t, 100_000), 2260, "m/44'/1'/0'", w.keystore.get_master_public_key()))
    out.append(case("testnet-p2pkh-file", "testnet",
                    "the same as a file (Base43 here): the previous transaction is kept, so P2PKH can be signed",
                    w, w, pay(dest_t, 100_000), 2260, "m/44'/1'/0'", w.keystore.get_master_public_key(), qr=False))

    constants.BitcoinMainnet.set_as_network()
    dest_m = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"   # BIP-173's test address
    for der, xtype, salt, name in (("m/84'/0'/0'", "p2wpkh", 14, "mainnet-p2wpkh-watch-only"),
                                   ("m/49'/0'/0'", "p2wpkh-p2sh", 15, "mainnet-p2sh-p2wpkh-watch-only")):
        s = seed_wallet(config, der, xtype)
        xpub = s.keystore.get_master_public_key()      # zpub / ypub: what the signer exports
        watch = new_wallet(config, keystore.from_master_key(xpub))
        fund([watch, s], [5_000_000, 70_000, 3_000], salt)
        outputs = pay(dest_m, 1_234_567) + pay("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", 3_800_000)
        out.append(case(name, "mainnet", f"watch-only wallet from the account's {xpub[:4]} alone (no key origin): "
                        "Electrum names the account's own fingerprint and the path below it",
                        watch, s, outputs, 2820, der, xpub))
    return out


def save(data):
    with open(OUT, "w") as f:
        json.dump(data, f, indent=1)
        f.write("\n")


XTYPES = {"z": "p2wpkh", "v": "p2wpkh", "y": "p2wpkh-p2sh", "u": "p2wpkh-p2sh", "x": "standard", "t": "standard"}


def loading_wallet(config, c):
    """The wallet the person loads the signed PSBT into: the watch-only one,
    or the seed one (Electrum's dialog adds the wallet's information to it)."""
    if "watch-only" in c["name"]:
        return new_wallet(config, keystore.from_master_key(c["xpub"]))
    return seed_wallet(config, c["account"], XTYPES[c["xpub"][0]])


async def check(signed_file):
    """Electrum's verdict on what the signer made."""
    config = SimpleConfig({'electrum_path': tempfile.mkdtemp()})
    with open(OUT) as f:
        data = json.load(f)
    with open(signed_file) as f:
        ours = json.load(f)
    by_name = {c["name"]: c for c in data["cases"]}
    accepted, failures = {}, 0
    for name, r in ours.items():
        c = by_name[name]
        (constants.BitcoinMainnet if c["network"] == "mainnet" else constants.BitcoinTestnet).set_as_network()
        verdict = {"signed_qr": r["signed_qr"], "final_tx": r.get("final_tx")}
        tx = tx_from_any(r["signed_qr"])
        assert isinstance(tx, PartialTransaction), name
        tx.add_info_from_wallet(loading_wallet(config, c))
        n_sigs = 0
        for i, txin in enumerate(tx.inputs()):
            for pub, sig in txin.sigs_ecdsa.items():
                ok = tx.verify_sig_for_txin(txin_index=i, pubkey_bytes=pub, sig=sig)
                n_sigs += 1
                if not ok:
                    print("BAD SIGNATURE", name, i)
                    failures += 1
        verdict["signatures_verified"] = n_sigs
        verdict["complete"] = tx.is_complete()
        if r.get("final_tx"):
            final = tx_from_any(r["final_tx_qr"])
            assert not isinstance(final, PartialTransaction), name
            verdict["final_txid"] = final.txid()
            if not tx.is_complete() or tx.serialize() != r["final_tx"]:
                print("FINAL TX DIFFERS from Electrum's finalization", name)
                failures += 1
            if final.serialize() != r["final_tx"]:
                print("FINAL TX not read back", name)
                failures += 1
        accepted[name] = verdict
        print(name, "signatures verified:", n_sigs, "complete:", verdict["complete"], verdict.get("final_txid", ""))
    data["electrum_accepted"] = accepted
    save(data)
    return failures


if __name__ == "__main__":
    loop, stopping, thread = util.create_and_start_event_loop()   # Electrum's wallets need its loop
    try:
        if sys.argv[1:2] == ["--check"]:
            sys.exit(1 if asyncio.run_coroutine_threadsafe(check(sys.argv[2]), loop).result() else 0)
        cases = asyncio.run_coroutine_threadsafe(make(), loop).result()
    finally:
        loop.call_soon_threadsafe(stopping.set_result, 1)
        thread.join(5)
    save({"electrum_version": ELECTRUM_VERSION, "mnemonic": MNEMONIC, "cases": cases})
    for c in cases:
        print(c["name"], len(c["qr"]), "chars", c["derivations"][:2], "electrum signed:", bool(c["electrum_sigs"]))
