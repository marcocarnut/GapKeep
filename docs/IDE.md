# The browser IDE

Write and run GapKeep apps in a web browser, with no Pi and no QEMU. It is
a static page: the GapKeep simulator (the real runtime, LVGL and QuickJS
compiled to WebAssembly from `sim/`), a Monaco editor and a file tree. There
is no server code, and the page needs no network once it is set up.

## Starting it

```sh
tools/gkide.sh          # or: tools/gkide.sh 8080
```

It builds the simulator if needed (`make -C sim web`, with emsdk from
`~/emsdk`), fetches the pinned Monaco editor once (`tools/fetch_monaco.sh`,
checked against the hash npm published for it), copies the example apps for
the IDE to load, and serves `sim/` on 127.0.0.1. Open the URL it prints,
<http://127.0.0.1:8039/web/index.html>. It is tested in Chrome; other
current browsers should work.

The simulator and the examples are built and copied when it starts, not
while it runs: after pulling changes, stop it and start it again (or run
`make -C sim web`), then reload the page and click **Examples** for new
example apps. A page newer than its simulator says so in the browser's
console (and its camera sends grey).

GapKeep's screen comes first: the page boots the simulator, then loads
the editor (Monaco, several MB) while you look at the launcher.

## Links

The address takes two parameters, for links that start GapKeep in a
given state (the website's "try this app" links):

- `?run=<app-id>` boots straight into that app, as **Run** would, with its
  `main.js` open in the editor: `web/index.html?run=dice39`. The id is one
  of the apps on the IDE's card (an app in a suite works too); an example
  app deleted in this browser is added back first. An unknown id boots the
  launcher, with a line in the console saying so.
- `?lang=<language>` boots in that language: `language = pt-BR` in the
  simulated card's `gapkeep.txt` ([APPS.md](APPS.md), "The language"), for
  every boot of that page. An unknown language is English, with a line in
  the log.

They combine: `web/index.html?run=dice39&lang=pt-BR`.

## Phones

On a narrow window (up to 760 px wide, or a phone on its side) the IDE is
one column that scrolls:

- **The screen** first, as wide as the page (any scale: 640 px is wider
  than a phone; smoothed when whole pixels can't be kept). The run
  controls (**Run**, **Stop**, **Home**, **Restart**, the screen size) are
  above it and stay at the top of the page as it scrolls. **Experimental**
  is on the desktop layout only.
- **Touch**: a tap is a click where the finger touched, and brings up the
  phone's keyboard (typed text goes to GapKeep, as from a computer's
  keyboard). A finger held still presses, and then drags (sliders); moved
  sideways, it drags at once. A swipe up or down turns GapKeep's mouse
  wheel where it started, one notch per 60 screen pixels, so the content
  roughly follows the finger.
- **The key bar**, under the screen, has the keys phone keyboards lack:
  Esc, Tab, Shift+Tab (⇧Tab), **Home** (the Windows key: back to the
  launcher), Backspace (⌫), the four arrows and Enter. A held key repeats,
  as on the device. The keys don't take the focus, so the phone's
  keyboard stays up. ⌨ hides the phone's keyboard (taps on the screen then
  leave it hidden) or brings it back.
- **SD card**, **editor** and **console** come below, folded: tap a
  pane's bar to unfold it. The editor is loaded the first time it is
  unfolded (or a file is opened), not before: on a phone the first thing
  loaded is GapKeep itself. The console unfolds by itself when a `?run=`
  link names no app.

Wider windows have the panes described below, side by side, and no key
bar.

What needs a real phone to check (headless Chrome's touch emulation was
used): Android keyboards that compose whole words (Gboard's suggestions)
send a word when it is finished (a space, or a suggestion picked), not
letter by letter; a Backspace that such a keyboard sends only as an edit
of the hidden textarea is taken as GapKeep's Backspace.

- **SD card** (left): the apps on the simulated card, `apps/<id>/...`.
  Click a file to edit it, a folder to open or close it. **New app** makes
  one from a template (a manifest and a `main.js` with a label and a
  button). **New file** adds one to the selected app or folder (`lib/x.js`
  makes the folder too). **Rename** and **Delete** act on the selection;
  renaming an app also changes the `id` in its manifest. **Import** takes a
  folder from your computer: one app's folder, or a folder of apps (a card's
  `apps/`). **Export .zip** downloads the selected app. **Examples** adds back
  any of the example apps that you deleted: `launcher`, `settings`, `hello`,
  `gallery`, `dice39`, `qrscan`, `clock`, `totp`, `codex32`, `signer` and
  `colorqr` (the list is `EXAMPLES` in `tools/gkide.sh`). A dot marks
  unsaved files, a triangle the running app.
