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

Phrases of 24 (recommended), 18, 15 or 12 words, as on the page.

`lib/selftest.js` checks it against the BIP-39, BIP-84 and BIP-93 test vectors at
every start, and under Node (`node tests/dice39/run_node.mjs`). On the Pi
Zero it takes about two seconds, so it runs after the start page is up,
in steps that leave the screen responsive; Enter my dice words and I
already have a seed phrase stay disabled until it has passed.

The launcher icon is the favicon of `bip39_generator.html`, converted with
`python3 tools/make_icon.py favicon.png --manifest apps/dice39/manifest.json`.
`lib/cryptoshim.js` gives the browser code the two WebCrypto calls it uses,
backed by `zg:crypto`. `main.js` is the LVGL interface.

**Device entropy** works as in dice39: the device words come from
`SHA256(32 random bytes ‖ entropy pad samples)`, and Generate stays
disabled until the entropy pad's bar is full (128 bits at 24 words, 96 at
18 and 15, 64 at 12). The accounting constants are dice39's own (`vendor/dice.js`); the rules
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

**A phrase you already have** ("I already have a seed phrase"; the page's
import mode, a start of its own here): all the words typed, checked by
dice39's `importMnemonic`, which refuses a bad checksum (shown as a likely
typo) and never corrects it. Nothing is generated and there is no entropy
pad: this splits an existing key. dice39's warning for a phrase in wordlist
order or of one repeated word (a published example) is shown; the dice
warnings are not, as no dice were thrown.

**The result page** shows the words and the warnings. That every typed word
came back unchanged is still checked, but only a failure is shown (in red);
the page's table of each typed word against the output is gone.

**The account's public key** (not on dice39's page): the BIP-84 native
segwit account `m/84'/0'/N'` on mainnet, as an output descriptor
(`wpkh([fingerprint/84h/0h/Nh]xpub.../<0;1>/*)#checksum`) or a zpub (for
Electrum), one QR code at a time with its text (a dropdown picks which;
the descriptor first), and the master fingerprint. Account 0 and no
passphrase at first; the account number and the BIP-39 passphrase can be
changed, and Enter derives the key again (PBKDF2 of 2048 rounds: about
0.1 s on a Pi Zero, with "Working" on screen first). `lib/pubkey.js` does
it with the signer's `bip39.js`, `bip32.js` and `descriptor.js` (and
`crypto.js`, `psbt/bytes.js`, `psbt/basen.js`, `psbt/hashes.js`), copies
made by `tools/share_libs.py`: never edit them here. The log has the keys'
lengths, never the keys or the fingerprint.

**codex32 shares**: a share's QR code is shown directly, with one warning
line on its page (a share alone reveals nothing). The split stays while
the phrase does, so going back from a share's code shows the same shares.
The QR codes of the whole seed (SeedQR, Compact SeedQR, words) still ask
first.

Not ported: printing the dice tables (print them from the web page on any
computer; they hold no secret), the clipboard export, the network probe
(there is no network), and the Portuguese translation.

dice39 is licensed under the GNU AGPL v3 (`LICENSE-dice39.txt`).
