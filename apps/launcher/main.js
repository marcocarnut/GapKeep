// The GapKeep launcher: lists the apps (built in, then those from the SD
// card's /apps folder) and starts the chosen one. It is an ordinary app with
// one extra permission ("apps" in manifest.json), which gives it the gk:apps
// module.
//
// Below the tiles it shows where the focused app came from and its SHA-256
// (docs/APPS.md, "App hashes"), so it can be checked against a published
// one before the app is opened, the hash of each data folder it reads
// ("Data files"), and any app on the card that was not loaded.
//
// A suite (apps/<suite>/suite.json, "Suites") is one tile; Enter opens it,
// showing its apps; Back, Escape or Backspace return. Coming back from one
// of its apps opens the suite again (remembered with gk:session).
//
// Its text is translated (gk:i18n, lang/<language>.json). Its catalogs are
// also the system's: they translate the runtime's own messages, like
// gk:i18n's parseBtc errors (docs/APPS.md, "Languages").

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as apps from "gk:apps";
import * as session from "gk:session";
import { rngStatus } from "gk:crypto";
import { t, plural, formatNumber } from "gk:i18n";

const list = apps.list();
const card = apps.card();
const rng = rngStatus();

ui.screen.set({ padding: [20, 28], gap: 16 });

// header
const header = new ui.Container({ width: "100%", layout: "row", alignItems: "end", gap: 12 });
new ui.Label(header, { text: "GapKeep", font: 32 });
new ui.Label(header, {
  text: "v" + sys.version.gapkeep,
  color: "#8a9199",
  font: 14,
  grow: 1,
});
const cardText = {
  ok: t("SD card"),
  none: t("no SD card"),
  unreadable: t("SD card not readable"),
  "no-apps": t("no /apps on the SD card"),
  disabled: t("sealed"),
}[card.status];
new ui.Label(header, {
  text: plural(list.length, "{n} app", "{n} apps") + "  |  " + cardText,
  color: "#8a9199",
  font: 14,
  maxWidth: "60%",      // a long translation is cut, not the version
  overflow: "dots",
});

// a failing random number generator must be impossible to miss
if (!rng.healthy) {
  new ui.Label({
    text: ui.symbols.warning + " " +
      t("The hardware random number generator failed its health check ({failure}). Apps cannot get random numbers.",
        { failure: rng.failure }),
    color: "#e05050",
    width: "100%",
  });
}

// A suite (docs/APPS.md, "Suites") is one tile; opening it shows its apps,
// with a Back button (Escape or Backspace too)
const suiteBar = new ui.Container({
  width: "100%",
  layout: "row",
  alignItems: "center",
  gap: 12,
  hidden: true,
});
const backButton = new ui.Button(suiteBar, {
  text: ui.symbols.left + " " + t("Back"),
  onClick: () => goHome(),
});
const suiteTitle = new ui.Label(suiteBar, { text: "", font: 20 });
const suiteText = new ui.Label(suiteBar, {
  text: "",
  color: "#8a9199",
  font: 12,
  grow: 1,
  overflow: "dots",
});

// app tiles
const grid = new ui.Container({
  width: "100%",
  grow: 1,
  layout: "row-wrap",
  gap: 16,
  scrollable: true,
});

// the home screen's tiles: apps, and a suite where its first app would be
const suites = new Map(apps.suites().map((s) => [s.id, { ...s, apps: [] }]));
const home = [];
for (const app of list) {
  const suite = app.suite && suites.get(app.suite);
  if (!suite) {
    home.push({ app });
    continue;
  }
  if (suite.apps.length === 0) home.push({ suite });
  suite.apps.push(app);
}

let tiles = [];
let focused = 0;
let openSuite = null;   // the suite shown, or null: the home screen

function addTile({ app, suite }, i) {
  const item = app || suite;
  const tile = new ui.Button(grid, {
    width: 180,
    height: 150,
    layout: "column",
    justify: "center",
    alignItems: "center",
    gap: 4,
    padding: 10,
    onClick: () => (app ? apps.launch(app.id) : showSuite(suite.id)),
    onFocus: () => {
      focused = i;
      tile.scrollIntoView();
      if (app) showDetails(app);
      else showSuiteDetails(suite);
    },
  });
  if (item.image) {
    // 64 x 64 (a smaller picture shows as it is, a larger one is scaled down)
    const big = item.image.width > 64 || item.image.height > 64;
    // rounded corners: opaque square art (a favicon) sits better on the tile
    new ui.Image(tile, big ? { src: item.image, width: 64, height: 64, radius: 12 }
                           : { src: item.image, radius: 12 });
  } else {
    new ui.Label(tile, { text: item.icon, font: 40 });
  }
  new ui.Label(tile, {
    text: suite ? item.name + " " + ui.symbols.right : item.name,
    font: 18,
    width: "100%",
    textAlign: "center",
    overflow: "dots",
  });
  new ui.Label(tile, {
    text: item.description,
    font: 12,
    width: "100%",
    textAlign: "center",
    overflow: "dots",
    maxHeight: 32,
  });
  tiles.push(tile);
}