- **Editor** (middle): Monaco, as in VS Code. JavaScript is checked as
  GapKeep runs it: ES2023 modules, no DOM (`document`, `fetch` are errors),
  with completions and hovers for every `gk:*` module (`gk:ui`, `gk:sys`,
  `gk:crypto`, `gk:clock`, `gk:session`, `gk:i18n`, `gk:apps`) from
  `sim/web/types/gapkeep.d.ts`. `manifest.json` is checked
  against the manifest's rules (keys, id, icon names).
- **Screen** (right): GapKeep's screen at its true size, scaled to fit in
  whole steps when it fits. **Run** saves everything, boots a fresh machine
  with the card and starts the app whose file is open (if it doesn't start,
  the log says why and you stay on the launcher). **Stop** halts the machine.
  **Home** goes back to the launcher. **Restart** boots again into the
  launcher, as switching the device on does. The menu sets the screen size
  (640x480, 800x480, 800x600, 1024x600, 1024x768, 1280x720, 1824x984),
  which reboots.
- **Console** (bottom): GapKeep's log. Errors are red. File references in
  stack traces (`main.js:4:2`) and `apps/<id> not loaded` lines are links
  that open the file at that line. `console.log` in an app shows up as
  `app:<id>: ...`.

## Experimental features

The **Experimental** box in the screen's toolbar puts `experimental = yes`
in the simulated card's `gapkeep.txt` and reboots: experimental apps (Color
QR) are listed, and the `"qr-color"` detector exists
([EXPERIMENTAL.md](EXPERIMENTAL.md)). The camera bar's pictures and webcam
frames reach the simulator in colour.

## Keyboard

- **Ctrl+S** (Cmd+S on a Mac) saves the open file; **Ctrl+Enter** runs.
- Click the screen to give it the keyboard (a yellow outline shows it has
  it). Then every key goes to GapKeep: Tab, arrows, Enter, Backspace, Escape
  and Ctrl shortcuts included, and Ctrl+S and Ctrl+Enter go to the app, not
  the IDE. Click the editor to type there again.
