// Writes codex32-like shares (BIP-93's example shares, public) on the
// e-paper panel, as text and as a QR code, one panel each, as a person
// would with codex32's shares. tests/epaper.txt drives it from the
// keyboard ("1", "2": write that share; "o": close and reopen the panel,
// portrait then landscape), plugs panels in and out, and checks the
// panel's pictures (tests/epaper/check_panel.py). Logs what happens, never
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

let busy = false;
async function write(n) {
  if (busy) return;
  busy = true;
  status.text = `Writing share ${n + 1}...`;
  draw(n);
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
    status.text = `Share ${n + 1} written: you can unplug the panel.`;
    console.log(`epapertest wrote ${n + 1}`);
  } catch (e) {
    status.text = e.message;
    console.log(`epapertest failed ${n + 1}: ${e.name}: ${e.message}`);
  }
  busy = false;
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
  return false;
});

console.log("epapertest ready");
