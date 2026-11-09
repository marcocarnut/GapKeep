# Writing GapKeep apps: a guide for coding agents

You are writing an app for GapKeep, a small operating system for air-gapped
Raspberry Pi Zeros. An app is a folder of JavaScript modules plus a
manifest; it runs on QuickJS (ES2023) and draws with LVGL through the
`gk:ui` module. This page is the short version of what you need, in the
order you need it. The details are in:

- [API.md](API.md): every module, widget, property and event. Generated
  from [api/gapkeep-api.yaml](api/gapkeep-api.yaml), which a test checks
  against the runtime: what it says exists, exists.
- [APPS.md](APPS.md): the manifest, installing, hashes, layout, input.
- [`sim/web/types/gapkeep.d.ts`](../sim/web/types/gapkeep.d.ts): the same API
  as TypeScript declarations, if types help you.

## The loop: write, run, look

You can't see a screen, but the simulator can show you one. Run the app,
take a screenshot, look at it, and read the log:

```sh
tools/gksim --for 2 --shot /tmp/shot.png apps/myapp     # then look at /tmp/shot.png
```

To press keys and click, write a scenario and play it:

```
# myapp.txt
expect launcher ready 10
launch myapp
expect myapp ready 10
key tab
key ret
type 3526
key ret
expect result: \d+ 10
shot after-entry
```

```sh
mkdir -p /tmp/card/apps && cp -r apps/myapp /tmp/card/apps/
make -C sim -s
python3 tools/qemu_harness.py --sim sim/build/gksim --card /tmp/card --out /tmp/out myapp.txt
```

Screenshots land in `--out`; the log is in `/tmp/out/serial.log`. A run
takes seconds. Commands: see the top of `tools/qemu_harness.py` and
[SIMULATOR.md](SIMULATOR.md). The system boots into the launcher; `launch`
starts your app directly (a person would pick its tile).

**Log what matters.** `console.log("myapp ready")` when the first screen is
up, and a line for each result. Scenarios wait for log lines (`expect`);
they are how you, and the tests, know what happened.

## An app

```
apps/myapp/
  manifest.json
  main.js
  lib/...           optional: more modules, imported as "./lib/x.js"
```

```json
{ "id": "myapp", "name": "My App", "version": "1.0.0",
  "description": "One line for the launcher tile.", "icon": "edit" }
```

