# The browser IDE

Write and run zerogap apps in a web browser, with no Pi and no QEMU. It is
a static page: the zerogap simulator (the real runtime, LVGL and QuickJS
compiled to WebAssembly from `sim/`), a Monaco editor and a file tree. There
is no server code, and the page needs no network once it is set up.

## Starting it

```sh
tools/zgide.sh          # or: tools/zgide.sh 8080
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

## The panes

- **SD card** (left): the apps on the simulated card, `apps/<id>/...`.
  Click a file to edit it, a folder to open or close it. **New app** makes
  one from a template (a manifest and a `main.js` with a label and a
  button). **New file** adds one to the selected app or folder (`lib/x.js`
  makes the folder too). **Rename** and **Delete** act on the selection;
  renaming an app also changes the `id` in its manifest. **Import** takes a
  folder from your computer: one app's folder, or a folder of apps (a card's
  `apps/`). **Export .zip** downloads the selected app. **Examples** adds back
  any of `launcher`, `hello`, `gallery`, `dice39` and `qrscan` that you deleted. A dot marks
  unsaved files, a triangle the running app.
- **Editor** (middle): Monaco, as in VS Code. JavaScript is checked as
  zerogap runs it: ES2023 modules, no DOM (`document`, `fetch` are errors),
  with completions and hovers for `zg:ui`, `zg:sys`, `zg:crypto` and
  `zg:apps` from `sim/web/types/zerogap.d.ts`. `manifest.json` is checked
  against the manifest's rules (keys, id, icon names).
- **Screen** (right): zerogap's screen at its true size, scaled to fit in
  whole steps when it fits. **Run** saves everything, boots a fresh machine
  with the card and starts the app whose file is open (if it doesn't start,
  the log says why and you stay on the launcher). **Stop** halts the machine.
  **Home** goes back to the launcher. **Restart** boots again into the
  launcher, as switching the device on does. The menu sets the screen size
  (640x480, 800x480, 800x600, 1024x600, 1024x768, 1280x720, 1824x984),
  which reboots.
- **Console** (bottom): zerogap's log. Errors are red. File references in
  stack traces (`main.js:4:2`) and `apps/<id> not loaded` lines are links
  that open the file at that line. `console.log` in an app shows up as
  `app:<id>: ...`.

## Experimental features

The **Experimental** box in the screen's toolbar puts `experimental = yes`
in the simulated card's `zerogap.txt` and reboots: experimental apps (Color
QR) are listed, and the `"qr-color"` detector exists
([EXPERIMENTAL.md](EXPERIMENTAL.md)). The camera bar's pictures and webcam
frames reach the simulator in colour.

## Keyboard

- **Ctrl+S** (Cmd+S on a Mac) saves the open file; **Ctrl+Enter** runs.
- Click the screen to give it the keyboard (a yellow outline shows it has
  it). Then every key goes to zerogap: Tab, arrows, Enter, Backspace, Escape
  and Ctrl shortcuts included, and Ctrl+S and Ctrl+Enter go to the app, not
  the IDE. Click the editor to type there again.
- **Ctrl+V** (Cmd+V) on the screen types the clipboard's text into zerogap,
  as key presses: a codex32 share, a test address. ASCII only; a newline
  inside it is Enter, one at the end is dropped. A simulator convenience:
  the device has no clipboard.
- zerogap's Home key is the Windows (Super) key, which the desktop or the
  browser usually keeps for itself: use the **Home** button.
- The mouse works on the screen; zerogap draws its own cursor, so the
  browser's is hidden there.
- Held keys repeat at zerogap's own rate, as on the device.

## Where your work is

In the browser's IndexedDB, for this address (`127.0.0.1:<port>`): reloading
or closing the browser keeps it, and a different port or browser starts
empty (with the examples). Clearing the site's data erases it. Nothing is
written to the repository. To keep an app, or move it to the repository,
**Export .zip** it. The IDE warns before leaving the page with unsaved
edits.

For scripts and agents, the page exposes `window.zgide`: `run(id)`,
`openFile(path, line)`, `home()`, `files` (path to contents), `machine` (the
`Zerogap` instance of `sim/web/zerogap.js`), `editor`, `monaco`.

## The camera

Under the screen, **Camera** sets what zerogap's camera films, for apps
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
are asked for again). zerogap decodes the codes itself, with the decoder it
has on the Pi; the IDE only supplies pictures.

## Changing the launcher

The launcher is an app too (`apps/launcher` in the repository), but built
into zerogap rather than read from the card: the device refuses a card app
named `launcher`. In the IDE, `launcher` (marked *built in*) is a copy you
can edit: at each boot it replaces the built-in launcher, in the simulator
only, with the built-in launcher's rights (`zg:apps`). Restart or Run shows
your changes.

zerogap starts with the launcher, so a launcher that fails to load stops
the boot: the log links to the error. Fix it, or delete `apps/launcher` to
get the built-in one back (**Examples** brings back a fresh copy).

To put your launcher on the device, **Export .zip** it, unzip it over
`apps/launcher` in the repository and rebuild the kernel.

## Putting an app on a real SD card

Export the app, then unzip it into the `apps` folder of the card (the zip
holds one folder named after the app's id):

```sh
cd /media/$USER/<card>/apps && unzip ~/Downloads/myapp.zip
```

zerogap reads the card at boot, so restart the Pi. See
[APPS.md](APPS.md#installing-apps). The launcher shows the app's SHA-256;
`python3 tools/bundle_apps.py --hash <folder>` computes it on your computer
to compare.

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
