# Writing zerogap apps

A zerogap app is a small JavaScript program with a manifest. It is compiled
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
  other apps. That is the point: an app sees only what the person types.

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

Build and run it in the emulator:

```sh
make -C src
python3 tools/qemu_harness.py --interactive
```

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
| `icon` | no | One of the names in `ui.symbols` (default `"file"`). |
| `entry` | no | Entry module (default `"main.js"`). |
| `permissions` | no | Extra system modules the app may import, e.g. `["apps"]`. |
| `hidden` | no | `true`: not listed in the launcher. |

The build checks every manifest (`tools/bundle_apps.py`) and fails with a
clear message on unknown keys, bad ids, unknown icons or permissions, or a
missing entry module. Only `.js`, `.json` and `.txt` files are bundled.

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

## Testing in the emulator

`tools/qemu_harness.py` boots the image in QEMU and plays a scenario: type,
press keys, click, take screenshots, and wait for log lines. Put scenarios in
`tests/*.txt` and run them all with `tools/run_tests.sh`. See
`tests/apps_widgets.txt` for an example, and the comment at the top of
`tools/qemu_harness.py` for the commands.

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
- **Don't rely on the clock.** A Pi Zero has no real-time clock;
  `Date.now()` starts near 1970 at every boot.
- **Be keyboard-friendly.** Order widgets so Tab follows the natural flow,
  and focus the first input when a screen appears (`widget.focus()`).
