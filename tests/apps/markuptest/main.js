// Label markup (markup.h): every case of cases.js accepted or refused as
// it says, the errors, escapeMarkup and tm() with hostile params, and a
// screen of styles for the screenshot. Test builds only.
import * as ui from "zg:ui";
import * as sys from "zg:sys";
import { tm } from "zg:i18n";
import { CASES } from "./cases.js";

const log = (...a) => console.log("markuptest", ...a);
let wrong = 0;
for (const [text, valid] of CASES) {
  let error = null;
  try {
    new ui.Label({ markup: true, text }).delete();
  } catch (e) {
    error = e;
  }
  if ((error === null) !== valid || (error && !(error instanceof TypeError && /at character \d+/.test(error.message)))) {
    wrong++;
    log("WRONG", JSON.stringify(text), error ? error.message : "accepted");
  }
}
log(`cases: ${CASES.length}, ${wrong} wrong`);
for (const text of ["<b>x</b>", "x<tt>y", "<u><s>x</u></s>", "&bogus;", "<span bgcolor='#000'>x</span>"]) {
  try {
    new ui.Label({ markup: true, text });
  } catch (e) {
    log("error:", e.message);
  }
}
try {
  new ui.Label({ markup: false }).markup = true;
} catch (e) {
  log("error:", e.message);
}

// hostile data, through escapeMarkup and tm(): shown as text, never as tags
const hostile = ["<span color='red'>", "&", "</tt>"];
const shown = [];
for (const h of hostile) {
  const label = new ui.Label({ markup: true, text: tm("Name: <tt>{name}</tt>", { name: h }) });
  shown.push(label.text);
  new ui.Label({ markup: true, text: "<u>" + ui.escapeMarkup(h) + "</u>" });
}
log("hostile:", JSON.stringify(shown));

// the cost: N labels each, plain, markup without tags, and markup with
// three styles; creation time (sys.uptime) and LVGL's memory
// (sys.memory().ui) and the JS heap's, per label
const N = 1000;
function cost(what, props) {
  sys.gc();
  const box = new ui.Container({ hidden: true });
  const m0 = sys.memory(), t0 = sys.uptime();
  for (let n = 0; n < N; n++) new ui.Label(box, props);
  const t1 = sys.uptime(), m1 = sys.memory();
  // (QEMU's uptime() moves in steps of 10 ms: hence 1000 labels)
  log(`cost ${what}: ${((t1 - t0) * 1000 / N).toFixed(0)} us, ui ${((m1.ui - m0.ui) / N).toFixed(0)} bytes, js ${((m1.used - m0.used) / N).toFixed(0)} bytes per label`);
  box.delete();
}
const ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
cost("plain", { text: `Send 0.001 BTC to ${ADDRESS}` });
cost("markup, no tags", { markup: true, text: `Send 0.001 BTC to ${ADDRESS}` });
cost("markup, 3 styles", { markup: true, text: `Send <span color='#ffb300'>0.001 BTC</span> to <tt>${ADDRESS}</tt>` });

// the screen
const sizes = new ui.Label({ markup: true, width: "100%", text:
  "Sizes: <small>small</small> normal <big>big</big> <span size='28'>28</span> <tt>tt mono</tt> <tt><small>tt small</small></tt>" });
new ui.Label({ markup: true, width: "100%", font: 20, text:
  "Send <span color='#ffb300'>0.001 BTC</span> to <tt>bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</tt>" });
new ui.Label({ markup: true, text: "<u>underlined</u>, <s>struck</s>, <span underline='single' color='#66bb6a'>both styles</span> &lt;tags&gt; &amp; &#x20BF;" });
new ui.Label({ markup: true, width: 300, overflow: "dots", maxHeight: 44, text: "<tt>dots:</tt> " + "a long line of text ".repeat(8) });
const mono = new ui.Label({ markup: true, mono: true, text: "A mono label, <big>big</big>" });
mono.font = 20;
log("text back:", JSON.stringify(sizes.text.slice(0, 20)), "markup:", sizes.markup);
log("ready");
