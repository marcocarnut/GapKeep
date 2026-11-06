#!/usr/bin/env python3
"""Makes PSBTs and signed transactions with Electrum itself, as its QR codes
carry them (to_qr_data()), for tests/psbt/run_node.mjs and tests/signer_read.txt.
Writes tests/psbt/electrum_made.json; then run extract_vectors.py, which
merges it into vectors.json.

Needs Electrum, installed in a throwaway virtualenv (nothing system-wide):

    python3 -m venv /tmp/el && /tmp/el/bin/pip install cryptography \\
        https://codeload.github.com/spesmilo/electrum/tar.gz/<commit>
    /tmp/el/bin/python tests/psbt/make_electrum_psbts.py

Wallets come from the BIP-39 test mnemonic "abandon ... about" (public; no
real funds), funded by made-up transactions the wallets take on trust (as
Electrum's own tests do), so every value here is reproducible.
"""
import asyncio
import json
import os
import tempfile

from electrum import constants, keystore, util
from electrum.simple_config import SimpleConfig
from electrum.wallet_db import WalletDB
from electrum.wallet import Standard_Wallet, Multisig_Wallet
from electrum.transaction import Transaction, PartialTxOutput, TxOutput, tx_from_any
from electrum.address_synchronizer import TX_HEIGHT_UNCONFIRMED
from electrum.fee_policy import FixedFeePolicy
from electrum.bitcoin import address_to_script
from electrum.version import ELECTRUM_VERSION

HERE = os.path.dirname(os.path.abspath(__file__))
MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
SEED = keystore.bip39_to_seed(MNEMONIC, passphrase="")
SEED2 = keystore.bip39_to_seed("legal winner thank year wave sausage worth useful legal winner thank yellow", passphrase="")
SEED3 = keystore.bip39_to_seed("letter advice cage absurd amount doctor acoustic avoid letter advice cage above", passphrase="")


def standard_wallet(config, derivation, xtype, seed=SEED):
    db = WalletDB('', storage=None, upgrade=True)
    db.put('keystore', keystore.from_bip43_rootseed(seed, derivation=derivation, xtype=xtype).dump())
    db.put('gap_limit', 5)
    db.put('gap_limit_for_change', 3)
    w = Standard_Wallet(db, config=config)
    w.synchronize()
    return w


def multisig_wallet(config, xtype):
    db = WalletDB('', storage=None, upgrade=False)
    der = "m/48'/1'/0'/2'" if xtype == "p2wsh" else "m/48'/1'/0'/1'"
    for i, seed in enumerate((SEED, SEED2, SEED3)):
        db.put('x%d' % (i + 1), keystore.from_bip43_rootseed(seed, derivation=der, xtype=xtype).dump())
    db.put('wallet_type', '2of3')
    db.put('gap_limit', 5)
    db.put('gap_limit_for_change', 3)
    w = Multisig_Wallet(db, config=config)
    w.synchronize()
    return w


def fund(wallet, amounts, salt):
    """A made-up transaction paying `amounts` to the wallet's receiving
    addresses (one input from nowhere; never broadcast)."""
    addrs = wallet.get_receiving_addresses()
    raw = bytearray()
    raw += (2).to_bytes(4, 'little')
    raw += b'\x01' + bytes([salt] * 32) + (0).to_bytes(4, 'little') + b'\x00' + (0xfffffffd).to_bytes(4, 'little')
    raw += bytes([len(amounts)])
    for i, a in enumerate(amounts):
        spk = address_to_script(addrs[i % len(addrs)])
        raw += a.to_bytes(8, 'little') + bytes([len(spk)]) + spk
    raw += (0).to_bytes(4, 'little')
    tx = Transaction(raw.hex())
    wallet.adb.receive_tx_callback(tx, tx_height=TX_HEIGHT_UNCONFIRMED)
    return tx


def describe(wallet, tx, name, network, note):
    qr, _ = tx.to_qr_data()   # its is_complete is False for any PartialTransaction, even signed
    data = {"name": name, "network": network, "note": note, "qr": qr, "complete": tx.is_complete()}
    if not tx.is_complete():
        data["psbt_hex"] = tx.serialize_as_bytes().hex()
        back = tx_from_any(qr)
        data["fee"] = back.get_fee()
        data["input_value"] = back.input_value()
        data["outputs"] = [{"address": o.address, "value": o.value,
                            "change": wallet.is_change(o.address), "mine": wallet.is_mine(o.address)}
                           for o in back.outputs()]
        data["txid"] = back.txid()
        data["estimated_vsize"] = tx.estimated_size()
        data["fingerprints"] = sorted({fp.hex() for i in back.inputs() for fp, _ in i.bip32_paths.values()})
    else:
        data["tx_hex"] = tx.serialize()
        data["txid"] = tx.txid()
    return data


