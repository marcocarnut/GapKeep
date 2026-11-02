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

**Device entropy** works as in dice39: the device words come from
`SHA256(32 random bytes ‖ entropy pad samples)`, and Generate stays
disabled until the entropy pad's bar is full (128 bits at 24 words, 64 at
12). The accounting constants are dice39's own (`vendor/dice.js`); the rules
are in `lib/entropypad.js`. A mouse press scores 4 bits and a drag point 1,
and only drags that really moved count. Two additions:

- Without a mouse, Space or Enter on the focused pad is a press without a
  position and scores 3 bits, the clock part of a tap. Holding the key down
  counts once: zerogap never delivers auto-repeated Enter to widgets.
- The timing of every key pressed in the app is hashed in after the pad
  samples. It is not credited on the bar.

The 32 random bytes come from zerogap's hardware random generator
(`zg:crypto`, health-checked and SHA-256 conditioned) instead of
`crypto.getRandomValues`.

Not ported: printing the dice tables (print them from the web page on any
computer; they hold no secret), the clipboard export, importing an existing
phrase, the network probe (there is no network), and the Portuguese
translation.

dice39 is licensed under the GNU AGPL v3 (`LICENSE-dice39.txt`).
