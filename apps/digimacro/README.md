# DigiMacro (experimental)

Configures a [DigiMacro](https://github.com/marcocarnut/DigiMacro) board, a
morse-tapped macro keyboard on a Digispark, plugged into GapKeep, as its
configuration page does: the macros, the power-on macro, the password, the
lockout, the board's clock for `{totp}`, a remote's buttons (`{IR}`), the
secrets' key, backups, and the hardened-mode checklist. TOTP keys come in
from QR codes: an authenticator's `otpauth://totp/...`, or Google
Authenticator's export (`otpauth-migration://offline?data=...`). What the
page puts in files (the secrets' key, a backup) goes out and comes back as
QR codes holding the same text.

Experimental ([docs/EXPERIMENTAL.md](../../docs/EXPERIMENTAL.md)): listed and
started only with `experimental = yes` in the card's `gapkeep.txt`, and only
then does GapKeep claim the board (`"usb": ["16c0:27db"]`): none of its
interfaces is a keyboard here while the app is installed.

## Using it

1. Plug the board in (through a hub if the keyboard needs the Zero's one
   port), and open DigiMacro.
2. Hold the pad for four seconds; type the board's password if it has one.
   The app reads the board.
3. **Macros**: a code (`.`, `-`, `.-`...) and what it types, in the page's
   syntax (`{Enter}`, `{Ctrl+c}`, `{pause 1.5}`, `{x3}`...). *The computer's
   keyboard* is the layout of the computer the board will type into. Errors
   show under their macro; **Write to the board** writes, then reads back and
   compares. If the window has shut by then (half a minute), hold the pad
   again when asked.
4. **Authenticator keys**: scan QR codes, then **Add {totp #N}** to a macro,
   and write. The board's `{totp}` is HMAC-SHA1, 6 digits, every 30 s: other
   accounts are listed but can't go in.
5. **A remote's button**: type `{IR}` in a macro where the button goes, then
   **Learn a remote's button** and press it on the remote within ten
   seconds: the first `{IR}` without a button gets it (`{IR 80 c5}`). The
   board types what it hears on its keyboard, which GapKeep reads for this
   app alone (gk:usb's `interruptIn()`), so no clipboard is needed. Needs a
   board with an IR receiver on P2.
6. **Secrets' key**: **Make a key** (GapKeep's random generator) writes its
   check value to the board and shows the key as a QR code: its text is the
   key file's line, `SERIAL hex`, for `~/.config/digimacro/host.key` on the
   computers the secrets play for (DigiMacro's `tools/hostauth`). Scanned
   back later, it opens the board's secrets here: `{secret}` and what
   follows it show as text, and are sealed again when written.
7. **Backup and restore**: **Save a backup as a QR code** reads the whole
   EEPROM and shows it as one QR code, in the page's backup format (JSON:
   encrypted with the board's password, scrypt and AES-256-GCM, or in the
   clear without one). Its text saved as `digimacro-SERIAL-DATE.backup` is
   what the page restores, and a page's backup shown as a QR code is what
   **Scan a backup** restores here: everything, the serial number
   included, the password last; then the board restarts.
8. **The board's clock**: GapKeep's time, after you confirm it is right.
   Refused if GapKeep's clock is not set (the Clock app sets it). The board
   keeps time only while powered: unplugged, it forgets it and `{totp}` types
   000000 until a computer sets it again. Setting it here helps only if the
   board stays powered on its way to the computer that uses it.

Keyboard: Tab and Shift+Tab move, Enter and Space press, Escape goes back to
the menu.

## Secrets

- TOTP keys never show: an imported one is `{totp #N}`, one read from the
  board `{totp ~N}` (its 40 bytes of HMAC midstates, as good as the key). Both
  are expanded only when the table is encoded.
- The secrets' key is in RAM only, while the board is plugged in, and shows
  only as the QR code asked for. A backup's QR code is the board itself:
  encrypted with its password if it has one, which a copy lets anyone guess
  at offline (a password under eight characters gets a warning first).
- Imported keys are in RAM only, never in the session store or on the card,
  and are wiped once written to the board (those not written, when the app
  ends). The password is kept while the board is plugged in, to unlock it
  again when the window lapses, and forgotten when it is unplugged.
- The log says what happened in counts and lengths: never a key, a password,
  a macro or a TOTP code.
- Without the key, macros with sealed secrets are kept and written back as
  they are, and a new `{secret}` is refused.
- Not here (use DigiMacro's page): firmware updates, and how long the board
  holds a key it was sent.

## Where the code comes from

DigiMacroAsm is the user's own project (GPL), not yet published; these copies
are on the `digimacro` branch only. `tools/extract_digimacro.py` makes
`vendor/` from it, byte for byte between a header and an export line;
`tools/extract_digimacro.py --check <DigiMacroAsm>` says whether they still
match (`tools/run_sim_tests.sh` runs it when the tree is there).

| File | From | SHA-256 of the source | SHA-256 here |
| --- | --- | --- | --- |
| `vendor/table.js` | DigiMacroAsm `web/table.js` (commit b37194a9) | `0a5462c27f92f5eaa1007613b8995ba289f1c7531e8027da93edf936c2b3f07b` | `1ca77debee01c360edbeae1f333225ba68613fa842e385df19e6153d94387965` |
| `vendor/coreupdate.js` | DigiMacroAsm `web/coreupdate.js` (commit b37194a9) | `5d246d82edce46c9bdff086e852bf01b376f7dace8544bf5374cc0ff08668e2b` | `296cbac657209a2bcfb6df7dd75063259a33800a753a8ceb97af8443a98c81e9` |
| `lib/parse.js` | GapKeep `apps/totp/lib/parse.js`, by `tools/share_libs.py` | | `ed08f6cad0e1719e165aa3ccfb81f4c3625549daa359cf1a7cc1d7c388dcbf4e` |
| `lib/backup.js` | DigiMacroAsm `web/backup.js`'s format, written again on gk:crypto (scrypt, AES-GCM); checked against it both ways by the tests | | |
| `lib/messages.js`, `lang/pt-BR.json` | the encoder's and the checklist's texts and their Portuguese, from DigiMacroAsm `web/i18n.js` (sha256 `3fd81270...0fc2`), adapted to gk:i18n's `{{ }}` | | |

`lib/board.js` (the protocol, on `vendor/coreupdate.js`'s `askOwn`) and
`lib/macros.js` (the editor's rows and tokens, on `vendor/table.js`) follow the
page's `web/index.html` (sha256 `9a60abc0...e417`): its gate, unlock, reads and
writes in 32-byte chunks with a read-back check, the lockout's bytes, and the
hardened-mode checklist.

## Tests

- `tests/digimacro/run_node.mjs` (Node): the copy of `table.js` against
  DigiMacroAsm's own, macro by macro, layout by layout, with random EEPROM
  images; the tokens; `lib/board.js` against a fake board; Google
  Authenticator exports, edge cases and 20,000 random and mutated ones;
  secrets sealed with a key and opened by the page's `table.js`; `{IR}`
  filled from the keyboard reports LEARN types; backups made and opened
  both here and by the page's `backup.js`, each opening the other's.
- `tests/digimacro.txt`, run by `tests/digimacro/run_softusb.sh`: the app
  against the real firmware 18, on a simulated Digispark (simavr-softusb)
  over USB/IP, keyboard only; then `tests/digimacro/check_board.py` taps the
  board's pad and checks that it types the macro written, with the right
  TOTP code for the time the app set. On the way: LEARN (the simulated
  board has no IR receiver: its keyboard endpoint is read, and nothing is
  heard), a key made and shown, a backup saved as a QR code. Skipped
  without simavr-softusb. Restoring is in the Node tests only: the
  scenario can't show the camera a backup whose salt is new each time.
