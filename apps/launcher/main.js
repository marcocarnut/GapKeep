// The zerogap launcher: lists the bundled apps and starts the chosen one.
// It is an ordinary app with one extra permission ("apps" in manifest.json),
// which gives it the zg:apps module.

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as apps from "zg:apps";

const list = apps.list();

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
new ui.Label(header, {
  text: list.length + (list.length === 1 ? " app" : " apps"),
  color: "#8a9199",
  font: 14,
});

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

if (tiles.length === 0) {
  new ui.Label(grid, { text: "No apps installed.", color: "#8a9199" });
} else {
  tiles[0].focus();
}

// arrow keys move between tiles (Tab and Shift+Tab work too)
ui.onKey((ev) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
  if (step === undefined || tiles.length === 0) return false;
  focused = (focused + step + tiles.length) % tiles.length;
  tiles[focused].focus();
  return true;
});

new ui.Label({
  text: "Arrows or Tab: move    Enter: open    Windows key: back to this screen",
  color: "#6b737b",
  font: 12,
});

console.log("launcher ready:", list.map((a) => a.id).join(", "));
