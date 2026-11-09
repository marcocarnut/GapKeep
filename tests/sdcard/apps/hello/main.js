// Hello: the example from docs/APPS.md.

import * as ui from "gk:ui";
import * as sys from "gk:sys";

new ui.Label({ text: "Hello, air gap!", font: 28 });

const name = new ui.TextArea({
  placeholder: "Your name",
  oneLine: true,
  maxLength: 24,
  width: 320,
});

const greeting = new ui.Label({ text: "Type your name and press Enter." });

name.on("submit", () => {
  greeting.text = name.text ? `Hello, ${name.text}!` : "Hello, whoever you are!";
  console.log("greeted", name.text);
});

const row = new ui.Container({ layout: "row", gap: 12, alignItems: "center" });
let count = 0;
const counter = new ui.Label(row, { text: "Clicked 0 times" });
new ui.Button(row, {
  text: ui.symbols.plus + " Click me",
  onClick: () => {
    count++;
    counter.text = `Clicked ${count} time${count === 1 ? "" : "s"}`;
  },
});

new ui.Button({ text: ui.symbols.home + " Back", onClick: () => sys.exit() });

name.focus();
