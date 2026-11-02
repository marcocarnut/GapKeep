// The zerogap launcher: lists the apps (built in, then those from the SD
// card's /apps folder) and starts the chosen one. It is an ordinary app with
// one extra permission ("apps" in manifest.json), which gives it the zg:apps
// module.
//
// Below the tiles it shows where the focused app came from and its SHA-256
// (docs/APPS.md, "App hashes"), so it can be checked against a published
// one before the app is opened, and any app on the card that was not loaded.

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as apps from "zg:apps";
import { rngStatus } from "zg:crypto";

const list = apps.list();
const card = apps.card();
const rng = rngStatus();

ui.screen.set({ padding: [20, 28], gap: 16 });

// header
const header = new ui.Container({ width: "100%", layout: "row", alignItems: "end", gap: 12 });
new ui.Label(header, { text: "zerogap", font: 32 });
new ui.Label(header, {
  text: "v" + sys.version.zerogap,
  color: "#8a9199",
  font: 14,
  grow: 1,
});
const cardText = {
  ok: "SD card",
  none: "no SD card",
  unreadable: "SD card not readable",
  "no-apps": "no /apps on the SD card",
  disabled: "sealed",
}[card.status];
new ui.Label(header, {
  text: list.length + (list.length === 1 ? " app" : " apps") + "  |  " + cardText,
  color: "#8a9199",
  font: 14,
});

// a failing random number generator must be impossible to miss
if (!rng.healthy) {
  new ui.Label({
    text: ui.symbols.warning + " The hardware random number generator failed its health check (" +
      rng.failure + "). Apps cannot get random numbers.",
    color: "#e05050",
    width: "100%",
  });
}

// app tiles
const grid = new ui.Container({
  width: "100%",
  grow: 1,
  layout: "row-wrap",
  gap: 16,
  scrollable: true,
});

const tiles = [];
let focused = 0;

list.forEach((app, i) => {
  const tile = new ui.Button(grid, {
    width: 180,
    height: 150,
    layout: "column",
    justify: "center",
    alignItems: "center",
    gap: 6,
    padding: 10,
    onClick: () => apps.launch(app.id),
    onFocus: () => {
      focused = i;
      tile.scrollIntoView();
      showDetails(app);
    },
  });
  new ui.Label(tile, { text: app.icon, font: 40 });
  new ui.Label(tile, { text: app.name, font: 18 });
  new ui.Label(tile, {
    text: app.description,
    font: 12,
    width: "100%",
    textAlign: "center",
    overflow: "dots",
    maxHeight: 32,
  });
  tiles.push(tile);
});

// apps on the card that were not loaded, and why (scrolls if there are many)
const problems = card.problems.length
  ? new ui.Container({ width: "100%", layout: "column", gap: 2, maxHeight: 84, scrollable: true })
  : null;
for (const p of card.problems) {
  new ui.Label(problems, {
    text: ui.symbols.warning + " apps/" + p.folder + " not loaded: " + p.error,
    color: "#e0a030",
    font: 12,
    width: "100%",
  });
}

// the focused app: where it came from, and its hash
const details = new ui.Label({ text: "", color: "#8a9199", font: 12, width: "100%" });
function showDetails(app) {
  const where = app.source === "sdcard" ? "SD card, apps/" + app.id : "built in";
  details.text = app.name + " " + app.version + "  |  " + where + "\nSHA-256 " + app.hash;
}

if (tiles.length === 0) {
  new ui.Label(grid, { text: "No apps installed.", color: "#8a9199" });
} else {
  tiles[0].focus();
}

// "i": what is running, to check against published hashes
function showSystem() {
  const k = sys.kernel;
  ui.alert(
    "zerogap " + sys.version.zerogap + " (" + k.build + " build)\n\n" +
      "Kernel: SHA-256 of the first " + k.hashedBytes + " bytes of kernel.img\n" +
      "(its code and constants, as running now):\n" + k.hash + "\n\n" +
      "Check on another computer:\n" +
      "head -c " + k.hashedBytes + " kernel.img | sha256sum\n\n" +
      "Random number generator: " + (rng.healthy ? "healthy" : "FAILED: " + rng.failure) + "\n" +
      "Circle " + sys.version.circle + ", LVGL " + sys.version.lvgl + ", QuickJS " + sys.version.quickjs,
    { title: "System" },
  );
}

// arrow keys move between tiles (Tab and Shift+Tab work too)
ui.onKey((ev) => {
  if (ev.key === "i" && !ev.ctrl && !ev.alt) {
    showSystem();
    return true;
  }
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
  if (step === undefined || tiles.length === 0) return false;
  focused = (focused + step + tiles.length) % tiles.length;
  tiles[focused].focus();
  return true;
});

new ui.Label({
  text: "Arrows or Tab: move    Enter: open    i: system info    Windows key: back to this screen",
  color: "#6b737b",
  font: 12,
});

console.log("launcher ready:", list.map((a) => a.id).join(", "));
console.log("sd card:", card.status, card.problems.length, "problem(s)");
console.log("kernel:", sys.kernel.build, sys.kernel.hashedBytes, sys.kernel.hash, "rng:", rng.healthy ? "healthy" : rng.failure);