function showTiles(items) {
  grid.clear();
  tiles = [];
  items.forEach(addTile);
  if (tiles.length === 0) {
    details.text = "";
    new ui.Label(grid, { text: t("No apps installed."), color: "#8a9199" });
  }
}

// the home screen; focus: the tile to focus (a suite's id when coming back from it)
function showHome(focusId) {
  openSuite = null;
  session.remove("suite");
  suiteBar.hidden = true;
  showTiles(home);
  const i = Math.max(0, home.findIndex((h) => (h.app || h.suite).id === focusId));
  if (tiles.length) tiles[i].focus();
  return home.map((h) => (h.app || h.suite).id);
}

function showSuite(id) {
  const suite = suites.get(id);
  openSuite = suite;
  session.set("suite", id);
  suiteTitle.text = suite.name;
  suiteText.text = suite.description;
  suiteBar.hidden = false;
  showTiles(suite.apps.map((app) => ({ app })));
  if (tiles.length) tiles[0].focus();
  console.log("launcher suite " + id + ": " + suite.apps.map((a) => a.id).join(", "));
  console.log("launcher shows suite " + id + " as \"" + suite.name + "\"");
}

function goHome() {
  console.log("launcher home: " + showHome(openSuite?.id).join(", "));
}

// apps on the card that were not loaded, and why (scrolls if there are many)
const problems = card.problems.length
  ? new ui.Container({ width: "100%", layout: "column", gap: 2, maxHeight: 84, scrollable: true })
  : null;
for (const p of card.problems) {
  new ui.Label(problems, {
    text: ui.symbols.warning + " " + t("apps/{folder} not loaded: {error}", { folder: p.folder, error: p.error }),
    color: "#e0a030",
    font: 12,
    width: "100%",
  });
}

// the focused app: where it came from, and its hash; and the hash of each
// data folder it reads (docs/APPS.md, "Data files"), which is not part of
// the app's hash: whoever prepared the card chose those files
const details = new ui.Label({ text: "", color: "#8a9199", font: 12, width: "100%" });
const dataHashes = new Map();
function dataLine(folder) {
  if (!dataHashes.has(folder)) {
    let text;
    try {
      const hash = apps.dataHash(folder);
      text = hash ? "data/" + folder + " SHA-256 " + hash
                  : t("data/{folder}: not on the SD card", { folder });
    } catch (e) {
      text = ui.symbols.warning + " " + e.message;
    }
    dataHashes.set(folder, text);
  }
  return dataHashes.get(folder);
}
function showDetails(app) {
  const path = app.suite ? app.suite + "/" + app.id : app.id;
  const where = app.source === "sdcard" ? t("SD card, apps/{id}", { id: path }) : t("built in");
  details.text = [app.name + " " + app.version + "  |  " + where, "SHA-256 " + app.hash,
                  ...app.data.map(dataLine)].join("\n");
}
function showSuiteDetails(suite) {
  details.text = suite.name + "  |  " + t("SD card, apps/{id}", { id: suite.id }) + "  |  " +
    plural(suite.apps.length, "{n} app", "{n} apps");
}

// "i": what is running, to check against published hashes
function showSystem() {
  const k = sys.kernel;
  // the command stays as it is typed: its number is not written the language's way
  ui.alert(
    t("GapKeep {version} ({build} build)", { version: sys.version.gapkeep, build: k.build }) + "\n\n" +
      t("Kernel: SHA-256 of the first {bytes} bytes of kernel.img\n(its code and constants, as running now):",
        { bytes: formatNumber(k.hashedBytes) }) + "\n" + k.hash + "\n\n" +
      t("Check on another computer:") + "\n" +
      "head -c " + k.hashedBytes + " kernel.img | sha256sum\n\n" +
      (rng.healthy ? t("Random number generator: healthy")
                   : t("Random number generator: FAILED: {failure}", { failure: rng.failure })) + "\n" +
      "Circle " + sys.version.circle + ", LVGL " + sys.version.lvgl + ", QuickJS " + sys.version.quickjs,
    { title: t("System") },
  );
}

// arrow keys move between tiles (Tab and Shift+Tab work too); Escape or
// Backspace leave a suite
ui.onKey((ev) => {
  if (ev.key === "i" && !ev.ctrl && !ev.alt) {
    showSystem();
    return true;
  }
  if ((ev.key === "Escape" || ev.key === "Backspace") && openSuite) {
    goHome();
    return true;
  }
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
  if (step === undefined || tiles.length === 0) return false;
  focused = (focused + step + tiles.length) % tiles.length;
  tiles[focused].focus();
  return true;
});

new ui.Label({
  text: t("Arrows or Tab: move    Enter: open    i: system info    Windows key: back to this screen"),
  color: "#6b737b",
  font: 12,
  width: "100%",        // wraps if a translation is longer
});

// back from an app of a suite: that suite again
const lastSuite = session.get("suite");
console.log("launcher ready:", showHome().join(", "));
console.log("sd card:", card.status, card.problems.length, "problem(s)");
console.log("kernel:", sys.kernel.build, sys.kernel.hashedBytes, sys.kernel.hash, "rng:", rng.healthy ? "healthy" : rng.failure);
if (suites.get(lastSuite)?.apps.length) showSuite(lastSuite);
