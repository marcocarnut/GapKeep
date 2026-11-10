// Test builds only: a paragraph in bold, italic or Medium (keys b, i, m),
// for what TinyTTF's bold and italic cost (tests/ttf.txt): the memory LVGL
// holds after each is drawn, logged; the drawing times come from the
// kernel ("#fonts", "#redraw": src/testshot.h).
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as sys from "gk:sys";

const TEXT = "Pay 0.00123456 BTC to the address below, and check it on another screen " +
  "before you sign: ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ç á ã é ü ₿.";
const log = (...a) => console.log("ttftest", ...a);
let label = null;
const box = new ui.Container({ width: "100%", height: "content" });

function show(tag, size) {
  if (label) label.delete();
  label = new ui.Label(box, { markup: true, width: "100%", font: size,
    text: tag ? `<${tag}>${ui.escapeMarkup(TEXT)}</${tag}>` : ui.escapeMarkup(TEXT) });
  setTimeout(() => { sys.gc(); log(`${tag || "m"} ${size}: ui ${sys.memory().ui} bytes`); }, 300);
}

ui.onKey((ev) => {
  const size = ev.shift ? 28 : 16;
  if (ev.key.toLowerCase() === "b") show("b", size);
  else if (ev.key.toLowerCase() === "i") show("i", size);
  else if (ev.key.toLowerCase() === "m") show(null, size);
  else return false;
  return true;
});
sys.gc();
log(`ready, ui ${sys.memory().ui} bytes`);
