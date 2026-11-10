# Tests for the PSBT modules (lib/js/bitcoin/psbt)

    node --experimental-default-type=module tests/psbt/run_node.mjs [-v]

runs every module against `vectors.json`, with Node's SHA-256 and
RIPEMD-160 in place of `gk:crypto`'s (and once more without RIPEMD-160).
`tools/run_tests.sh` runs it as `psbt_node`. The simulator scenario is
`tests/signer_read.txt`.

## Where the vectors come from

`vectors.json` is made by `extract_vectors.py`, which reads the sources
below (BIPs as text, Electrum's tests as Python syntax trees: nothing of
them is run), and asks an installed Electrum what it makes of each PSBT
(txid, amounts, fee, output addresses), so the tests compare with Electrum
itself:

| Source | What | Licence |
| --- | --- | --- |
| [bitcoin/bips](https://github.com/bitcoin/bips) `bip-0173.mediawiki`, `bip-0350.mediawiki` | Bech32 / Bech32m strings and segwit addresses, valid and invalid | BSD-2-Clause |
| `bip-0174.mediawiki` | PSBT v0: invalid, valid, signer-check failures, the whole Creator-to-Extractor workflow | BSD-2-Clause |
| `bip-0370.mediawiki` | PSBT v2: invalid, valid, locktime determination | BSD-2-Clause |
| [spesmilo/electrum](https://github.com/spesmilo/electrum) `tests/test_psbt.py` | PSBTs, valid and invalid (mostly BIP-174's, in hex and Base64) | MIT |
| `tests/test_transaction.py` | 114 transactions with their txids; `tx_from_any` inputs in hex, Base64, Base43 and raw; addresses from scripts | MIT |
| `tests/test_bitcoin.py` | Base43, Base58, Base58Check; addresses to scripts | MIT |
| `tests/test_wallet_vertical.py` | Electrum's own QR texts (`to_qr_data()`) and PSBTs from its wallets | MIT |
| `electrum_made.json` | Made with Electrum by `make_electrum_psbts.py` (below) | ours |

Fetched on 2026-11-05: bitcoin/bips master (a0c977f3), Electrum
9242c50530473e3faf027d48fdd74e5101349dcd (version 4.8.3). The data are
test vectors, kept here as published (the BIPs' BSD-2-Clause and
Electrum's MIT licence allow it; Copyright (c) 2011-2024 The Electrum
developers).

## Electrum, in a throwaway virtualenv

`make_electrum_psbts.py` makes PSBTs the way Electrum's QR codes carry
them: P2WPKH with change, signed (a complete transaction), P2SH-P2WPKH,
P2PKH (the QR code drops the previous transaction), 2-of-3 P2WSH multisig
(as it comes, and with the global xpubs of "For hardware device; include xpubs"),
13 and 18 inputs (large codes), and mainnet with two payments. The wallets
come from the BIP-39 test mnemonics ("abandon ... about" and two others):
public, test coins only. Funding transactions are made up, as in
Electrum's own tests; nothing touches a network.

    python3 -m venv /tmp/el
    /tmp/el/bin/pip install cryptography \
        https://codeload.github.com/spesmilo/electrum/tar.gz/9242c50530473e3faf027d48fdd74e5101349dcd
    /tmp/el/bin/python tests/psbt/make_electrum_psbts.py
    /tmp/el/bin/python tests/psbt/extract_vectors.py BIPS_DIR ELECTRUM_TESTS_DIR --electrum
    python3 tests/psbt/make_scenario.py      # tests/signer_read.txt from signer_read.txt.in

(`BIPS_DIR`: the four .mediawiki files; `ELECTRUM_TESTS_DIR`: the four test
files, from the commits above.)

## What Electrum accepts from a QR code

Electrum's "Load transaction", "From QR code" (`read_tx_from_qrcode` in
`electrum/gui/qt/main_window.py`) treats `bitcoin:` and `channel_backup:`
texts apart, and gives anything else to `tx_from_any()`: whitespace
removed, then hex, else Base64 when it starts with `cHNidP`, else Base43
(up to 30000 characters), else an error; the bytes are a PSBT or a network
transaction. A signer answering Electrum should send Base43 (alphanumeric
QR mode); `lib/transport.js`'s `electrumQrText()` does, and falls back to
uppercase hex in the rare case that the Base43 text is itself valid hex
(Electrum would try hex first and misread it).