- `id`: `[a-z0-9-]`, at most 32, the same as the folder name.
- `icon`: a name from `ui.symbols` ([list](API.md#symbols)), or a picture
  (`tools/make_icon.py image.png --manifest apps/myapp/manifest.json`).
- Unknown keys are refused. Only `.js`, `.json` and `.txt` files are part of
  the app; text must be UTF-8.

```js
import * as ui from "gk:ui";

const label = new ui.Label({ text: "Hello", font: 28 });
const button = new ui.Button({ text: "Press", onClick: () => (label.text = "Pressed") });
button.focus();
console.log("myapp ready");
```

Widgets without a parent go on `ui.screen`, a column with 16 px padding.
`new ui.X(parent, props)` puts one inside another.

## What is not there

No `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `document`,
`window`, `require`, `process`, `Buffer`, global `crypto` or file access.
Time of day: `Date` works, but the clock is only right once the Clock app
has set it after boot: check `status().set` from `gk:clock`, and use its
`every(seconds, fn)` for things on the clock's marks. Random bytes:
`import * as crypto from "gk:crypto"` (`randomBytes`, `getRandomValues`),
hashing: `crypto.sha1`, `sha256`, `sha512`, `ripemd160`, `hash160`,
`hmac(hash, key, data)`, `pbkdf2`, and secp256k1 (`publicKey`, `ecdsaSign`,
`schnorrSign`, the BIP-32 and Taproot tweaks...), all native: don't write
hashes or curve arithmetic in JavaScript, and don't vendor JS crypto
libraries. To keep data while the person uses
other apps (until power-off; never on the card): `gk:session`'s
`set(key, value)` and `get(key)`. Code written for WebCrypto needs the adapter in
[API.md](API.md#gkcrypto). Don't add npm dependencies; vendor plain ES
modules into the app if you must, and check they use nothing above.

## Languages

Write text in English through `t()` from `gk:i18n`, with what varies as
params: `t("Signed {n} of {total} inputs.", { n, total })`, `plural(n,
"{n} code", "{n} codes")`. Never build sentences by joining pieces, and
never put an amount, address or seed word inside the text itself: a
translation must keep the same `{names}` or it is refused. Numbers and
amounts: `formatNumber`, `formatBtc` (satoshis in, never floats),
`parseBtc`; dates: `formatDateTime` (ISO, the same in every language).
Translations go in `lang/<language>.json`: `python3 tools/i18n.py extract
apps/myapp --lang pt-BR`, fill them in, `python3 tools/i18n.py check
apps/myapp`. Look at the app with `tools/gksim --lang pt-BR` and `--lang qps`
(text that missed `t()` stays plain; text that overflows shows). Example:
`apps/clock`. Details: [APPS.md](APPS.md#languages).
Styled words in a label (`<tt>`, `<span color=...>`): `new ui.Label({
markup: true, text: tm("Pay <tt>{address}</tt>", { address }) })`; data goes
in through `tm()` or `ui.escapeMarkup`, never pasted into markup
([APPS.md](APPS.md#markup)).

## Rules that are easy to get wrong

- **Unknown properties throw.** `new ui.Label({ txt: "x" })` is a
  `TypeError`. Check names against [API.md](API.md).
- **Many properties are write-only.** Only those marked *readable* return a
  value; keep your own state in JavaScript rather than reading it back
  from widgets.
- **Keyboard first.** The device may have no mouse. Every action must be
  reachable with Tab, Shift+Tab, arrows, Enter and Space; call `focus()` on
  the first input of each screen. Holding Enter never repeats a click.
- **The Windows key belongs to the system**: it always returns to the
  launcher. Don't build on it.
- **Don't block the first screen.** Code at the top level of `main.js` and
  everything its promises do before yielding runs before anything is drawn.
  Build the screen, log "ready", then start long work, and split it with
  `await new Promise((r) => setTimeout(r, 0))` between steps. The simulator
  reports the work an app does as "about N ms of JavaScript on a Pi Zero";
  the Zero is 10 to 50 times slower than your machine.
- **A handler may run 10 s at most**, then it is interrupted (the app keeps
  running).
- **Containers don't scroll** unless `scrollable: true`. The screen and
  Panels do. A scrollable Container clips its content and needs 5 px of
  padding for focus rings (it gets that by default). The mouse wheel
  scrolls the scrollable widget under the pointer (`wheel <n>` in
  scenarios), and Shift+PageUp/PageDown scroll the focused widget's
  scrollable ancestor by a page (the system takes those keys before
  `ui.onKey`); focusing a widget with Tab scrolls it into view.
- **Every app must work with a keyboard alone:** no mouse is guaranteed.
  Anything clickable is focusable, and anything done by pointer (drawing,
  dragging) has a key way too.
- **Rebuilding a screen:** `ui.screen.clear()` deletes every widget; then
  create the new ones. Deleting a widget inside its own handler is safe.
- **Log lines are at most 2 KB.** Split big dumps.
- **QR codes come in through `ui.Scanner`** (`detect: ["qr"]`, permission
  `"camera"`): you get the decoded bytes, never pixels. Test with `camera qr <text>` in
  scenarios ([CAMERA.md](CAMERA.md)), and don't log what a code holds.
- **Images are raw RGBA** (`{ width, height, data }`); there is no PNG or JPEG
  decoder.

## Done means

1. The app starts, logs "ready", and its screenshot looks right at 640x480
   and at a large size (`--size 1824x984`).
2. Every action works from the keyboard alone (a scenario that only uses
   `key` and `type`).
3. Mistakes in input are refused with a clear message on screen.
4. A scenario in `tests/` checks the main path, and `tools/run_sim_tests.sh`
   passes.
5. The simulator's work estimate for start-up is well under a second.

## Air-gapped manners

Show the inputs and the steps of anything important you derive (a seed, a
checksum), so a person can check it by hand. Prefer formats with checksums
and verify what is typed. Keep secrets on screen only as long as needed,
and offer a way to clear them. More in [APPS.md](APPS.md#guidelines-for-air-gapped-apps).
