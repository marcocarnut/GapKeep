# PSBT Viewer

Shows what a Bitcoin transaction made in [Electrum](https://electrum.org)
does, before anyone signs it: read from Electrum's QR code with the camera,
it lists what the transaction spends, where the money goes, which outputs
come back to the same wallet (change), the fee and fee rate, and what to be
careful about. It signs nothing: it is the first step towards an app that
signs Electrum's transactions, and its decoding (`lib/`) is what that app
will use.

In Electrum: make the transaction (Send, then Preview / Advanced), then in
the transaction window choose **Export** (or Share), **Show as QR code**.
Start "Scan QR code" here and show it to the camera.

## The screen

- **Totals first**: what is sent to others, the change back to your wallet,
  the fee (and sat/vB), what is spent, and the network.
- **Warnings**, red (don't sign), amber (check), blue (to know).
- **Outputs**: each address (grouped by four characters, to compare with
  the receiver's) and amount; change is green, with its key path.
- **Inputs**: the coin spent, its amount, type, key path and wallet
  fingerprint, and how far it is signed.
- **Details**: the transaction ID (when signing can't change it), version,
  locktime, RBF, size.

Keyboard: Tab and Shift+Tab go through the buttons and the rows, the arrows
(and Page Up/Down) through the rows; Enter on a row shows all of it (full
address, script, key paths); Escape leaves the scanner, or goes back to the
start. "Network" changes the network the addresses are shown for: a PSBT
doesn't say it, so it is guessed from the key paths (`m/84'/1'/...` is a
test network) and xpubs. Testnet and signet addresses are the same; regtest
must be chosen by hand.

## What it reads

What Electrum's "Load transaction / From QR code" reads (`tx_from_any()`
in `electrum/transaction.py`), in the same order: the text without
whitespace, as **hex**, else **Base64** if it starts with `cHNidP`, else
**Base43** (Electrum's QR form, at most 30000 characters); the bytes are a
**PSBT** (version 0, BIP-174, or version 2, BIP-370) or a **signed
transaction** (shown too: no fee, as it doesn't say what its coins were
worth). Payment requests (`bitcoin:`), UR and BBQr codes, and Electrum's
pre-4.0 format are refused with a message saying so; so is anything
malformed or truncated, with what is wrong.

## What it checks

- The amounts: the input total, outputs, fee (refused as invalid if
  negative; a warning when over 500 sat/vB or 10% of what is spent).
- **Change** is an output with a BIP-32 key from a wallet (master
  fingerprint) that also signs the inputs, and whose script pays to that
  key: P2WPKH and P2PKH by RIPEMD-160 (`zg:crypto`'s `ripemd160` when the
  system has it; without it the check is skipped and the screen says so),
  P2SH by its redeemScript, P2WSH multisig by its witnessScript. An output
  claiming a wallet key but paying elsewhere is flagged red and counted as
  someone else's. Taproot keys are not checked (that needs the key tweak).
- Each input's previous transaction against its txid, and against its
  witness UTXO; redeemScripts and witnessScripts against their scripts.
- **Electrum's QR codes leave out the previous transactions**
  (`convert_all_utxos_to_witness_utxos()`, to make the code fit). For
  segwit v0 inputs the amounts are then the PSBT's word: a signature covers
  its own input's amount only, so two signatures of differently-described
  versions can make a transaction with a much larger fee. Shown (blue) when
  there are several inputs. For non-segwit inputs the amount can't be
  checked at all, and a signer needs the previous transaction (amber).
- Inputs with no key origin, inputs from different wallets, non-ALL
  sighash types, dust and OP_RETURN outputs, unmeetable locktimes.

The size and fee rate are estimated for the signed transaction as Electrum
does (72-byte signatures): the same vsize as Electrum for every test PSBT.

## Speed

Electrum's Base43 decoding is quadratic; here it splits the number in
halves and lets QuickJS's BigInt do the work. In the simulator, decoding
the largest test code (3823 characters, 2593 bytes, 18 inputs) takes about
1 ms, encoding it 6 ms and analysing it 2 ms; the simulator estimates a
Pi Zero at some 40 times that (under half a second for all of it).

## Tests

- `node --experimental-default-type=module tests/psbt/run_node.mjs`: the
  `lib/` modules against BIP-173/350/174/370 vectors, Electrum's own test
  data and PSBTs made by Electrum (sources: `tests/psbt/README.md`).
- `tests/psbtview.txt` (simulator): Electrum's QR codes through the
  simulated camera.
