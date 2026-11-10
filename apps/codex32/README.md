# codex32

Recombines [codex32](https://github.com/bitcoin/bips/blob/master/bip-0093.mediawiki)
(BIP-93) shares into the BIP-39 phrase they were split from, on an air-gapped
Pi Zero. A port of dice39's recombiner page, `codex32_recover.html`: dice39
(`apps/dice39`) splits a phrase into k-of-n shares; this app takes any k of
them back.

- **Type the shares**, one per box, or **scan them** (each share's QR code,
  as dice39 prints it). Case does not matter; spaces are ignored, so shares
  can be typed in groups of four as they are written. There are as many
  boxes as the first valid share's threshold asks for.
- **Each share is checked as it is typed**: the bech32 alphabet, the
  lengths BIP-93 allows (48, 54, 61, 67, 74 or 127 characters), the
  threshold, and the checksum. When the checksum fails because of one
  mistyped character, the app says which character and what it should
  probably be (BIP-93 recommends suggesting this; the app never applies it
  itself: you check it against the paper and retype it). The same for one
  character codex32 does not have (B, I, O, or 1 after the prefix). Shares
  of another split, or the same share twice, are flagged on the box.
- **Recover the phrase** shows what the page shows: the threshold,
  identifier and number of shares, the 12, 15, 18 or 24 words, the entropy in hex
  and the codex32 secret (index S), so it can be checked by hand.
- **Getting the phrase off**: as on the page, a QR code of the words (one,
  or three parts), SeedQR or Compact SeedQR, each behind its warning and a
  confirmation. One is on screen at a time; leaving the page removes it.
- **Clear** erases the shares and the result.

Everything works from the keyboard: Enter moves to the next box and, in the
last one, recovers; Tab reaches the buttons; Space ticks the confirmations;
Escape leaves the camera, the QR pages and About.

## Differences from the web page

- No clipboard (GapKeep has none), so no copy button.
- Languages are GapKeep's (`language` in `gapkeep.txt`, or the Settings
  app), not a button on the page. The Brazilian Portuguese catalog
  (`lang/pt-BR.json`) has the page's own Portuguese for its strings.
- One box per share instead of one text area, with the checks above as you
  type. The page only says "checksum failed".