async def make():
    tmp = tempfile.mkdtemp()
    config = SimpleConfig({'electrum_path': tmp})
    out = []

    constants.BitcoinTestnet.set_as_network()
    dest_t = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"   # BIP-173's test address

    w = standard_wallet(config, "m/84'/1'/0'", "p2wpkh")
    fund(w, [1_000_000, 250_000], 1)
    outputs = [PartialTxOutput.from_address_and_value(dest_t, 600_000)]
    tx = w.make_unsigned_transaction(outputs=outputs, fee_policy=FixedFeePolicy(1410), rbf=True)
    tx.locktime = 2_500_000
    out.append(describe(w, tx, "testnet-p2wpkh-change", "testnet", "P2WPKH wallet: one payment, change back"))
    w.sign_transaction(tx, password=None)
    out.append(describe(w, tx, "testnet-p2wpkh-signed", "testnet", "the same, signed by Electrum: a complete transaction"))

    w = standard_wallet(config, "m/49'/1'/0'", "p2wpkh-p2sh")
    fund(w, [400_000], 2)
    tx = w.make_unsigned_transaction(outputs=[PartialTxOutput.from_address_and_value(dest_t, 150_000)],
                                     fee_policy=FixedFeePolicy(1660), rbf=True)
    tx.locktime = 2_500_000
    out.append(describe(w, tx, "testnet-p2sh-p2wpkh", "testnet", "P2SH-P2WPKH wallet"))

    w = standard_wallet(config, "m/44'/1'/0'", "standard")
    fund(w, [300_000], 3)
    tx = w.make_unsigned_transaction(outputs=[PartialTxOutput.from_address_and_value(dest_t, 100_000)],
                                     fee_policy=FixedFeePolicy(2260), rbf=True)
    tx.locktime = 2_500_000
    out.append(describe(w, tx, "testnet-p2pkh", "testnet",
                        "P2PKH wallet: the QR code has the spent output only, not the previous transaction"))

    w = multisig_wallet(config, "p2wsh")
    fund(w, [800_000], 4)
    tx = w.make_unsigned_transaction(outputs=[PartialTxOutput.from_address_and_value(dest_t, 300_000)],
                                     fee_policy=FixedFeePolicy(2000), rbf=True)
    tx.locktime = 2_500_000
    out.append(describe(w, tx, "testnet-2of3-p2wsh", "testnet", "2-of-3 P2WSH multisig"))

    # many inputs: near the largest QR code Electrum makes (alphanumeric mode,
    # 4296 characters), for timing Base43; and one the simulator's camera can
    # show (it encodes in byte mode: 2953 at most)
    for n, name, amount, salt in ((18, "testnet-many-inputs", 170_000, 5), (13, "testnet-13-inputs", 120_000, 7)):
        w = standard_wallet(config, "m/84'/1'/0'", "p2wpkh")
        fund(w, [10_000 + i for i in range(n)], salt)
        tx = w.make_unsigned_transaction(outputs=[PartialTxOutput.from_address_and_value(dest_t, amount)],
                                         fee_policy=FixedFeePolicy(3000), rbf=True)
        tx.locktime = 2_500_000
        out.append(describe(w, tx, name, "testnet", f"{n} small inputs: a large QR code"))

    constants.BitcoinMainnet.set_as_network()
    dest_m = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"   # BIP-173's test address
    w = standard_wallet(config, "m/84'/0'/0'", "p2wpkh")
    fund(w, [5_000_000], 6)
    tx = w.make_unsigned_transaction(
        outputs=[PartialTxOutput.from_address_and_value(dest_m, 1_234_567),
                 PartialTxOutput.from_address_and_value("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", 200_000)],
        fee_policy=FixedFeePolicy(2820), rbf=True)
    tx.locktime = 900_000
    out.append(describe(w, tx, "mainnet-p2wpkh-two-payments", "mainnet", "mainnet P2WPKH: two payments and change"))

    with open(os.path.join(HERE, "electrum_made.json"), "w") as f:
        json.dump({"electrum_version": ELECTRUM_VERSION,
                   "made": out}, f, indent=1)
        f.write("\n")
    for d in out:
        print(d["name"], len(d["qr"]), "chars", d.get("fee"), d.get("estimated_vsize"))


if __name__ == "__main__":
    loop, stopping, thread = util.create_and_start_event_loop()   # Electrum's wallets need its loop
    try:
        asyncio.run_coroutine_threadsafe(make(), loop).result()
    finally:
        loop.call_soon_threadsafe(stopping.set_result, 1)
        thread.join(5)
