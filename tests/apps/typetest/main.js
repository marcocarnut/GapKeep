// Test builds only: a text field that logs what was typed when Enter is
// pressed, and every key name ui.onKey sees, as Unicode code points so the
// scenarios' patterns stay ASCII (tests/keyboard.txt). Never use this for
// anything secret: the log goes to the serial port.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";

const hex = (s) => [...s].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");

new ui.Label({ text: "Type, then Enter: Ççãéü ´`~^¨ / ? ° €₿", font: 20 });
const field = new ui.TextArea({
  oneLine: true,
  font: 28,
  onSubmit: () => {
    console.log(`typetest: typed ${hex(field.text)} (${field.text})`);
    field.text = "";
  },
});
ui.onKey((ev) => {
  if ([...ev.key].length === 1) console.log(`typetest: key ${hex(ev.key)}`);
});
field.focus();
console.log("typetest ready");
