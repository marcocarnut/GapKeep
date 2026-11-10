// Hello: the example from docs/APPS.md, in more than one language
// (gk:i18n, lang/<language>.json; docs/APPS.md, "Languages").
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import { t, plural } from "gk:i18n";

new ui.Label({ text: t("Hello, air gap!"), font: 28 });

const name = new ui.TextArea({
  placeholder: t("Your name"),
  oneLine: true,
  maxLength: 24,
  width: 320,
});

const greeting = new ui.Label({ text: t("Type your name and press Enter.") });

name.on("submit", () => {
  greeting.text = name.text ? t("Hello, {name}!", { name: name.text }) : t("Hello, whoever you are!");
  console.log("greeted", name.text);
});

const row = new ui.Container({ layout: "row", gap: 12, alignItems: "center" });
let count = 0;
const counter = new ui.Label(row, { text: plural(0, "Clicked {n} time", "Clicked {n} times") });
new ui.Button(row, {
  text: ui.symbols.plus + " " + t("Click me"),
  onClick: () => {
    count++;
    counter.text = plural(count, "Clicked {n} time", "Clicked {n} times");
  },
});

new ui.Button({ text: ui.symbols.home + " " + t("Back"), onClick: () => sys.exit() });

name.focus();
console.log("hello ready");
