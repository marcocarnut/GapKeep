# Authenticator

Time-based one-time codes (TOTP, [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)),
the six- or eight-digit codes that Google Authenticator, Aegis and the like
show for two-factor sign-in, on an air-gapped Pi Zero.

- **Add an account** by showing its QR code to the camera ("Scan QR code"),
  or by typing its key ("Type a key"): Base32, with an issuer and an account
  name, and the algorithm, digits and period if the service uses other
  than the usual SHA1, 6 and 30 s.
- **Read the codes**: each account shows its issuer and name, the current
  code grouped for reading (`123 456`, `1234 5678`), and the seconds left
  until the next one. Enter on an account shows its settings and a key
  fingerprint, and can remove it.
- **Forget all** clears every account.

Everything works from the keyboard: Tab between the buttons and the
accounts, Enter to use them, Escape to leave the scanner or the form.

## The clock

TOTP codes are computed from the time (UTC: the time zone doesn't matter).
A Pi Zero has no battery-backed clock: after each boot the time must be
set, in the Clock app. Until it is, the Authenticator shows no codes (they
would be wrong) and says so. It shows the time it uses (UTC) at the top
right: compare it with a watch. A clock that is more than a few seconds
off gives codes that services refuse near the end of each period.

## Formats

**`otpauth://totp/LABEL?secret=...`**, Google's
[Key Uri Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format),
what sign-up pages show:

| Part | |
| --- | --- |
| `LABEL` | `Issuer:account` or `account`, %-encoded; spaces after the colon are ignored. |
| `secret` | The key, Base32 (RFC 4648): case-insensitive, padding optional, spaces ignored. Required. |
| `issuer` | Wins over the label's prefix when both are given. `+` is a space here (as Android reads it), but a `+` in the label stays a plus (`alice+work@example.com`). |
| `algorithm` | `SHA1` (default), `SHA256` or `SHA512`. |
| `digits` | `6` (default) or `8`. |
| `period` | Seconds, 1 to 86400 (default 30). |

Other parameters (`image`, ...) are ignored. Refused, with the reason on
screen: `otpauth://hotp/` (counter-based codes), a missing or broken secret,
other algorithms or digit counts, a parameter given twice, broken
%-escapes.

**`otpauth-migration://offline?data=...`**, Google Authenticator's
"Transfer accounts" export: Base64 of a protocol buffer holding several
accounts, split over several QR codes when there are many. Show the parts in
any order: the app says which are still missing, and skips accounts it has
already. The export has no period (always 30 s); HOTP and MD5 accounts in it
are skipped, with a note. Google doesn't document the format; the field
numbers are those of the reverse-engineered
[`migration.proto` of dim13/otpauth](https://github.com/dim13/otpauth/blob/master/migration/migration.proto),
which the other open decoders agree with. The decoder (`lib/parse.js`) is
written by hand, with every length checked against the data.

Typed keys must be at least 16 Base32 characters (80 bits): fewer is almost
always a key typed in part. A length no whole number of bytes gives (1, 3 or
6 characters past a multiple of 8) is refused as a typo; bits left over after
the last whole byte are ignored, as other authenticators do.

## Security notes

- **Nothing is written to the card.** zerogap never writes to the SD card.
  The accounts are kept in RAM, in the app's session store
  ([`gk:session`](../../docs/API.md#gksession)): they are still there when
  you come back after using other apps, and gone when you switch off. No
  other app can read them. **Your QR codes (or keys) are the backup**: keep
  them, on paper, somewhere safe. Anyone who has them can make your codes.
- Each account's key is kept (in the app, and in the session store, to
  outlive the app), with a fingerprint (SHA-256 of the settings and key, cut
  to 64 bits, shown in the account's details) to recognise the same key
  scanned twice. Remove and Forget all overwrite the key, in the app and in
  the session store; switching off forgets everything.
- **The log never holds a key or a code.** It goes to the serial port in
  test builds. For the tests, each code is logged as a tag: the first 64
  bits of an HMAC of the code under the account's own key, which only
  someone holding the key can check (a plain hash of a 6-digit code would
  give the code away: there are only a million to try). Messages about
  refused codes never quote the key.
- The camera's picture never reaches the app: it gets the QR code's text
  only ([CAMERA.md](../../docs/CAMERA.md)).
- Codes are on screen while the app is open: leave it when you are done.

## How it works

- `lib/hotp.js`: HOTP (RFC 4226) and TOTP (RFC 6238), on gk:crypto's HMAC
  (native: SHA-1, SHA-256 and SHA-512 in the kernel).
- `lib/parse.js`: Base32, Base64, UTF-8, the two URI formats and the
  protocol buffer.
- `lib/selftest.js`: the RFC 4226 HOTP vectors, the RFC 6238 TOTP vectors
  for all three hashes, HMAC with keys longer than a block (RFC 2202, RFC
  4231), the RFC 4648 Base32 vectors, and the parsers on good and bad
  input. It runs at start, after the first screen is up, in small steps, and logs
  `totp selftest: N passed, 0 failed`; if anything fails, no codes are
  shown. Under Node, with Node's HMAC:
  `node --experimental-default-type=module tests/totp/run_node.mjs`.
- `main.js`: the screens, and the accounts saved to the session store
  after each change (restored at start). `gk:clock`'s `every(1, ...)` ticks on each
  second: it moves the countdowns, and computes an account's code only when
  its period turns; when the clock is set or changed, every code is
  recomputed at once.

Tests: `tests/totp.txt` (simulator, test build), with
`tests/apps/clockset` setting the clock to an instant where RFC 6238's
vectors apply; `tests/totp/make_migration.py` makes the export QR codes.
