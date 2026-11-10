# Writing GapKeep apps

A GapKeep app is a small JavaScript program with a manifest, in a folder of
its own. It is either copied to the `apps` folder of the SD card or built
into the system image, shows up in the launcher, and talks to the system only
through a few documented modules (`gk:ui`, `gk:sys`, ...). This guide walks
through writing one; [API.md](API.md) is the full reference.

## What you get, and what you don't

- **Modern JavaScript** (ES2023 via [QuickJS](https://bellard.org/quickjs/)):
  modules, classes, async/await, BigInt, typed arrays, destructuring...
- **A widget toolkit** (`gk:ui`) drawn by [LVGL](https://lvgl.io): labels,
  buttons, text fields, tables, QR codes, tabs, alerts.
- **A keyboard and a mouse.** Every widget can be reached with Tab and
  activated with Enter or Space.
- **No network, no files, no clock you can trust**, and no way to reach
  other apps. (Apps are read from the card at boot, but an app itself cannot
  read or write files.) That is the point: an app sees only what the person types.

## Your first app

Create a directory under `apps/` whose name is the app's id:

```
apps/
  counter/
    manifest.json
    main.js
```

`manifest.json`:

```json
{
  "id": "counter",
  "name": "Counter",
  "version": "1.0.0",
  "description": "Counts clicks.",
  "icon": "plus"
}
```

`main.js`:

```js
import * as ui from "gk:ui";

let count = 0;
const label = new ui.Label({ text: "0 clicks", font: 28 });

new ui.Button({
  text: ui.symbols.plus + " Click",
  onClick: () => {
    count++;
    label.text = `${count} clicks`;
  },
});
```

Run it in the emulator, with your app on an SD card image:

```sh
tools/build.sh qemu                                  # the system (launcher only)
mkdir -p /tmp/card/apps && cp -r apps/counter /tmp/card/apps/
tools/make_sd_image.sh /tmp/card.img /tmp/card
python3 tools/qemu_harness.py --sd /tmp/card.img --interactive
```

On a real Pi Zero, copy the `counter` folder into the `apps` folder of the
card (see [Installing apps](#installing-apps)).

That's it: no `main()` or event loop to write. The module's top level runs
once when the app starts, and everything after that happens in event
handlers and timers.

## The manifest

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique id, `[a-z0-9-]`, must match the directory name. |
| `name` | yes | Shown in the launcher. |
| `version` | yes | Free-form string, shown in logs. |
| `description` | no | One line for the launcher tile. |
| `icon` | no | One of the names in `ui.symbols` (default `"file"`), or a picture: see [Picture icons](#picture-icons). |
| `entry` | no | Entry module (default `"main.js"`). |
| `permissions` | no | Extra rights: `"apps"` (import `gk:apps`: list and start apps), `"camera"` (`ui.Scanner`, [CAMERA.md](CAMERA.md)), `"rtc"` (setting the clock, [CLOCK.md](CLOCK.md)), `"settings"` (changing the language, number marks and keyboard: [Languages](#languages)). E.g. `["camera"]`. |
| `hidden` | no | `true`: not listed in the launcher. |
| `experimental` | no | `true`: listed and started only with `experimental = yes` in the card's `gapkeep.txt` ([EXPERIMENTAL.md](EXPERIMENTAL.md)). |
| `data` | no | The card's data folders the app reads with `gk:data`, e.g. `["pgp"]`: at most 8 names, each `[a-z0-9-]`, at most 32. See [Data files](#data-files). |

GapKeep checks every manifest, and refuses an app with unknown keys, a bad
id, an unknown or malformed icon, an unknown permission, or a missing entry
module. The build does
it for built-in apps (`tools/bundle_apps.py`); for apps on the SD card the
system does it at boot, and the launcher lists each refused app with the
reason.

### Picture icons

Instead of a symbol name, `icon` can be a picture, which the launcher shows
on the app's tile:

```json
"icon": { "width": 64, "height": 64, "rgba": "Dxos/w8aLP8RHS//..." }
```

`rgba` is base64 (standard alphabet, with padding) of `width * height * 4`
bytes: red, green, blue and alpha per pixel, rows top to bottom. 64×64 suits
the launcher (it scales larger pictures down to that); sides may be 1 to 128
px. `tools/make_icon.py` turns a PNG or any other image into this:

```
python3 tools/make_icon.py logo.png --manifest apps/myapp/manifest.json
```

Why not a PNG? GapKeep would need a PNG decoder (zlib and all) to read it,
on data that comes from the SD card. Plain pixels only need decoding from
base64 and checking for length, which is easy to get right. The icon is part
of manifest.json, so the app's hash covers it.

Only `.js`, `.json` and `.txt` files are part of an app; the rest (a README,
images) is ignored. Names of those files, and of folders, may use
`A-Z a-z 0-9 . _ -`; names starting with `.` are skipped. Text must be UTF-8.
Limits: 256 files, 4 MB per file, 16 MB per app, folders 8 levels deep.

## Installing apps

The card holds the apps in a folder called `apps`, one folder per app, named
after its id, laid out exactly like the repository's `apps/`:

```
(card)
  kernel.img, config.txt, ...
  apps/
    dice39/
      manifest.json
      main.js
      lib/...
    counter/
      ...
```

`tools/make_sdcard.sh --standalone` makes such a card, with every app in
`apps/`. GapKeep reads the apps once, at boot, into memory, and never writes
to the card (its FAT driver is compiled read-only). To install or remove an
app, change the card and restart.

The launcher lists the built-in apps first, then those from the card, each
sorted by id. An app on the card cannot replace a built-in one: if its id is
taken (the launcher's, for instance), it is refused.

A **sealed** system (`tools/make_sdcard.sh --sealed`) has every app built
into `kernel.img` and no SD card code at all: for a machine that should only
ever run one set of apps.

## App hashes

Whoever can change the card can change the apps on it, so the launcher shows
the SHA-256 of the focused app below the tiles (as `sys.app.hash` and in
`apps.list()`). Compare it with the hash published for the app before you
open it. It covers exactly what GapKeep loads, so it is the same on any card
and for the built-in copy:

```sh
python3 tools/bundle_apps.py --hash apps/dice39
```

It is the SHA-256 of the app's files sorted by path (byte order), each
contributing its path relative to the app folder (with `/`), a NUL byte, its
size in decimal, a NUL byte, and its contents.

## Suites

A suite is a group of apps that belong together (a PGP suite: one app to
encrypt, one to sign, one to manage keys), shown in the launcher as one
tile. It is a folder in `apps/` with a `suite.json` instead of a
`manifest.json`, holding the apps' folders:

```
(card)
  apps/
    pgp/
      suite.json
      lang/pt-BR.json        optional: the suite's name and description translated
      pgp-sign/
        manifest.json
        main.js
      pgp-encrypt/
        ...
```

```json
{ "id": "pgp", "name": "PGP", "description": "Sign, encrypt, check.", "icon": "envelope" }
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | `[a-z0-9-]`, at most 32, the same as the folder name. |
| `name` | yes | Shown on the suite's tile. |
| `description` | no | One line for the tile. |
| `icon` | no | As an app's: a `ui.symbols` name (default `"file"`) or a [picture](#picture-icons). |

The launcher shows the suite as one tile; Enter opens it and shows its
apps, with a **Back** button; Escape or Backspace go back too. When an app
of the suite exits (or the Windows key is pressed), the launcher opens the
suite again. The suite's name and description are translated like an app's
([Languages](#languages)): `lang/<language>.json` in the suite's folder,
with `"$app"` set to the suite's id; `python3 tools/i18n.py extract
apps/pgp --lang pt-BR` writes it, `check` checks it. The folder `lang` in a
suite is its catalogs, never an app.

**Each app stays an app.** It has its own manifest, its own hash, its own
`gk:session` store, and imports only its own files: apps in a suite **share
no code**. That is deliberate: an app's hash covers every line it runs, so
the hash a person compares means the same with or without the suite, and
one app of the suite can be checked, replaced or removed without touching
the others. Code two apps need goes into both. What they can share is
data: [Data files](#data-files),
listed in each app's manifest. A suite's apps get no implicit access to a
folder named after the suite: each lists what it reads.

App ids are unique on the whole card, suites included: an app whose id is
already taken (by a built-in app, an app loaded before it, in folder
order, or a suite) is refused, and the launcher lists it with the reason
(`apps/pgp-sign not loaded: an app with this id was loaded from
apps/pgp/pgp-sign`). Suites don't nest. `apps.list()` gives each app's `suite`
(its id, or `null`), `apps.suites()` the suites. Built-in apps belong to no
suite. A sealed build has no card, so no suites.

## Data files

Some apps need data the person chose when preparing the card: a PGP app
needs public keys, and scanning each one as a QR code every time is no
way to work. Such files go in `data/<folder>/` at the top of the card,
beside `apps/`, and an app reads the folders its manifest lists:

```
(card)
  apps/...
  data/
    pgp/
      alice.asc
      bob@example.org.pgp
      keyring/work.gpg
```

```json
{ "id": "pgp-encrypt", ..., "data": ["pgp"] }
```

```js
import * as data from "gk:data";

const files = data.list("pgp");                   // [{ name: "alice.asc", size: 3112 }, ...]
const key = data.read("pgp", "keyring/work.gpg"); // Uint8Array
const armored = data.readText("pgp", "alice.asc");
```

- Folder names are like app ids: `[a-z0-9-]`, at most 32. Files can be of
  any type, binary or text, in sub-folders (`list()` names them
  `"keyring/work.gpg"`). File and folder names are printable ASCII
  (`alice@example.org key.asc` is fine; `/` and `\` are not), at most 128
  bytes; names starting with `.` are skipped (macOS's `._x` files).
- Read-only: nothing can write to the card. Apps that list the same
  folder share it; no other permission is needed. An app can't read a
  folder it doesn't list, or leave the folder (`..`, `.`, a leading `/` or a
  `\` in a name are refused).
- A folder is read on first use (when the app or the launcher first asks
  for it), all of it, checked and hashed, and kept in memory until
  power-off: what an app reads is exactly what was hashed. Limits: 4 MB per
  file, 8 MB and 256 files per folder, 8 levels of sub-folders, 32 MB for all
  the folders read since boot. A folder over a limit, or with a bad name in
  it, can't be read at all: `list()`, `read()` and `hash()` throw a
  `TypeError` saying which file and why, and the launcher shows it.
- A folder that isn't on the card is empty: `list()` returns `[]`,
  `hash()` `null`. So is every folder without a card, and in a **sealed**
  build, which reads no card.
- The log shows each folder's file count, size and hash when it is read;
  never what the files hold. Don't log it from your app either.

**The data is not part of the app's hash.** The [app hash](#app-hashes)
names the code, and must be the same on every card so people can compare it
with a published one; the data is different on every card. So whoever can
change the card can change the data, and swap Bob's key for theirs. The
launcher shows the hash of each data folder the focused app lists, below
the app's hash; it is the app hash's scheme over the folder's files, so

```sh
python3 tools/bundle_apps.py --data-hash ~/gapkeep-data/pgp
```

computes it on a computer, and `data.hash("pgp")` gives it to the app. But
a folder hash only says the folder is unchanged, not that its contents are
right. **Show the person what matters, at the moment it matters:** before
encrypting to a key, its fingerprint (and the name and e-mail it carries),
for them to compare with one they got from its owner; before trusting a
list of addresses, the address about to be used. Never act on data from
the card silently.

### Preparing a card with data

Make a folder with one sub-folder per data folder, and give it to
`tools/make_sdcard.sh`, which copies them to the card's `data/` and prints
their hashes:

```sh
mkdir -p ~/gapkeep-data/pgp
gpg --export --armor alice@example.org > ~/gapkeep-data/pgp/alice.asc
gpg --export bob@example.org > ~/gapkeep-data/pgp/bob.gpg
tools/make_sdcard.sh --standalone --data ~/gapkeep-data
```

Or copy the folders to a card by hand: `data/pgp/...` at the card's top,
beside `apps/`. Write down the hashes it prints (or that
`tools/bundle_apps.py --data-hash` prints) to check them on the device's
launcher later. In the simulator, `tools/gksim --data ~/gapkeep-data/pgp
apps/myapp` puts a folder on its card (a `data/` folder beside the app's
folder, or beside the `apps/` folder holding it, goes too); in the browser
IDE, **Import** a folder named `data` ([IDE.md](IDE.md)).

## Laying out a screen

Widgets go on `ui.screen` unless you pass a parent first:

```js
const row = new ui.Container({ layout: "row", gap: 8 });   // on the screen
new ui.Label(row, { text: "Name" });                        // inside row
new ui.TextArea(row, { oneLine: true, width: 240 });
```

`ui.screen` is a column with 16 px padding and 12 px between children, which
suits most simple apps. Layout uses flexbox semantics: `layout` (`"row"`,
`"column"`, `"row-wrap"`, `"column-wrap"`, `"none"`), `justify`,
`alignItems`, `gap`, `padding`, `grow`. Sizes are pixels, percentages of the
parent (`"50%"`) or `"content"`.

Use **Container** for invisible layout boxes and **Panel** for the "card"
look (background, border, padding).

## Markup

A Label made with `markup: true` takes Pango-style markup, for a few
words in another style:

```js
import { tm } from "gk:i18n";

new ui.Label({
  markup: true,
  width: "100%",
  text: tm("Send <span color='#ffb300'>{amount} BTC</span> to <tt>{address}</tt>?",
           { amount: formatBtc(sats), address }),
});
```

Tags: `<b>` (bold), `<i>` (italic), both for bold italic, `<tt>`
(monospaced), `<big>`, `<small>`, `<u>`, `<s>`, and `<span>` with `color`,
`size` (one of `ui.fonts`), `font_family="monospace"`, `weight="bold"`,
`style="italic"`, `underline="single"`, `strikethrough="true"`. Entities:
`&lt; &gt; &amp; &quot; &apos; &#N; &#xN;`. Bold and italic come at every
size of `ui.fonts`, on the same line and baseline as the normal text; there
is no bold or italic monospaced font, so `<b>` inside `<tt>` (or in a
`mono` label, or `<tt>` inside `<b>`) is an error. Anything the parser
doesn't know throws a `TypeError` naming the problem and the character
where it is: markup is never shown half-parsed.

Bold and italic are drawn from TrueType outlines (LVGL's TinyTTF), not
from bitmaps: the first label to use a style at a size makes its font
(logged as `fonts: bold 16 px: made`), and each glyph is rasterized the
first time it is drawn and then kept (up to 96 per style and size, about
25 KB at 16 px). So a style costs nothing until it is used, and its first
screen is slower than the next: on QEMU, about 10 ms more for a paragraph
in bold. They lack the bitmap fonts' hinting: at 12
and 14 px they look a little softer.

**Data is never markup.** A name, an address or a scanned text could hold
`<` or `&`: put it in with `ui.escapeMarkup(s)`, or through `tm()` (as `t()`,
but every param is escaped). A translation of a key with tags must keep the
same tags (`tools/i18n.py check` and the runtime check it), and a key
without tags stays without, so a translator can't add one either.

`markup` is set when the Label is created, not later. `font`, `mono`,
`color` and `textAlign` work as for any Label; `overflow` takes `"wrap"`,
`"clip"` or `"dots"`. A markup label costs more memory than a plain one
(see `sys.memory().ui`): use it where the styles matter.

## Reacting to input

Pass handlers as `on...` properties or with `widget.on(event, fn)`:

```js
const field = new ui.TextArea({
  oneLine: true,
  placeholder: "Seed word",
  accept: "abcdefghijklmnopqrstuvwxyz",   // filter keystrokes
  onChange: (ev) => console.log("now:", ev.value),
  onSubmit: () => check(field.text),      // Enter in a one-line field
});
```

For keyboard shortcuts, register an app-wide key handler. It sees every key
before the focused widget; return `true` to consume it:

```js
ui.onKey((ev) => {
  if (ev.ctrl && ev.key === "n") { startOver(); return true; }
  return false;
});
```

Characters come as the keyboard layout types them, in UTF-8: `gapkeep.txt`
chooses `keyboard = us` (the default) or `br-abnt2` (Brazilian, with dead
keys: ´ then a is á). A TextArea's text and `ev.key` can hold any letter of
Latin-1 and Latin Extended-A, which every font size draws. A shortcut is
best a letter or a named key (`"Enter"`, `"F2"`): punctuation moves between
layouts.

## Asking questions

`ui.alert` shows a modal message and resolves with the index of the button
pressed (-1 for Escape):

```js
const choice = await ui.alert("Erase everything?", {
  title: "Start over",
  buttons: ["Cancel", "Erase"],
});
if (choice === 1) eraseAll();
```

## Languages

An app can show its text in the person's language. Write it in English,
where it is used, through `t()`: the English is the key. Translators
follow each language's glossary, [i18n/pt-BR.md](i18n/pt-BR.md) for
Brazilian Portuguese, so a term has one name in every app.

```js
import { t, plural, formatBtc } from "gk:i18n";

new ui.Label({ text: t("Sign this transaction?") });
say(t("Send {amount} BTC to {address}?", { amount: formatBtc(sats), address }));
label.text = plural(count, "{n} code", "{n} codes");
t("Open", { $context: "verb" });     // the same English, another meaning
```

The translations are files of the app, one per language:

```
apps/myapp/
  lang/
    pt-BR.json
```

```json
{
  "$language": "pt-BR",
  "$app": "myapp",
  "messages": {
    "Sign this transaction?": "Assinar esta transação?",
    "{n} code": "{n} código",
    "{n} codes": "{n} códigos",
    "verb\u0004Open": "Abrir"
  },
  "notes": {
    "Sign this transaction?": "On the review page, before the person confirms."
  }
}
```

`notes` is for translators; the runtime ignores it. The manifest's `name`
and `description` are keys too: their translations go in the catalog, not
in manifest.json, and the launcher (`gk:apps`' `list()`) and `sys.app` show
them in the language, with the same checks (and no line breaks). Leave out
a name that is a product's (`dice39`): it stays as it is. `tools/i18n.py` keeps
catalogs in step with the code:

```sh
python3 tools/i18n.py extract apps/myapp --lang pt-BR   # adds new keys, empty
python3 tools/i18n.py check apps/myapp                  # what is missing or wrong
```

`check --lang pt-BR` also reads the language's glossary,
[docs/i18n/pt-BR.md](i18n/pt-BR.md): the terms every app uses, and words
to avoid, which it reports as warnings.

A key with an empty translation shows in English. `check` lists keys with
no translation, translations no longer used, and those the runtime would
refuse; `tools/run_sim_tests.sh` runs it for every app with a `lang/`
folder. Keys must be string literals (or literals joined with `+`):
`t(variable)` works, but `check` can't see it and says so. Code that can't import
`gk:i18n` (a library also run under Node) marks its text with a no-op
`N_("...")` (`const N_ = (s) => s;`), and the app passes it to `t()`
later: `check` finds those keys too (`apps/totp/lib/parse.js`).

What a translation may not do (the runtime checks each one when the app
starts, logs those it refuses and shows the English instead):

- **Change the `{names}`.** A translation has the same set of `{names}` as
  its key: it can reword "Send {amount} to {address}", but can't drop the
  amount or add one. So pass everything that matters (amounts, addresses,
  fingerprints, paths, words of a seed) as params, never as part of the
  text.
- **Hold control characters**: C0 (line feeds are allowed), C1, and the
  bidi and line controls that could reorder an amount beside them.
- **Be markup.** Labels show text as text (LVGL's recolor is never on), so
  a `#ff0000` is just characters.

Catalogs are parsed as JSON, never run, and at most 256 KB. They are files
of the app like any other, so they are part of its [hash](#app-hashes): a
changed translation changes the hash the launcher shows.

**Numbers, amounts and dates.** `formatNumber`, `formatSats` and
`formatBtc` write numbers the language's way (`1,234.5` or `1.234,5`), and
`parseNumber` and `parseBtc` read them back, refusing what could be read
two ways (`1.000`: one, or a thousand?). Amounts are whole satoshis, never
floating point, and the text carries the unit (`"{amount} BTC"`), so a
translation can move it. Dates and times are ISO 8601 with a space in every
language (`formatDateTime`: `2026-11-08 14:03:05`). Files and protocols are
not written the language's way: the clock app shows `+1,5 ppm` on screen,
and `clock_trim_ppm = +1.5` for `gapkeep.txt`.

**The language** comes from `gapkeep.txt` on the card:

```
language = pt-BR
decimal_mark = ,        # if not the language's own; then group_mark too
group_mark = .          # . or , or nothing (no grouping)
```

An unknown language is English, with a line in the log. Sealed builds read
no card: `tools/build.sh pi SEALED=1 LANGUAGE=pt-BR`. The Settings app changes all of
these while running, until power-off (an app needs the `"settings"`
permission to). Languages fall back from `pt-BR` to `pt` (`lang/pt.json`,
if the app has one) to English. A language exists if the launcher has a
catalog for it: the launcher's catalogs (`apps/launcher/lang/`) also hold
the system's own text.

To see an app in another language, or find text that missed `t()`:

```sh
tools/gksim --lang pt-BR apps/myapp
tools/gksim --lang qps apps/myapp     # every translated text [Åççéñţéď ·····]
```

`qps` is a pseudo-language: what went through `t()` comes out accented,
about 40% longer and in brackets, so text that didn't stands out, and text
that a longer translation would cut off shows. `apps/clock` and
`apps/launcher` are examples.

## Splitting code into modules

Import your own files with relative paths. Bare names (`"lodash"`) are
rejected: there is no package manager and no network to fetch from.

```js
import { wordlist } from "./data/bip39-english.js";
import * as checks from "./lib/checks.js";
```

## Timers and async code

`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, promises and
async functions all work. Timers are cancelled when the app exits.

## Leaving

The person can always press the **Windows (Super) key** to return to the
launcher. An app can leave by itself with `sys.exit()`. Either way, the app's
widgets, timers, handlers and memory are freed.

## When things go wrong

Uncaught exceptions and unhandled promise rejections show a red banner with
the message and stack, and are written to the serial log. The app keeps
running. Long-running code is stopped after 10 seconds, and each app may use
up to 96 MB of memory.

`console.log` (and `info`, `warn`, `error`, `debug`) write to the serial
log, prefixed with `app:<id>`. Objects are printed as JSON.

## Trying it out

The quickest way: the simulator runs your app on your machine, the same
runtime as on the Pi ([SIMULATOR.md](SIMULATOR.md)):

```sh
tools/gksim apps/counter                                 # the log on stdout
tools/gksim --for 2 --shot /tmp/counter.png apps/counter # a screenshot
```

Or in the browser, with an editor that knows the API: [IDE.md](IDE.md).

It runs much faster than a Pi Zero: watch the "about N ms of JavaScript on
a Pi Zero" it logs when your app starts and stops.

## Testing in the emulator

`tools/qemu_harness.py` boots the image in QEMU and plays a scenario: type,
press keys, click, take screenshots, and wait for log lines. Put scenarios in
`tests/*.txt` and run them all with `tools/run_tests.sh`, which puts the apps
in `apps/` on the emulated SD card. See
`tests/apps_widgets.txt` for an example, and the comment at the top of
`tools/qemu_harness.py` for the commands. The same scenarios run on the
simulator in seconds (`--sim`, and `tools/run_sim_tests.sh`).

Logging what your app does (`console.log("submitted", value)`) is what lets a
scenario check it.

## Guidelines for air-gapped apps

- **Show your work.** If the app derives something important (a seed, an
  address, a checksum), show the inputs and intermediate steps so a person
  can check them.
- **Make transcription errors loud.** Prefer formats with checksums, and
  verify what the person types.
- **Keep secrets on screen only as long as needed**, and give the person a
  way to clear them.
- **Check the clock before relying on it.** A Pi Zero has no battery-backed
  clock: the Clock app sets it after each boot, and until then `Date.now()`
  counts from 1970. `gk:clock`'s `status().set` says which
  ([CLOCK.md](CLOCK.md)).
- **Be keyboard-friendly.** Order widgets so Tab follows the natural flow,
  and focus the first input when a screen appears (`widget.focus()`).
