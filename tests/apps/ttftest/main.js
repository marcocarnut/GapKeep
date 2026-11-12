// Test builds only: text drawn from outlines (src/runtime/fontcache.h),
// what it costs and what it looks like. Keys:
//
//   b, i, m          a paragraph in bold, italic or Medium at 16 px (shift: 28)
//   1, 2, 3, 4       a paragraph in Medium at 12, 24, 48, 96 px (bitmaps at 12
//                    and 24, unless the kernel draws them from outlines:
//                    "#fonts outlines on")
//   f, shift-f       a screenful of text at 50 px, at 120 px
//   q                sizes side by side: 15 16 17 and 23 24 25; rows: Medium,
//                    mono, bold
//   c                every size from ui.fontRange's min to its max, in every
//                    style, drawn one after another: the memory LVGL holds
//                    must stay under the glyphs' cap (plus the fonts), and,
//                    on the next start, be back where it was before
//   e                the errors of sizes out of range
//
// The memory LVGL holds after each is drawn is logged; the drawing times
// come from the kernel ("#fonts", "#redraw": src/testshot.h).
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as session from "gk:session";

const TEXT = "Pay 0.00123456 BTC to the address below, and check it on another screen " +
  "before you sign: ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ç á ã é ü ₿.";
const CAP = 4 * 1024 * 1024;		// GK_FONT_CACHE_CAP (fontcache.h)
const FONTS = 1024 * 1024;		// the fonts without glyphs, 678 at most: well under this
const log = (...a) => console.log("ttftest", ...a);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const box = new ui.Container({ width: "100%", height: "content", layout: "column", gap: 4 });

function ui_bytes() {
  sys.gc();
  return sys.memory().ui;
}

function report(what) {
  setTimeout(() => log(`${what}: ui ${ui_bytes()} bytes`), 300);
}

function show(tag, size) {
  box.clear();
  new ui.Label(box, { markup: true, width: "100%", font: size,
    text: tag ? `<${tag}>${ui.escapeMarkup(TEXT)}</${tag}>` : ui.escapeMarkup(TEXT) });
  report(`${tag || "m"} ${size}`);
}

function screenful(size) {
  box.clear();
  const lines = Math.ceil(ui.height / size);
  for (let n = 0; n < lines; n++) {
    new ui.Label(box, { font: size, text: TEXT.slice(n * 9, n * 9 + 40) });
  }
  report(`screen ${size}`);
}

function sideBySide() {
  box.clear();
  for (const sizes of [[15, 16, 17], [23, 24, 25]]) {
    for (const [props, markup] of [[{}, ""], [{ mono: true }, ""], [{ markup: true }, "b"]]) {
      const row = new ui.Container(box, { layout: "row", gap: 16, width: "100%", height: "content" });
      for (const size of sizes) {
        const text = `${size} Hamb 0O1l ${ui.symbols.ok}`;
        new ui.Label(row, { ...props, font: size, text: markup ? `<${markup}>${ui.escapeMarkup(text)}</${markup}>` : text });
      }
    }
  }
  report("side by side");
}

async function cycle() {
  box.clear();
  const base = ui_bytes();
  const { min, max } = ui.fontRange;
  let peak = 0, sizes = 0;
  const sample = "Hamburgefonts 0O1lI €₿ " + ui.symbols.ok + ui.symbols.wifi;
  for (let size = min; size <= max; size++) {
    box.clear();
    // every style at this size, one label each, drawn at once
    for (const [start, end] of [["", ""], ["<tt>", "</tt>"], ["<b>", "</b>"], ["<i>", "</i>"], ["<b><i>", "</i></b>"]]) {
      new ui.Label(box, { markup: true, font: size, text: start + ui.escapeMarkup(sample) + end });
    }
    await tick(40);		// drawn
    peak = Math.max(peak, ui_bytes() - base);
    sizes++;
  }
  box.clear();
  await tick(40);
  const after = ui_bytes() - base;
  const within = peak <= CAP + FONTS;
  log(`cycle: ${sizes} sizes x 5 styles, peak +${peak} bytes, after +${after} bytes, ` +
      (within ? "within the cap" : "OVER THE CAP"));
}

function errors() {
  for (const v of [7, 121, 0, -16, 16.5, NaN, Infinity, "16", null]) {
    try {
      new ui.Label({ font: v }).delete();
      log("error: none for", JSON.stringify(v));
    } catch (e) {
      log(`error: font ${String(v)}: ${e.name}: ${e.message}`);
    }
  }
  for (const t of ["<span size='7'>x</span>", "<span size='121'>x</span>", "<tt><b>x</b></tt>"]) {
    try {
      new ui.Label({ markup: true, text: t }).delete();
      log("error: none for", t);
    } catch (e) {
      log(`error: markup ${t}: ${e.name}: ${e.message}`);
    }
  }
  try {
    new ui.Label({ mono: true, font: 77, markup: true, text: "<b>x</b>" }).delete();
    log("error: none for bold mono");
  } catch (e) {
    log(`error: mono bold: ${e.name}: ${e.message}`);
  }
}

ui.onKey((ev) => {
  const k = ev.key;
  const shifted = ev.shift || k !== k.toLowerCase();	// (serial "#key B" too)
  const size = shifted ? 28 : 16;
  if (k.toLowerCase() === "b") show("b", size);
  else if (k.toLowerCase() === "i") show("i", size);
  else if (k.toLowerCase() === "m") show(null, size);
  else if (k >= "1" && k <= "4") show(null, [12, 24, 48, 96][k - 1]);
  else if (k.toLowerCase() === "f") screenful(shifted ? 120 : 50);
  else if (k === "q") sideBySide();
  else if (k === "c") cycle();
  else if (k === "e") errors();
  else return false;
  return true;
});

// the memory at the start, against the last start's (gk:session keeps it
// until power-off): the fonts and glyphs of the last run all freed
const ready = ui_bytes();
const last = session.get("ready");
session.set("ready", ready);
log(`ready, ui ${ready} bytes` + (last === undefined ? "" : last === ready ? ", as the last start" : `, last start ${last}`));
