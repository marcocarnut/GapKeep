// Writes codex32-like shares (BIP-93's example shares, public) on the
// e-paper panel, as text and as a QR code, one panel each, as a person
// would with codex32's shares. tests/epaper.txt drives it from the
// keyboard ("1", "2": write that share; "t": a page of text sizes; "o":
// close and reopen the panel, portrait then landscape; "r", "w": read the
// share back with the camera, its centre or its whole field), plugs
// panels in and out, and checks the panel's pictures (tests/epaper/check_panel.py). Logs what happens, never
// what a share says. On a machine without a panel (QEMU) it logs why.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";

export const SHARES = [
  "MS12NAMEA320ZYXWVUTSRQPNMLKJHGFEDCAXRPP870HKKQRM",
  "MS12NAMECACDEFGHJKLMNPQRSTUVWXYZ023FTR2GDZMPY6PN",
];

new ui.Label({ text: "E-paper test", font: 24 });
const status = new ui.Label({ text: "Press 1 or 2 to write a share." });

function check(name, fn) {
  try {
    fn();
    console.log(`epapertest: ok ${name}`);
  } catch (e) {
    console.log(`epapertest: FAIL ${name}: ${e && e.message ? e.message : e}`);
  }
}
function throws(fn, type, pattern) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof type) || !pattern.test(e.message)) throw new Error(`${e.name}: ${e.message}`);
    return;
  }
  throw new Error("did not throw");
}

try {
  console.log(`epapertest info: ${JSON.stringify(ui.epaper.info())}`);
} catch (e) {
  console.log(`epapertest info failed: ${e.name}: ${e.message}`);
}

let panel = null;
function open(options) {
  panel = ui.epaper.open(options);
  console.log(`epapertest open: ${panel.model}, ${panel.width}x${panel.height}, ${panel.colors.join(" ")}`);
}
try {
  open();
} catch (e) {
  console.log(`epapertest open failed: ${e.name}: ${e.message}`);
}

if (panel) {
  check("open twice", () => throws(() => ui.epaper.open(), TypeError, /open already/));
  check("unknown option", () => throws(() => ui.epaper.open({ rotate: 1 }), TypeError, /unknown option "rotate"/));
  check("bad orientation", () => throws(() => ui.epaper.open({ orientation: "up" }), TypeError, /"landscape" or "portrait"/));
  check("a Container", () => {
    if (!(panel instanceof ui.Container)) throw new Error("not a Container");
  });
}

// "MS12 NAME A320" / ...: three groups of four a line
function lines(share) {
  const groups = share.match(/.{1,4}/g);
  const out = [];
  for (let i = 0; i < groups.length; i += 3) out.push(groups.slice(i, i + 3).join(" "));
  return out.join("\n");
}

function draw(n) {
  panel.clear();
  const row = new ui.Container(panel, { layout: "row", gap: 6, alignItems: "center", width: "100%", height: "100%" });
  new ui.QRCode(row, { data: SHARES[n], size: panel.height - 8 });
  const text = new ui.Container(row, { layout: "column", gap: 2, grow: 1 });
  new ui.Label(text, { text: `Share ${"AB"[n]}`, font: 20, color: 0xff0000 });
  new ui.Label(text, { text: lines(SHARES[n]), mono: true, font: 16 });
}

// The text sizes, for reading on the real panel (tests/epaper_hw.txt): no
// secret on it.
function drawType() {
  panel.clear();
  const sample = "0O1lI 5S8B 2Z rn m";
  for (const [font, mono] of [[12, false], [12, true], [14, false], [14, true], [16, true], [20, true]]) {
    new ui.Label(panel, { text: `${font}${mono ? " mono" : ""}: ${sample}`, font, mono });
  }
}

let busy = false;
let last = -1;          // the share written last
async function write(n) {
  if (busy) return;
  busy = true;
  const what = n < 0 ? "the type test" : `share ${n + 1}`;
  if (scanner) {
    scanner.delete();
    scanner = null;
  }
  status.text = `Writing ${what}...`;
  if (n < 0) drawType();
  else draw(n);
  // how long the screen waits, at most, while the panel is written: a
  // timer every 5 ms, the longest gap between two of its calls
  let gap = 0, then = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    gap = Math.max(gap, now - then);
    then = now;
  }, 5);
  let half = false;
  try {
    await panel.refresh({
      onProgress: (f) => {
        if (f > 0.05 && !half) {
          half = true;
          console.log("epapertest progress: the waveform runs");
        }
      },
    });
    status.text = `Written (${what}): you can unplug the panel.`;
    console.log(n < 0 ? "epapertest wrote the type test" : `epapertest wrote ${n + 1}`);
    if (n >= 0) last = n;
  } catch (e) {
    status.text = e.message;
    console.log(`epapertest failed ${n < 0 ? "type test" : n + 1}: ${e.name}: ${e.message}`);
  }
  clearInterval(timer);
  console.log(`epapertest longest gap: ${gap} ms`);
  busy = false;
}

// Reads the panel back with the camera ("camera" permission): the share
// written last, compared here; the log says which share it saw, never what
// it says. field: "center" or "full".
let scanner = null;
function readBack(field) {
  if (last < 0) return;
  if (scanner) scanner.delete();
  const want = last;
  console.log(`epapertest reading back share ${want + 1} (${field})`);
  status.text = `Reading share ${want + 1} back: point the camera at the panel.`;
  scanner = new ui.Scanner({
    detect: ["qr"],
    field,
    onDetect: ({ text, bytes }) => {
      const seen = SHARES.indexOf(text);
      if (seen === want) {
        // (the scanner goes on, for the camera's pictures, until the next write)
        console.log(`epapertest read back share ${want + 1}: it is on the panel`);
        status.text = `Share ${want + 1} read back from the panel.`;
      } else if (seen >= 0) {
        console.log(`epapertest read back: share ${seen + 1}, not ${want + 1}`);
      } else {
        console.log(`epapertest read back: another code, ${bytes.length} bytes`);
      }
    },
    onError: ({ reason }) => console.log(`epapertest read back failed: ${reason}`),
  });
}

function reopen() {
  panel.close();
  check("closed", () => {
    if (panel.alive) throw new Error("still alive");
    throws(() => panel.refresh(), TypeError, /deleted/);
  });
  open({ orientation: "portrait" });
  panel.close();
  open();
}

ui.onKey((ev) => {
  if (!panel) return false;
  if (ev.key === "1" || ev.key === "2") {
    write(Number(ev.key) - 1);
    return true;
  }
  if (ev.key === "o") {
    reopen();
    return true;
  }
  if (ev.key === "t") {
    write(-1);
    return true;
  }
  if (ev.key === "r" || ev.key === "w") {
    readBack(ev.key === "r" ? "center" : "full");
    return true;
  }
  return false;
});

console.log("epapertest ready");
