# Tests for the Bitcoin library (lib/js/bitcoin) and the signer's own (apps/signer/lib)

    node --experimental-default-type=module tests/signer/run_node.mjs [-v]

runs BIP-39, BIP-32, the sighashes and PSBT signing against the vectors
below, with `crypto_ref.mjs` in place of `gk:crypto`: node:crypto's hashes,
HMAC and PBKDF2, and secp256k1 in BigInt, ported from the pure-Python
reference in `tools/check_secp.py` (RFC 6979 as libsecp256k1 applies it,
Bitcoin Core's low-R grinding, BIP-340, BIP-341's tweaks). The reference is
itself checked first against `src/crypto/secp_kat.h` (answers from the
kernel's libsecp256k1, one of them needing low-R grinding) and BIP-340's
vectors. Test-only: slow and not constant-time. `tools/run_tests.sh` runs
it as `signer_node`.

On the device, the app (or a gallery self-test) calls
`selfTest(crypto)` from `apps/signer/lib/selftest.js` (the signer's own) with `gk:crypto`:
four known answers through the real libsecp256k1.

## The scenario

`tests/signer.txt` is made from `tests/signer/signer.txt.in` by
`python3 tests/signer/make_scenario.py`: Electrum's codes, and PSBTs built in
`run_node.mjs` (`--made-out`) that a signer must not take at their word: change
rerouted to a path the wallet doesn't scan, and change paying an attacker's
key. Each step starts with `mark`: `expect` otherwise matches a line from
any earlier step.

## What is checked

- **reference**: `crypto_ref.mjs` against libsecp256k1's answers and BIP-340.
- **bip39**: the 24 English Trezor vectors (entropy, words, seed with
  passphrase "TREZOR", master xprv), 4 Japanese ones (NFKD of the words,
  ideographic spaces), the passphrase's NFKD, bad words and checksums.
- **bip32**: BIP-32 test vectors 1 to 4 (xpub and xprv of every chain,
  public derivation), every invalid key of test vector 5, paths.
- **slip132, bip84, bip49, bip86**: SLIP-132's version bytes; BIP-84's,
  BIP-49's and BIP-86's vectors (account xpubs, keys, addresses, taproot
  output keys) from the "abandon ... about" mnemonic.
- **bip143, legacy, bip341**: BIP-143's P2WPKH and P2SH-P2WPKH sighashes
  and signatures (byte for byte), its P2PK input's old signature against our
  legacy sighash, BIP-341's key-path vectors (every sigMsg, sighash, tweak
  and signature, all hash types).
- **bip174**: BIP-174's signer vector is 2-of-2 multisig, which the signer
  doesn't sign: our sighashes reproduce its signatures, and `signPsbt`
  skips both inputs saying why.
- **keys, keyring**: WIF and xprv parsing and refusals, wiping; an account
  xprv and WIF keys signing, byte for byte as the master; several keys.
- **descriptor**: BIP-380's checksum against Bitcoin Core's own test strings,
  valid and invalid, and BIP-380's vectors, in `descriptor_vectors.json`, which
  says where they come from; multipath against an independent Python
  implementation (`check_descriptor.py`), which also checks what the app
  shows, from its QR code. `tr()` as exported, against BIP-86's published
  addresses and BIP-386's key-path script.
- **codes**: BBQr read in any order, in each encoding; progress, other
  series, other file types, damaged and oversized files; what the signer
  shows. `check_bbqr.mjs` joins the series the app shows, from its screenshots,
  with `lib/js/bbqr.js`, and compares it with the SHA-256 the app logged.
- **p2pkh**: uncompressed keys, each signature checked with the reference on
  its own, and kept from segwit; legacy with other script types; a large
  PSBT through BBQr; forged previous transactions.
- **multisig**: BIP-143's and BIP-174's vectors; signing and finalizing,
  P2WSH and P2SH-P2WSH, the witness run as a node would (written here, from
  OP_CHECKMULTISIG's definition); refused scripts; proving change, and each
  attack on the proof (attack d: the keys of sortedmulti change out of
  order, from the security review's M3; plain multi's order of cosigners). The fixture with xpubs is made here, in Electrum's
  form, not by Electrum.
- **combine**: BIP-174's Combiner: merging, refusals, two signatures by a key.
- **review**: change claimed, proved, refuted, unverifiable and stray (each
  way of rerouting it, and the gap's limit), and far (the four indices around
  the two limits); why nothing can be signed.
- **rules, negative, change, oddities**: PSBTs built in the test for each
  input type, and each safety rule broken one at a time (fingerprint, key
  at the path, script, redeemScript, taproot tweak and script tree, missing
  amounts, previous transaction txid, sighash types, fake change outputs,
  odd paths). The segwit v0 fee attack as the security review's M2 showed it
  (two rounds, each with an amount understated, whose signatures pay the
  real fee together): red whenever it applies, and not for one input, for
  taproot, or with the previous transactions. Amounts over 21 million BTC;
  finalize refusing a held signature that doesn't verify.
- **electrum**: PSBTs from Electrum itself (`electrum.json`, below).

## Where the vectors come from

`vectors.json` is made by `extract_vectors.py SOURCES_DIR` from:

| Source | What | Licence |
| --- | --- | --- |
| [bitcoin/bips](https://github.com/bitcoin/bips) `bip-0032.mediawiki` | Test vectors 1-5 | BSD-2-Clause |
| `bip-0049.mediawiki`, `bip-0084.mediawiki`, `bip-0086.mediawiki` | Account keys and addresses of "abandon ... about" | public domain, CC0-1.0, BSD-2-Clause |
| `bip-0143.mediawiki` | Native P2WPKH and P2SH-P2WPKH examples | public domain |
| `bip-0341/wallet-test-vectors.json` | keyPathSpending, scriptPubKey tweaks | BSD-3-Clause (BIP-341's) |
| [trezor/python-mnemonic](https://github.com/trezor/python-mnemonic) `vectors.json` | BIP-39: English, Japanese (first 4) | MIT |
| [satoshilabs/slips](https://github.com/satoshilabs/slips) `slip-0132.md` | Version bytes | BSD-2-Clause |

Fetched on 2026-11-05 (bitcoin/bips master, as for tests/psbt). BIP-174's
vectors are read from `tests/psbt/vectors.json`, BIP-340's from
`tests/native/bip340-vectors.csv`.

## Electrum end to end

`electrum.json` is made by `make_electrum_vectors.py` with Electrum 4.8.3
(commit 9242c505, installed as in tests/psbt/README.md, in a throwaway
virtualenv). From "abandon ... about" (public; made-up funding
transactions, nothing touches a network):

| Case | |
| --- | --- |
| `testnet-p2wpkh-seed` | BIP-39 seed wallet in Electrum, two inputs and change |
| `testnet-p2sh-p2wpkh-seed` | the same, P2SH-P2WPKH |
| `testnet-p2pkh-qr` | P2PKH as a QR code: no previous transaction, so not signed |
| `testnet-p2pkh-file` | the same with previous transactions (Electrum's file export) |
| `mainnet-p2wpkh-watch-only` | watch-only wallet from the account zpub alone: Electrum writes the account's fingerprint and m/0/i |
| `mainnet-p2sh-p2wpkh-watch-only` | the same from a ypub |

For each, Electrum also signs the same PSBT with its seed wallet. The test
checks that our exported xpub is the one Electrum uses, that `plan` finds
the same change as Electrum's wallet, that our signatures are byte for byte
Electrum's (both deterministic: RFC 6979 with low-R grinding), and that our
final transaction is Electrum's.

Then Electrum checks ours:

    /tmp/el/bin/python tests/signer/make_electrum_vectors.py
    node --experimental-default-type=module tests/signer/run_node.mjs --electrum-out /tmp/signed.json
    /tmp/el/bin/python tests/signer/make_electrum_vectors.py --check /tmp/signed.json

`--check` loads each signed PSBT and each final transaction from their QR
text with `tx_from_any` (as "Load transaction" does), adds the wallet's
information (the watch-only wallet for the watch-only cases), verifies
every signature with Electrum's own sighash code, checks that the PSBT is
complete and that Electrum's finalized transaction is ours byte for byte,
and records what it accepted in `electrum.json`; `run_node.mjs` then
checks that it still makes exactly that.
