// Widget Gallery: shows every zg:ui widget and runs the runtime self-test.
// Every interaction is logged, so tests/*.txt scenarios can check it.

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import { runSelfTest } from "./selftest.js";

ui.screen.set({ padding: 0, gap: 0 });

const tabs = new ui.TabView({ width: "100%", height: "100%" });

// --- Inputs -------------------------------------------------------------
const inputs = tabs.addTab("Inputs");
inputs.set({ layout: "column", gap: 10 });

const text = new ui.TextArea(inputs, {
  placeholder: "Letters only (accept)",
  oneLine: true,
  accept: "abcdefghijklmnopqrstuvwxyz",
  maxLength: 16,
  width: 300,
  onChange: (ev) => console.log("text:", ev.value),
});

const row = new ui.Container(inputs, { layout: "row", gap: 24, alignItems: "center" });
new ui.Checkbox(row, { text: "Checkbox", onChange: (ev) => console.log("checkbox:", ev.value) });
new ui.Switch(row, { onChange: (ev) => console.log("switch:", ev.value) });
new ui.Dropdown(row, {
  options: ["12 words", "24 words"],
  selected: 1,
  onChange: (ev) => console.log("dropdown:", ev.value),
});

const bar = new ui.Bar(inputs, { width: 300, min: 0, max: 100, value: 30 });
new ui.Slider(inputs, {
  width: 300,
  min: 0,
  max: 100,
  value: 30,
  onChange: (ev) => {
    bar.value = ev.value;
  },
});

// --- Table --------------------------------------------------------------
const tablePage = tabs.addTab("Table");
const table = new ui.Table(tablePage, {
  data: [
    ["Die", "Value", "Word"],
    ["1", "3", "abandon"],
    ["2", "6", "zoo"],
  ],
});
table.setColumnWidth(2, 160);

// --- QR code ------------------------------------------------------------
const qrPage = tabs.addTab("QR");
qrPage.set({ layout: "row", gap: 16 });
const qr = new ui.QRCode(qrPage, { size: 180, data: "zerogap" });
const qrText = new ui.TextArea(qrPage, {
  text: "zerogap",
  width: 280,
  height: 120,
  onChange: (ev) => {
    qr.data = ev.value || " ";
  },
});

// --- Alerts -------------------------------------------------------------
const alertPage = tabs.addTab("Alerts");
alertPage.set({ layout: "column", gap: 10 });
const answer = new ui.Label(alertPage, { text: "No answer yet." });
new ui.Button(alertPage, {
  text: "Ask a question",
  onClick: async () => {
    const choice = await ui.alert("Did the self-test pass?", {
      title: "Question",
      buttons: ["No", "Yes"],
    });
    answer.text = "Answer: " + choice;
    console.log("alert answer:", choice);
  },
});

// --- Self-test ----------------------------------------------------------
const testPage = tabs.addTab("Self-test");
const result = new ui.Label(testPage, { text: "Running..." });

runSelfTest(testPage).then(({ passed, failed }) => {
  result.text = `${passed} passed, ${failed.length} failed` +
    (failed.length ? "\n" + failed.join("\n") : "");
  result.color = failed.length ? "#ef5350" : "#66bb6a";
  console.log(`selftest: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log("selftest FAIL:", f);
});

text.focus();
console.log("gallery ready, memory", JSON.stringify(sys.memory()));
