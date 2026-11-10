# JavaScript libraries for apps

Libraries written for no app in particular. Apps import only their own files
(docs/APPS.md), so an app that uses one carries a copy, made byte for byte by
`tools/share_libs.py` (add the copy to its `COPIES`); the copies are never
edited by hand. Each library is pure JavaScript with no dependencies: it runs
in GapKeep's QuickJS, in Node and in browsers, and other projects (the web
wallet) copy it the same way, with its commit and SHA-256.

| Library | What | Tests |
| --- | --- | --- |
| `bbqr.js` | BBQr: a file as a series of QR codes, as Coldcard and Sparrow use for PSBTs; with its own deflate (1 KiB window) and inflate | `tests/bbqr/run_node.mjs`, `tests/bbqr/check_capacity.py` (run by `tools/run_sim_tests.sh`) |
| `bitcoin/` | The Bitcoin protocol: BIP-39 (`bip39.js`, with `../vendor/wordlist.js`), BIP-32 (`bip32.js`), output descriptors (`descriptor.js`), sighashes and PSBT signing (`sighash.js`, `sign.js`, `multisig.js`, `combine.js`), private keys (`keys.js`), and `psbt/`: bytes, Base58/Base43 and Bech32, scripts and addresses, transactions, PSBTs (BIP-174, 370, 371) and their analysis. The cryptography (`gk:crypto`'s functions) is given with `crypto.js`'s `setCrypto()`. Errors and texts for people are `text.js` Messages: English, with the key and params for the app to translate. Copies go to an app's `lib/` (`psbt/` inside it), the wordlist to its `vendor/` | `tests/psbt/run_node.mjs`, `tests/signer/run_node.mjs` |

`vendor/wordlist.js` is the BIP-39 English wordlist as dice39 has it (its
home is `apps/codex32/vendor/`, extracted from dice39 by
`tools/extract_codex32.py`), here so that `bitcoin/bip39.js` finds it.