- A single string with index S is accepted: an unshared secret (threshold
  0, like BIP-93's test vector 1), or a split's secret typed on its own.
  The page asks for at least two lines, and its `cxRecover` fails on such a
  string anyway (below).
- As on the page, only 16-, 20-, 24- and 32-byte secrets (12, 15, 18 and
  24 words) are recovered: dice39 makes no other sizes, and other valid
  BIP-93 secrets (28 or 64 bytes) are refused with the page's message
  rather than shown as words they are not.

## What the seed is

BIP-93 encodes a **BIP-32 master seed**. dice39 puts **BIP-39 entropy** in
the shares instead, and this app (like the page) turns it back into the
words. The two give different wallets: a wallet handed the entropy as a raw
BIP-32 seed opens a different, empty wallet. The words are what to restore
from. (This app does not show the master fingerprint or the xpub yet; dice39
and the Signer do. When it does, they come from the words' BIP-39 seed: see
`showKeys` in `main.js`.)

## For other apps: `lib/codex32.js`

A pure ES module (no `gk:*`, no globals, no logging), usable unchanged by
another app, e.g. a signer:

```js
import { recoverSeed, recover, checkShare, Codex32Error } from "./lib/codex32.js";

const seed = recoverSeed(["ms12namea320...", "ms12namecacd..."]);   // Uint8Array
// ... use it, then seed.fill(0)
```

- `recoverSeed(shares)`: the secret's bytes, or throws a `Codex32Error`
  (`code`, `message`, and `share`, `position`, `suggestion` where they
  apply). The bytes mean what the shares' maker put in them (above).
- `recover(shares)`: the same with the codex32 secret string, identifier,
  threshold and share indices.
- `checkShare(text)`: `{ ok, share }` or `{ ok: false, error }`, for
  checking a share as it is typed; `checkShareSet(parsed)` for a set.
- `findSubstitution(text)`: the one character that makes the checksum
  valid, if there is one.

It needs `vendor/codex32.js` beside it in `../vendor/`.

## Security notes

- **Nothing is kept**: the shares and the result are in the app's memory
  only, never in the session store (`gk:session`) or on the card. Leaving
  the app drops them; Clear erases them. The recovered seed is a
  `Uint8Array` overwritten with zeros on Clear, on Back, and before a new
  recovery. The words and the typed text are JavaScript strings, which
  cannot be overwritten; they are dropped and the garbage collector run.
- **The log never holds a share, the secret, the seed or a word**: it goes
  to the serial port in test builds. It says what happened, with counts and
  sizes: `codex32: recovered a 16-byte seed (12 words) from 2 shares`,
  `codex32: box 1 refused: checksum, a fix suggested`.
- The camera's picture never reaches the app, only the QR code's text.

## How it works

- `vendor/`: dice39's code, copied byte for byte from `codex32_recover.html`
  by `tools/extract_codex32.py` (with a checkout of
  [dice39](https://github.com/marcocarnut/dice39) in `../dice39`:
  `python3 tools/extract_codex32.py ../dice39/codex32_recover.html
  apps/codex32/vendor`): the codex32 block
  (`codex32.js`, the same code as in dice39's generator page), the BIP-39
  wordlist, and from the page's own script its strings, entropy to words
  and the SeedQR digits (`recover.js`). Each file names the source and its
  SHA-256. dice39 is AGPLv3 (`LICENSE-dice39.txt`).
- `lib/codex32.js`: checking and recombining shares, on the vendored code.
  The typo search uses the checksum's linearity over GF(32): the change one
  substituted symbol needs is computed for every position in one pass, in
  small numbers rather than BigInt.
- `lib/selftest.js` and `lib/vectors.js`: every BIP-93 test vector (8
  valid, with every k-subset of the shares vectors 2 and 3 give, the
  alternative encodings of vectors 3 and 4, and all 55 invalid strings, each
  with the error it must give), sets of shares, typo suggestions, and
  entropy to words. It runs at start, after the first screen, in small
  steps (about 2 s on a Pi Zero), and logs `codex32 selftest: N passed, 0
  failed`; Recover stays disabled until it has passed.
- `lib/strings.js`: the page's English strings with the HTML taken out, and
  a few replaced where they speak of a browser, translated through
  `gk:i18n`. `tests/codex32/run_node.mjs` checks that the page's are still
  its own, word for word.
- `lib/messages.js`: the errors of `lib/codex32.js` (English, for logs and
  Node) worded again through `gk:i18n`, from their codes and details; in
  English the same words (checked by `tests/codex32/run_node.mjs`).
- `lang/pt-BR.json`: the Brazilian Portuguese catalog.
- `main.js`: the screens.

## dice39's threshold-0 bug

dice39's `cxRecover` refuses every threshold-0 string (BIP-93 test vector
1) with "checksum failed": it interpolates even a single share, and with
one point the Lagrange weight is zero, so the result is all zeros. The
vendored copy is left as it is; `lib/codex32.js` decodes a single string
with index S directly (`cxDecode`, `cxSeedFromData`) instead of calling
`cxRecover`. `tests/codex32/run_node.mjs` says whether the vendored copy
still has the bug.

## Tests

- `node --experimental-default-type=module tests/codex32/run_node.mjs`:
  the self-test, every invalid vector through `recoverSeed`, and every
  single-character substitution in every valid vector's shares (about
  24,000), each of which must be refused and pointed at.
- `tests/codex32.txt` (simulator): typing with a typo, a share of another
  split, grouped shares, the QR exports, a letter codex32 lacks, vector 1,
  a 64-byte secret, and the camera (not a share, the same share twice,
  another split, then three shares). `tools/run_sim_tests.sh` runs it.
