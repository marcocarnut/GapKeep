# dice39 on GapKeep

[dice39](https://bip39.postcogito.org) turns physical dice rolls into a
BIP-39 seed phrase: you supply most of the words with dice and a coin, the
device supplies the rest and the checksum, and you can see that every word
you typed was kept verbatim.

`vendor/` is dice39's own code, copied byte for byte from
`bip39_generator.html` by `tools/extract_dice39.py`. Each file names the
source and its SHA-256. To update, with a checkout of
[dice39](https://github.com/marcocarnut/dice39) in `../dice39`, run:

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
backed by `gk:crypto`. `main.js` is the LVGL interface.

**Device entropy** works as in dice39: the device words come from
`SHA256(32 random bytes ‖ entropy pad samples)`, and Generate stays
disabled until the entropy pad's bar is full (128 bits at 24 words, 96 at
18 and 15, 64 at 12). The accounting constants are dice39's own (`vendor/dice.js`); the rules
are in `lib/entropypad.js`. A mouse press scores 4 bits and a drag point 1,
and only drags that really moved count. Two additions:

- Without a mouse, any key typed on the focused pad (Space and Enter too;
  not Tab, Escape, the arrows or other navigation keys) is a press without
  a position and scores 3 bits, the clock part of a tap. Holding a key down
  counts once.
- The timing of every key pressed in the app is hashed in after the pad
  samples. It is not credited on the bar.

The 32 random bytes come from GapKeep's hardware random generator
(`gk:crypto`, health-checked and SHA-256 conditioned) instead of
`crypto.getRandomValues`.

**All the words from the dice** (not on dice39's page, which always has
the device supply the last two words): the entry page has a box for every
word, and besides dice39's range (12 to 22 at 24 words) takes all of them,
to split a phrase made entirely of your own throws. Nothing then comes from
the device and the entropy pad isn't needed. The first T-1 words, and the
last word's top bits (3 at 24 words), are used verbatim; if the checksum
doesn't match, its checksum bits are recomputed, so only the last word
changes (shown in amber, "checksum fixed", with the word typed named in
the summary). The status line says beforehand whether it will. dice39's
mistake detectors (one table, one word, wordlist order, sorted pairs) apply
as for dice words. `lib/fullphrase.js`; `tests/dice39_allwords.txt`.

**Where the tables come from**: the start page shows the address of
gapkeep.org's page for them (`/dice39.html`, `/pt-br/dice39.html` in
Portuguese), as text and as a QR code, to download them on any computer or
phone and print them: PDFs of dice39's own print-out, in English and
Portuguese, A4 and Letter.

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
it with `bip39.js`, `bip32.js` and `descriptor.js` (and `crypto.js`,
`psbt/bytes.js`, `psbt/basen.js`, `psbt/hashes.js`), copies from
`lib/js/bitcoin/` made by `tools/share_libs.py`: never edit them here. The log has the keys'
lengths, never the keys or the fingerprint.

**codex32 shares**: a share's QR code is shown directly, with one warning
line on its page (a share alone reveals nothing). The split stays while
the phrase does, so going back from a share's code shows the same shares.
The QR codes of the whole seed (SeedQR, Compact SeedQR, words) still ask
first.

**An e-paper panel** (GapKeep's `ui.epaper`, docs/EPAPER.md; the
`"epaper"` and `"camera"` permissions): with a panel configured, the split
page has **Panel only** (on by default) and **Write to e-paper**. In Panel
only the shares are never drawn on the screen: the split page says how
many were made, and the writing page says "Share 2 of 3 written to the
panel", nothing more. Each share goes on a panel of its own: a red "Share
2 of 3" (black on a black and white panel), "any 2 recover the phrase",
the share in groups of four in the panel's pixel font, and its QR code
(uppercase, ECC M, as on the screen). Then **Next share** (after swapping
the panel), **Write again**, **Check with the camera** (the panel's QR
code read back and compared with what was written: the result only; in
Panel only the camera's view is hidden too, as it would show the panel)
and **Back**. A write starts 2 seconds after the button (Cancel or Escape
stop it until then: once the panel's refresh command is sent, its
waveform must run to the end, about 18 s on the 2.9" B/W/R, with a
progress bar); one write runs at a time. The result page's **Write to
e-paper** does the same for the seed's QR codes (SeedQR, Compact SeedQR,
the words), with the numbered words beside the code, after a warning.
`lib/epaperlayout.js` lays the page out for the panel: landscape or
portrait, whichever keeps the QR code's modules at 3 px or more (2 at
least) and the text largest (`node tests/epaper/layout_node.mjs` checks
every panel model); `lib/epaper.js` is the page. Both are copied into
codex32 by `tools/share_libs.py`. The log says "wrote share 2 of 3" and
the layout, never what was written. Tests: `tests/epaper_shares.txt`
(simulator), `tests/epaper_shares_hw.txt` (the rig's panel and camera).

Not ported: printing the dice tables (above: download them, or print them
from the web page on any computer; they hold no secret), the clipboard export, the network probe
(there is no network), and the page's language button: languages are
GapKeep's (`language` in `gapkeep.txt`, or the Settings app). The Brazilian
Portuguese catalog (`lang/pt-BR.json`) follows the page's own Portuguese
where the text is the same.

dice39 is licensed under the GNU AGPL v3 (`LICENSE-dice39.txt`).
