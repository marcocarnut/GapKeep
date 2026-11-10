// Widget Gallery: shows every gk:ui widget and runs the runtime self-test.
// Every interaction is logged, so tests/*.txt scenarios can check it.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import { runSelfTest } from "./selftest.js";
import { t, tm, plural } from "gk:i18n";

ui.screen.set({ padding: 0, gap: 0 });

const tabs = new ui.TabView({ width: "100%", height: "100%" });

// --- Inputs -------------------------------------------------------------
const inputs = tabs.addTab(t("Inputs"));
inputs.set({ layout: "column", gap: 10 });

const text = new ui.TextArea(inputs, {
  placeholder: t("Letters only (accept)"),
  oneLine: true,
  accept: "abcdefghijklmnopqrstuvwxyz",
  maxLength: 16,
  width: 300,
  onChange: (ev) => console.log("text:", ev.value),
});

const row = new ui.Container(inputs, { layout: "row", gap: 24, alignItems: "center" });
new ui.Checkbox(row, { text: t("Checkbox"), onChange: (ev) => console.log("checkbox:", ev.value) });
new ui.Switch(row, { onChange: (ev) => console.log("switch:", ev.value) });
new ui.Dropdown(row, {
  options: [plural(12, "{n} word", "{n} words"), plural(24, "{n} word", "{n} words")],
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

// press / drag / release: any widget can follow the pointer
let drags = 0;
const area = new ui.Container(inputs, {
  width: 300, height: 120, radius: 8, borderWidth: 2, borderColor: "#3a4152",
  layout: "column", justify: "center", alignItems: "center",
  onPress: (ev) => {
    drags = 0;
    console.log(`pointer: press ${ev.pointer ? ev.x + "," + ev.y : "(key)"}`);
  },
  onDrag: () => { drags++; },
  onRelease: (ev) => console.log(`pointer: release after ${drags} drag event(s)`),
});
new ui.Label(area, { text: t("Press and drag here"), color: "#8a9199", clickable: false });

// --- Table --------------------------------------------------------------
const tablePage = tabs.addTab(t("Table"));
const table = new ui.Table(tablePage, {
  data: [
    [t("Die"), t("Value"), t("Word")],
    ["1", "3", "abandon"],
    ["2", "6", "zoo"],
  ],
});
table.setColumnWidth(2, 160);

// markup (markup: true): styles in the text, and data escaped by tm()
tablePage.set({ layout: "column", gap: 12 });
new ui.Label(tablePage, {
  markup: true,
  width: "100%",
  text: tm("Markup: <tt>monospaced</tt>, <big>big</big>, <small>small</small>, <u>underlined</u>, " +
    "<s>struck</s>, <span color='#ffb300'>in colour</span> &amp; &#x20BF;"),
});
new ui.Label(tablePage, {
  markup: true,
  width: "100%",
  text: tm("Data stays text: <tt>{data}</tt>", { data: "<u>not a tag</u> & more" }),
});

// --- QR code ------------------------------------------------------------
const qrPage = tabs.addTab(t("QR"));
qrPage.set({ layout: "row", gap: 16 });
const qr = new ui.QRCode(qrPage, { size: 180, data: "gapkeep" });
const qrText = new ui.TextArea(qrPage, {
  text: "gapkeep",
  width: 280,
  height: 120,
  onChange: (ev) => {
    qr.data = ev.value || " ";
  },
});

// --- Alerts -------------------------------------------------------------
const alertPage = tabs.addTab(t("Alerts"));
alertPage.set({ layout: "column", gap: 10 });
const answer = new ui.Label(alertPage, { text: t("No answer yet.") });
new ui.Button(alertPage, {
  text: t("Ask a question"),
  onClick: async () => {
    const choice = await ui.alert(t("Did the self-test pass?"), {
      title: t("Question"),
      buttons: [t("No"), t("Yes")],
    });
    answer.text = t("Answer: {choice}", { choice });
    console.log("alert answer:", choice);
  },
});

// --- Self-test ----------------------------------------------------------
const testPage = tabs.addTab(t("Self-test"));
const result = new ui.Label(testPage, { text: t("Running...") });

runSelfTest(testPage).then(({ passed, failed }) => {
  result.text = t("{passed} passed, {failed} failed", { passed, failed: failed.length }) +
    (failed.length ? "\n" + failed.join("\n") : "");
  result.color = failed.length ? "#ef5350" : "#66bb6a";
  console.log(`selftest: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log("selftest FAIL:", f);
});

text.focus();
console.log("gallery ready, memory", JSON.stringify(sys.memory()));
