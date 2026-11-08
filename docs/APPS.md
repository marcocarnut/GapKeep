# Writing zerogap apps

A zerogap app is a small JavaScript program with a manifest, in a folder of
its own. It is either copied to the `apps` folder of the SD card or built
into the system image, shows up in the launcher, and talks to the system only
through a few documented modules (`zg:ui`, `zg:sys`, ...). This guide walks
through writing one; [API.md](API.md) is the full reference.

## What you get, and what you don't

- **Modern JavaScript** (ES2023 via [QuickJS](https://bellard.org/quickjs/)):
  modules, classes, async/await, BigInt, typed arrays, destructuring...
- **A widget toolkit** (`zg:ui`) drawn by [LVGL](https://lvgl.io): labels,
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
import * as ui from "zg:ui";

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
| `permissions` | no | Extra rights: `"apps"` (import `zg:apps`: list and start apps), `"camera"` (`ui.Scanner`, [CAMERA.md](CAMERA.md)), `"rtc"` (setting the clock, [CLOCK.md](CLOCK.md)), `"settings"` (changing the language, number marks and keyboard: [Languages](#languages)). E.g. `["camera"]`. |
| `hidden` | no | `true`: not listed in the launcher. |
| `experimental` | no | `true`: listed and started only with `experimental = yes` in the card's `zerogap.txt` ([EXPERIMENTAL.md](EXPERIMENTAL.md)). |

zerogap checks every manifest, and refuses an app with unknown keys, a bad
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

Why not a PNG? zerogap would need a PNG decoder (zlib and all) to read it,
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
`apps/`. zerogap reads the apps once, at boot, into memory, and never writes
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
open it. It covers exactly what zerogap loads, so it is the same on any card
and for the built-in copy:

```sh
python3 tools/bundle_apps.py --hash apps/dice39
```

It is the SHA-256 of the app's files sorted by path (byte order), each
contributing its path relative to the app folder (with `/`), a NUL byte, its
size in decimal, a NUL byte, and its contents.

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

Characters come as the keyboard layout types them, in UTF-8: `zerogap.txt`
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
import { t, plural, formatBtc } from "zg:i18n";

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
in manifest.json, and the launcher (`zg:apps`' `list()`) and `sys.app` show
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
`zg:i18n` (a library also run under Node) marks its text with a no-op
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
and `clock_trim_ppm = +1.5` for `zerogap.txt`.

**The language** comes from `zerogap.txt` on the card:

```
language = pt-BR
decimal_mark = ,        # if not the language's own; then group_mark too
group_mark = .          # . or , or nothing (no grouping)
```

An unknown language is English, with a line in the log. Sealed builds read
no card: `make SEALED=1 LANGUAGE=pt-BR`. The Settings app changes all of
these while running, until power-off (an app needs the `"settings"`
permission to). Languages fall back from `pt-BR` to `pt` (`lang/pt.json`,
if the app has one) to English. A language exists if the launcher has a
catalog for it: the launcher's catalogs (`apps/launcher/lang/`) also hold
the system's own text.

To see an app in another language, or find text that missed `t()`:

```sh
tools/zgsim --lang pt-BR apps/myapp
tools/zgsim --lang qps apps/myapp     # every translated text [Åççéñţéď ·····]
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
tools/zgsim apps/counter                                 # the log on stdout
tools/zgsim --for 2 --shot /tmp/counter.png apps/counter # a screenshot
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
  counts from 1970. `zg:clock`'s `status().set` says which
  ([CLOCK.md](CLOCK.md)).
- **Be keyboard-friendly.** Order widgets so Tab follows the natural flow,
  and focus the first input when a screen appears (`widget.focus()`).
