# dice39 on zerogap

[dice39](https://bip39.postcogito.org) turns physical dice rolls into a
BIP-39 seed phrase: you supply most of the words with dice and a coin, the
device supplies the rest and the checksum, and you can see that every word
you typed was kept verbatim.

`vendor/` is dice39's own code, copied byte for byte from
`bip39_generator.html` by `tools/extract_dice39.py`. Each file names the
source and its SHA-256. To update, run:

    python3 tools/extract_dice39.py ../dice39/bip39_generator.html apps/dice39/vendor
    git diff apps/dice39/vendor

`lib/selftest.js` checks it against the BIP-39 and BIP-93 test vectors at
every start, and under Node (`node tests/dice39/run_node.mjs`).
`lib/cryptoshim.js` gives the browser code the two WebCrypto calls it uses,
backed by `zg:crypto`. `main.js` is the LVGL interface.

Not ported: printing the dice tables (print them from the web page on any
computer; they hold no secret), the clipboard export, importing an existing
phrase, the network probe (there is no network), and the Portuguese
translation.

dice39 is licensed under the GNU AGPL v3 (`LICENSE-dice39.txt`).