- **Typing text** goes through your computer's keyboard layout: dead keys
  (" then a is ä, ´ then e is é), AltGr, Option on a Mac and input methods
  all work, and GapKeep gets the character they make. It types ASCII and
  Latin-1 (á, ç, ã, £, ²); anything else (€, emoji) is dropped, with a
  warning in the log the first time. On the device it is GapKeep's own
  layout that makes characters (`keyboard` in `gapkeep.txt`): in the
  browser, leave it at `us`: with `br-abnt2`, a ´ ` ~ ^ or ¨ that your
  layout types would be a dead key again in GapKeep.
- **Ctrl+V** (Cmd+V) on the screen types the clipboard's text into GapKeep,
  as key presses: a codex32 share, a test address. ASCII and Latin-1; a
  newline inside it is Enter, one at the end is dropped. A simulator
  convenience: the device has no clipboard.
- GapKeep's Home key is the Windows (Super) key, which the desktop or the
  browser usually keeps for itself: use the **Home** button.
- The mouse works on the screen; GapKeep draws its own cursor, so the
  browser's is hidden there.
- Held keys repeat: Backspace, arrows and the other special keys at
  GapKeep's own rate, as on the device; letters as your computer repeats
  them.

How (for those changing the IDE): a hidden textarea beside the screen has
the focus while you type there, as in terminals in browsers. Text comes
only from its input and composition events, so the OS's layout applies;
special keys and Ctrl or Alt shortcuts only from keydown. A key takes one
path, never both, so nothing is typed twice: `sim/web/textinput.js`, tested
under Node by `tests/web/textinput.mjs` (run by `tools/run_sim_tests.sh`;
end to end with the WebAssembly build if `make -C sim web TEST=1` was
run), and in headless Chrome by `tests/web/ide_typing.py` (by hand: it
needs Chrome and Monaco).

## Where your work is

In the browser's IndexedDB, for this address (`127.0.0.1:<port>`): reloading
or closing the browser keeps it, and a different port or browser starts
empty (with the examples). Clearing the site's data erases it. Nothing is
written to the repository. To keep an app, or move it to the repository,
**Export .zip** it. The IDE warns before leaving the page with unsaved
edits.

For scripts and agents, the page exposes `window.gkide`: `run(id)`,
`openFile(path, line)`, `home()`, `files` (path to contents), `machine` (the
`Gapkeep` instance of `sim/web/gapkeep.js`), `editor`, `monaco`.

## The camera

Under the screen, **Camera** sets what GapKeep's camera films, for apps
with `ui.Scanner` ([CAMERA.md](CAMERA.md)):

- **Empty scene**: nothing in particular.
- **QR code**: a code of the text you type. With **one per line**, each line
  is a code, shown in turn twice a second: an animated code, for apps that
  read data in parts.
- **Webcam**: your computer's camera (the browser asks first), 15 frames a
  second, at up to 1920×1080. Hold a code up to it. As on the Pi, the
  scanner sees the middle 640×480 at full detail by default (a narrow
  view: hold the code in the middle), or the whole picture with
  `field: "full"`.
- **Picture...**: an image file, in any format the browser reads.
- **No camera**: as a Pi without one.

Example apps you already have in the IDE stay as they were when it first
added them: to get a newer version of one (say `qrscan`, which now has a
**Wide view** button), delete it and click **Examples**.

The setting stays across reboots and reloads (the webcam and the picture
are asked for again). GapKeep decodes the codes itself, with the decoder it
has on the Pi; the IDE only supplies pictures.

## Changing the launcher

The launcher is an app too (`apps/launcher` in the repository), but built
into GapKeep rather than read from the card: the device refuses a card app
named `launcher`. In the IDE, `launcher` (marked *built in*) is a copy you
can edit: at each boot it replaces the built-in launcher, in the simulator
only, with the built-in launcher's rights (`gk:apps`). Restart or Run shows
your changes.

GapKeep starts with the launcher, so a launcher that fails to load stops
the boot: the log links to the error. Fix it, or delete `apps/launcher` to
get the built-in one back (**Examples** brings back a fresh copy).

To put your launcher on the device, **Export .zip** it, unzip it over
`apps/launcher` in the repository and rebuild the kernel.

## Data files and suites

Data folders ([APPS.md](APPS.md#data-files)) go on the IDE's card with
**Import**: choose a folder named `data` holding one folder per data
folder (`data/pgp/alice.asc`, ...), as on a real card. They show in the
tree as `data`, are saved with the apps, and go on the card at every
boot, binary or not; apps read them with `gk:data`. Delete them as
anything else in the tree.

A suite ([APPS.md](APPS.md#suites)) is imported as a folder of apps (its
folder holds `suite.json` and the apps' folders): it shows in the tree as
one folder. **Run** with a file of one of its apps open starts that app;
the launcher shows the suite as one tile. **Export .zip** exports the
whole suite.

## Putting an app on a real SD card

Export the app, then unzip it into the `apps` folder of the card (the zip
holds one folder named after the app's id):

```sh
cd /media/$USER/<card>/apps && unzip ~/Downloads/myapp.zip
```

GapKeep reads the card at boot, so restart the Pi. See
[APPS.md](APPS.md#installing-apps). The launcher shows the app's SHA-256;
`python3 tools/bundle_apps.py --hash <folder>` computes it on your computer
to compare.

## Serving it with a Content Security Policy

The page has no inline scripts or styles, and needs no CSP of its own. A
site that serves it with one needs at least this (tested in Chrome: the
simulator boots, Monaco and its workers run, no violations):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'
```

- `'wasm-unsafe-eval'`: the simulator is WebAssembly.
- `style-src 'unsafe-inline'`: Monaco makes `<style>` elements and
  `style` attributes as it runs (without it the editor loads but is drawn
  wrong); the IDE's own code sets styles only through the DOM, which a CSP
  allows.
- `worker-src blob:`: Monaco starts its workers (JavaScript checking and
  completions) from `blob:` URLs that load its files from `'self'`.
  Without it, the editor works without them.
- `font-src data:`: Monaco's icon font is inline; `img-src data:`: the
  page's empty favicon.

The webcam (getUserMedia) and pictures (read from the file) need nothing
more.

## Differences from a real Pi Zero

- **Speed**: the browser is much faster than a Pi Zero. Something that
  feels instant here may be slow on the device: try heavy apps on the
  hardware (or in QEMU) before relying on them.
- **No USB events**: the keyboard and mouse are always attached; there is
  no plugging or unplugging.
- **No real SD card**: the card is made from the IDE's files at every boot,
  and an app is checked (manifest, file names, sizes) the same way, but
  card and FAT problems can't happen here.
- The system info shows the kernel's hash as zeros (there is no
  kernel.img). The main loop runs every 4 ms, so timers fire no faster.
