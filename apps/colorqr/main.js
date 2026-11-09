// Color QR (experimental, docs/EXPERIMENTAL.md): reads a colour QR code. Its
// black and white is an ordinary QR code, which any reader sees; its colours
// carry more data (lib/colorqr/FORMAT.md), which only the "qr-color"
// detector reads. Shows both, apart: what a phone would show, and what only
// the colours hold.
//
// Only listed and started with "experimental = yes" in the card's
// zerogap.txt. The log gets lengths and the start of each SHA-256, never
// the contents: either part may hold a secret.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import { sha256 } from "gk:crypto";
import { t, plural } from "gk:i18n";

const hex = (bytes, sep = " ") => Array.from (bytes, (b) => b.toString (16).padStart (2, "0")).join (sep);
const digest = (bytes) => hex (sha256 (bytes).subarray (0, 8), "");
// the bytes as text if they are valid UTF-8 (decodeURIComponent checks it
// strictly), else null
function utf8 (bytes) {
  try {
    return decodeURIComponent (Array.from (bytes, (b) => "%" + b.toString (16).padStart (2, "0")).join (""));
  } catch (e) {
    return null;
  }
}
const MUTED = "#8a9199", GREEN = "#66bb6a", AMBER = "#ffb300";

const wide = ui.width >= 800;
ui.screen.set ({ layout: wide ? "row" : "column", gap: wide ? 16 : 8 });

const scanner = new ui.Scanner ({
  detect: ["qr", "qr-color"],
  width: wide ? 400 : 280,
  height: wide ? 300 : 210,
  onDetect: (ev) => (ev.kind === "qr" ? showBase (ev) : showColour (ev)),
  onError: ({ reason }) => {
    status.text = t ("The camera stopped: {reason}", { reason });
    toggle.text = ui.symbols.play + " " + t ("Start");
    console.log (`colorqr: error: ${reason}`);
  },
});

const side = new ui.Container (wide ? { layout: "column", gap: 10, grow: 1, scrollable: true, height: "100%" }
                                    : { layout: "column", gap: 6, width: "100%" });
new ui.Label (side, { text: t ("Color QR (experimental)"), font: wide ? 22 : 16 });
const status = new ui.Label (side, { text: t ("Show a colour QR code to the camera"), width: "100%", overflow: "wrap" });

new ui.Label (side, { text: t ("What any QR reader sees"), font: wide ? 18 : 14, color: MUTED });
const base = new ui.Label (side, { text: "-", width: "100%", overflow: "wrap" });
new ui.Label (side, { text: t ("What only the colours hold"), font: wide ? 18 : 14, color: MUTED });
const colour = new ui.Label (side, { text: "-", width: "100%", overflow: "wrap" });

let count = 0;

function describe (bytes, text) {
  const what = text !== null ? text : hex (bytes.subarray (0, 256)) + (bytes.length > 256 ? " ..." : "");
  const size = text === null ? plural (bytes.length, "{n} byte, binary", "{n} bytes, binary")
    : plural (bytes.length, "{n} byte", "{n} bytes");
  return `${size}\n${what}`;
}

// The scanner reports a colour layer it could not read after a second of
// trying, but only while it still sees the code: one glimpsed and lost
// gets no report, so give up waiting after a while.
let waiting = null;

function showBase ({ bytes, text }) {
  count++;
  base.text = describe (bytes, text);
  colour.text = t ("Reading the colours...");
  colour.color = MUTED;
  clearTimeout (waiting);
  waiting = setTimeout (() => {
    colour.text = t ("Not read: the code went out of view (hold it steady, closer)");
    colour.color = AMBER;
  }, 3000);
  status.text = t ("Code {count}", { count });
  console.log (`colorqr: code ${count}, ${bytes.length} bytes, sha256 ${digest (bytes)}`);
}

function showColour ({ status: result, colour: data }) {
  clearTimeout (waiting);
  if (result === "ok") {
    colour.text = describe (data, utf8 (data));
    colour.color = GREEN;
    console.log (`colorqr: colour layer of code ${count}, ${data.length} bytes, sha256 ${digest (data)}`);
  } else {
    colour.text = result === "plain" ? t ("None: a plain QR code") : t ("Not read (hold the code steady, closer, without glare)");
    colour.color = AMBER;
    console.log (`colorqr: colour layer of code ${count}: ${result}`);
  }
}

const buttons = new ui.Container (side, { layout: "row", gap: 8 });
const toggle = new ui.Button (buttons, {
  text: ui.symbols.pause + " " + t ("Stop"),
  onClick: () => {
    if (scanner.scanning) {
      scanner.stop ();
      toggle.text = ui.symbols.play + " " + t ("Start");
    } else {
      scanner.start ();
      toggle.text = ui.symbols.pause + " " + t ("Stop");
    }
  },
});
new ui.Button (buttons, {
  text: ui.symbols.trash + " " + t ("Clear"),
  onClick: () => {
    clearTimeout (waiting);
    base.text = colour.text = "-";
    status.text = t ("Show a colour QR code to the camera");
  },
});
new ui.Button (buttons, { text: ui.symbols.home + " " + t ("Back"), onClick: () => sys.exit () });

toggle.focus ();
console.log ("colorqr ready");
