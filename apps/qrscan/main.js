// QR Scanner: the example for ui.Scanner (docs/CAMERA.md). Shows the
// camera's view, and the text (or the bytes, in hex) of each code read.
//
// The log gets each code's length and the start of its SHA-256, never its
// contents: a QR code may hold a secret, and the log goes to the serial
// port in test builds.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import { sha256 } from "gk:crypto";
import { t, plural } from "gk:i18n";

const hex = (bytes) => Array.from (bytes, (b) => b.toString (16).padStart (2, "0")).join (" ");

// side by side on wide screens, one above the other on small ones
const wide = ui.width >= 800;
ui.screen.set ({ layout: wide ? "row" : "column", gap: wide ? 16 : 8 });

const scanner = new ui.Scanner ({
  detect: ["qr"],
  width: wide ? 400 : 280,
  height: wide ? 300 : 210,
  onDetect: ({ bytes, text }) => {
    count++;
    title.text = text === null
      ? plural (bytes.length, "Code {count}: {n} byte, binary", "Code {count}: {n} bytes, binary", { count })
      : plural (bytes.length, "Code {count}: {n} byte", "Code {count}: {n} bytes", { count });
    content.text = text ?? hex (bytes);
    console.log (`qrscan: code ${count}, ${bytes.length} bytes, sha256 ${hex (sha256 (bytes).subarray (0, 8)).replaceAll (" ", "")}`);
  },
  onError: ({ reason }) => {
    title.text = t ("The camera stopped");
    content.text = reason;
    toggle.text = ui.symbols.play + " " + t ("Start");
    console.log (`qrscan: error: ${reason}`);
  },
});

const side = new ui.Container (wide ? { layout: "column", gap: 12, grow: 1 }
                                    : { layout: "column", gap: 6, width: "100%" });
let count = 0;
const title = new ui.Label (side, { text: t ("Show a QR code to the camera"), font: wide ? 20 : 16 });
const content = new ui.Label (side, { text: "", width: "100%", overflow: "wrap" });

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
    title.text = t ("Show a QR code to the camera");
    content.text = "";
  },
});
// the camera's field: the middle at full detail (the default), or all of
// its view with less detail (for codes that fill less of it, use "center")
const field = new ui.Button (buttons, {
  text: t ("Wide view"),
  onClick: () => {
    scanner.field = scanner.field === "center" ? "full" : "center";
    field.text = scanner.field === "center" ? t ("Wide view") : t ("Detail");
    console.log (`qrscan: field ${scanner.field}`);
  },
});
new ui.Button (buttons, { text: ui.symbols.home + " " + t ("Back"), onClick: () => sys.exit () });

toggle.focus ();
console.log ("qrscan ready");
