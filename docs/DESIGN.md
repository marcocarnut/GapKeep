# GapKeep's design decisions

The decisions that shape GapKeep, and why they were made. How the pieces
work is in [ARCHITECTURE.md](ARCHITECTURE.md); how to write an app, in
[APPS.md](APPS.md). A change to one of these decisions belongs here too,
with its reason.

## Keys are not stored

GapKeep keeps nothing. A key is not stored on the device, encrypted or
otherwise: it exists elsewhere, usually on paper, as shares (for example
[codex32](https://github.com/bitcoin/bips/blob/master/bip-0093.mediawiki)
shares, which dice39 makes) or as seed words. When a task needs it, the
person brings the shares in, typed or shown to the camera as QR codes; they
are recombined in memory, used for that task, and forgotten: freed memory is
zeroed, and an app's memory is all freed when it exits.

**Why:** a device that holds a key must be guarded for as long as the key
is worth anything; a device that holds none can be lost, stolen or
inspected and reveals nothing. Shares on paper can be kept in different
places, and no single one of them is the key. What a person must keep safe
is then something they can see and count.

## Nothing leaves but the screen

- **The SD card is read-only.** GapKeep reads it once at boot, for the apps,
  `gapkeep.txt` and the data folders the apps list, through a FAT driver
  built without its write code, and never writes it. Settings changed while
  running last until power-off. A sealed build has no SD card code at all.
- **After startup the card can go, in every mode.** The card must be in at
  power-on, because the Pi's firmware loads `kernel.img` from it. Everything
  GapKeep needs from it is read during boot, and then it is unmounted:
  once the launcher is up, the card can be taken out and kept somewhere
  else, and nothing changes until power-off. Why: a card left in a device
  is a card someone can take, copy or swap, and a device that needs its card
  all the time ties the two together. It also makes what runs fixed: what
  was read and hashed at boot is all there is, whatever happens to the card.
  The cost is boot time and memory for the data folders (they are read
  whole, even if an app uses one file), so they have limits (32 MB in
  all). Anything that reads the card after boot is a bug, logged as an
  error and caught by `tests/card_removal.txt`.
- **Production builds never read the serial port.** They have no serial
  driver: the UART is never set up and its pins are inputs. Test builds log
  to it and take test commands from it, by design, so tests can drive real
  hardware; no app logs a secret, since a test build's log leaves the
  device.
- **No network, no radio.** The plain Pi Zero has none, and GapKeep has no
  network stack. The USB drivers are cut down to hubs, keyboards and mice,
  and the devices apps name (below).

**Why:** an air gap is only as good as its narrowest channel. Everything
that leaves the device does so on the screen, as text a person reads or as
QR codes another device's camera reads, where the person can see it go.

## USB devices for apps

Some apps must talk to a device: configuring a macro keyboard is the first.
They get it through `gk:usb` ([APPS.md](APPS.md#usb-devices)), narrowly:

- **The app names the device**, by vendor and product id in its manifest,
  which its hash covers. Nothing else is reachable: no class of devices, no
  "any device".
- **A named device is claimed whole**, from the moment it is plugged in,
  while an available app names it: none of its interfaces gets a system
  driver. Such devices are often keyboards themselves; the alternatives,
  letting its keyboard type while the app configures it, or binding its
  keyboard and taking the rest, would let the device type into the system
  that is setting it up. Ignoring it costs nothing: the person types on
  their keyboard. The price is that an app naming a keyboard's ids takes
  that keyboard away, so the launcher shows the ids an app takes.
- **Control transfers on endpoint 0, at most 64 bytes, and nothing
  else.** That covers HID feature reports and vendor requests, how such
  devices are configured, with the least new code: no endpoint is opened,
  and the system parses nothing a device sends but its descriptors, which
  are fuzzed. Standard requests that would change how the system talks to
  the device are the system's.
- **Promises, done one at a time between frames.** On the Zero's host
  controller a control transfer is waited for (Circle's can't be
  asynchronous), so a transfer blocks the main loop, at most 1 s a stage
  and only twice per device before it is given up on until replugged. An
  asynchronous API costs nothing more now, keeps the screen drawn between
  transfers, and lets apps be written as for WebUSB and WebHID, whose
  pages they often port.
- **USB/IP in the simulator.** Any device a USB/IP server offers, real or
  simulated, can be tried with an app, without the hardware.

## Apps

### One app at a time, each in its own runtime

Each app runs in a QuickJS runtime of its own, and only one runs at a time.
Apps cannot reach each other's objects, files or session stores. An app
reaches the system only through the `gk:*` modules, and some of those only
with a permission named in its manifest.

### The app hash covers all the code an app runs

The launcher shows the SHA-256 of each app, to compare with the hash
published for it ([APPS.md](APPS.md#app-hashes)). That hash covers every
file of the app, so it covers every line of JavaScript the app runs: a
published hash says exactly what code will handle your keys.

That is why **apps never share code at run time.** An app imports only its
own files. If apps could import each other's modules, or libraries from a
common folder, an app's hash would no longer say what it runs: a change to
the shared code would change what every app using it does, while their
hashes stayed the same. So an app that builds on another's library carries
a copy of it. `tools/share_libs.py` makes the copies byte for byte from the
library's one home (an app, or `lib/js/`), and the tests check that no copy
differs from its home. The cost is a few duplicated kilobytes on the card;
the gain is that one hash pins one app's whole behaviour.

### Data is shared by name

Data is different from code, and is shared between apps by name, with
`gk:data` ([APPS.md](APPS.md#data-files)). A data folder is a folder on the
card, `data/<name>/`, read-only like everything else there: public keys
for a PGP app, say, put there when the card was prepared. An app lists the
folders it reads in its manifest (for example `"data": ["pgp"]`), so what
it can read is known before it starts, and is covered by its hash. Data is
outside the app hash: the same app can work on different data, and data
can be updated without changing the hash of the app that reads it.

**Why the difference:** code decides what happens to a secret; data is only
read. An app's hash must pin its code, and be the same on every card so
people can compare it with a published one; data is different on every
card, so no published hash could cover it. An app has to treat data the way
it treats anything typed or scanned: as input to check, never as something
to run. Sharing data by name avoids carrying a copy of a large data set in
every app that reads it, without weakening what the app hash promises.

**The price** is that whoever can change the card can change the data (swap
Bob's key for theirs), as they could change the apps. The defence is to
show it: the launcher shows each data folder's hash beside the app's
(`tools/bundle_apps.py --data-hash` computes it on a computer), and apps
show what matters at the moment it matters (a key's fingerprint before
encrypting to it). A folder is read whole, hashed and kept in memory at
boot, so what an app reads is what was hashed, even if the card is swapped
or taken out afterwards.

A sealed system can carry its data in the kernel (`SEALED=1 DATA=dir`),
for someone who wants no card at all after power-on and no FAT code. Then
the kernel's hash covers the data, so it is per person and can't be
compared with a published one; the data folder's hash, which the launcher
still shows, lets the keyring be checked on its own, and building the same
commit without data gives the published hash of the code.

### Suites group apps, nothing more

Suites group apps in the launcher: a set of apps that belong together, one
tile (`apps/<suite>/suite.json`, [APPS.md](APPS.md#suites)). A suite is
grouping only. Each app in it stays self-contained, with its own files,
its own hash and its own runtime, for the same reasons as above: the
suite's apps share no code, only data folders, each listing those it
reads (a suite gives no implicit access to a folder named after it, so the
manifest always says everything an app can read).

## Languages

- **Translations are loaded at run time**, from each app's
  `lang/<language>.json`. One card image serves every language; the
  language is chosen in `gapkeep.txt` (or the Settings app, until
  power-off). Catalogs are JSON, parsed as data, never as code; they are
  files of the app, so its hash covers them.
- **The English text is the key**, written where it is used:
  `t("Sign this transaction?")`. Code stays readable, a missing
  translation shows the English, and the tools find keys in the code.
- **Values are always parameters**, never part of a translated text:
  amounts, addresses, keys and seed words go in as `{name}`. A translation
  whose placeholders differ from its key's, or that holds control
  characters, is refused and the English is shown; labels show text as
  text, not as markup. A translation can reword a sentence but cannot
  change what it shows.
- **Dates and times are ISO 8601 with a space:** `2026-11-08 14:03:05`,
  the same in every language. No month names and no other orders: one form
  that cannot be misread.
- **Numbers are formatted by GapKeep itself** (QuickJS has no `Intl`), the
  same on every build. Bitcoin amounts go from integer satoshis to text and
  back without floating point, and text that could be read two ways
  (`1.000`) is refused rather than guessed.
- Western scripts first. Asian scripts wait until someone needs them: their
  fonts are megabytes.

The reference is [APPS.md](APPS.md#languages) and [API.md](API.md)
(`gk:i18n`); the Brazilian Portuguese glossary is [i18n/pt-BR.md](i18n/pt-BR.md).

## Bitcoin

GapKeep is a general offline computer, and Bitcoin is one of its uses: the
dice39 app makes or imports a key and splits it into codex32 shares, and
the Signer signs transactions that an online wallet prepared (Electrum, or
GapWallet, a companion web wallet not yet published). Transactions travel
between the two only as QR codes.

- **The transaction first, then the keys.** The Signer reads the PSBT and
  shows what it does before any secret is in memory, and forgets the keys
  after signing unless asked to keep them for the next transaction.
- **Change is a claim until checked.** An output a PSBT calls change is
  shown as claimed until a loaded key derives it at a path the wallet
  watches; otherwise it is counted as sent, and one a key refutes needs
  "Sign anyway". A multisig change output must be provably the same wallet
  as the inputs.
- **Merging is BIP-174's Combiner:** copies of the same unsigned
  transaction combine, conflicts are refused, different transactions are
  never combined.
- **Keys come as** codex32 shares, BIP-39 words, an xprv or a WIF; for each,
  the Signer says what it can sign.
- **Public keys leave as output descriptors** with their origin
  (`wpkh([fingerprint/84h/0h/0h]xpub…/<0;1>/*)`), one account at a time;
  a zpub too, for Electrum. A master xpub can't stand in: account paths
  are hardened.
- **QR transport:** a single Base43 code when it fits (Electrum reads it),
  otherwise BBQr, the multi-part format Coldcard and Sparrow use, simpler
  than UR. Colour QR codes stay experimental and out of this.
- **PSBTs must carry their origins:** every input and change output its
  BIP-32 derivation with the master fingerprint.
- **The segwit v0 fee attack: a memory of what was signed, and an amber
  warning.** A segwit v0 signature covers its own input's amount only: asked
  twice for the same coins, each time with another amount understated, a
  signer shows a modest fee twice, and the two signatures pay a large one.
  Electrum's QR codes never carry the previous transactions that prove the
  amounts, so a red warning (Trezor's and Ledger's stance) would be on
  nearly every transaction, and soon clicked through. Instead the Signer
  remembers each coin it signed (outpoint and amount, nothing else) in
  gk:session, in RAM until power-off, never on the card, and refuses the
  same coin told with another amount: red, not signed. A transaction with
  more than one segwit v0 input, any of them without its previous
  transaction, gets an amber warning that says what to do after a power-off
  (the memory is gone then): if a transaction "failed" and you're asked to
  sign the same coins again, don't, unless the amounts are the same. With
  the previous transaction, its txid is checked and the amount is its own.
  One input alone can't be attacked this way, and taproot signatures cover
  every input's amount.
