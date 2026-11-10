// REPL: type JavaScript, press Enter, see the result. The code runs at the
// global level (an indirect eval), so a `var` stays for the next run; it
// sees a `ui` whose new widgets go into the area under the result, cleared
// before each run. And `btc` (lib/btc.js: btc.help() says what it does),
// loaded the first time the code says btc.

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as crypto from "gk:crypto";
import { t } from "gk:i18n";

// BIP-39's test phrase: public, no real funds
const ABANDON = "abandon ".repeat(11) + "about";

const EXAMPLES = [
  [t("Arithmetic"), "2 ** 64"],
  [t("Arrays"), "[1, 2, 3, 4].map(n => n * n)"],
  [t("Objects as JSON"), 'JSON.stringify({ app: "repl", size: [ui.width, ui.height] })'],
  [t("A label"), 'new ui.Label({ text: "Hello from the REPL", font: 28 })'],
  [t("Markup"),
    "new ui.Label({ markup: true, font: 20, width: \"100%\", text:\n" +
    "  '<b>bold</b>, <i>italic</i>, <b><i>both</i></b>, <tt>mono 0O1lI</tt>,\\n' +\n" +
    "  '<u>underlined</u>, <s>struck</s>, <big>bigger</big>, <small>smaller</small>,\\n' +\n" +
    "  '<span color=\"#ffc107\">amber</span> and <span color=\"#4caf50\" weight=\"bold\">green</span>' })"],
  [t("A button with a counter"),
    "var clicks = 0;\n" +
    'var b = new ui.Button({ text: "Clicked 0 times" });\n' +
    'b.onClick = () => { b.text = "Clicked " + ++clicks + " times"; };\n' +
    "b"],
  [t("Variables persist"), "typeof clicks === \"undefined\" ? \"run the counter first\" : clicks"],
  [t("An error"), "notDefined + 1"],
  [t("Bitcoin: an address from the words"),
    `btc.words("${ABANDON}")\n  .derive("m/84'/0'/0'/0/0").address()`],
  [t("Bitcoin: an account's descriptor"),
    `var account = btc.words("${ABANDON}").derive("m/86'/0'/0'");\naccount.descriptor()`],
  [t("Bitcoin: what btc does"), "btc.help()"],
];

const header = new ui.Container({ layout: "row", width: "100%", gap: 12, alignItems: "center" });
new ui.Label(header, { text: t("REPL"), font: 24, grow: 1 });
const examples = new ui.Dropdown(header, {
  options: [t("Examples…")].concat(EXAMPLES.map(e => e[0])),
  width: 260,
});

new ui.Label({ text: t("Enter runs the code; Shift+Enter starts a new line."), width: "100%" });
const input = new ui.TextArea({ mono: true, font: 16, width: "100%", height: 110 });
const output = new ui.Label({ mono: true, font: 16, width: "100%", padding: [4, 8], radius: 4, bg: "#000", text: " " });
const area = new ui.Container({ width: "100%", height: "content", layout: "column", gap: 8 });

// ui as the code sees it: same as ours, but widgets made without a parent
// go into `area`, and ui.screen is `area` too
function uiInside(parent) {
  const ns = { ...ui, screen: parent };
  for (const [name, Base] of Object.entries(ui)) {
    if (typeof Base !== "function" || !(Base.prototype instanceof ui.Widget)) continue;
    ns[name] = { [name]: class extends Base {
      constructor(p, props) {
        if (!(p instanceof ui.Widget)) { props = p; p = parent; }
        super(p, props);
      }
    } }[name];
  }
  return Object.freeze(ns);
}
globalThis.ui = uiInside(area);

function show(value) {
  if (value instanceof ui.Widget) return t("({name} widget)", { name: value.constructor.name });
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "function " + (value.name || "");
  if (value !== null && typeof value === "object") {
    // a value that says what it is (a btc key: never its secrets)
    if (!Array.isArray(value) && typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
      return String(value);
    }
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  return String(value);
}

function kindOf(value) {
  if (value instanceof ui.Widget) return value.constructor.name + " widget";
  const name = value !== null && typeof value === "object" && value.constructor ? value.constructor.name : "";
  return name && name !== "Object" ? name + " object" : typeof value;
}

// btc: lib/btc.js and what it imports (86 KB) are loaded the first time
// the code says btc, before it runs; until then btc costs nothing. A getter
// stands in for it meanwhile, for code that reaches it some other way.
let btcLoading = null;
function loadBtc() {
  if (!btcLoading) {
    const start = Date.now();
    btcLoading = import("./lib/btc.js").then((m) => {
      m.setCrypto(crypto);
      Object.defineProperty(globalThis, "btc", { value: m.btc, writable: true, configurable: true });
      console.log("repl: btc loaded in " + (Date.now() - start) + " ms");
    }, (e) => {
      btcLoading = null;
      throw e;
    });
  }
  return btcLoading;
}
Object.defineProperty(globalThis, "btc", {
  configurable: true,
  get() {
    loadBtc();
    throw new ReferenceError(t("btc is loading: run the code again"));
  },
  // the code's own btc (var btc = ...) replaces ours
  set(value) {
    Object.defineProperty(globalThis, "btc", { value, writable: true, configurable: true });
  },
});
const BTC_LOADED = () => !Object.getOwnPropertyDescriptor(globalThis, "btc").get;

// The log says what kind of result, never the code or the value: it goes
// to the serial port in test builds, and the code could hold a secret.
let running = false;
async function run() {
  if (running) return;
  running = true;
  area.clear();
  const code = input.text;
  try {
    if (/\bbtc\b/.test(code) && !BTC_LOADED()) {
      output.set({ text: t("Loading btc…"), bg: "#000", color: "#fff" });
      await loadBtc();
    }
    const value = (0, eval)(code);
    output.set({ text: show(value), bg: "#000", color: "#fff" });
    console.log("repl: ran " + code.length + " characters: " + kindOf(value));
  } catch (e) {
    output.set({ text: String(e), bg: "#ff8080", color: "#000" });
    console.log("repl: ran " + code.length + " characters: " + (e && e.name ? e.name : "exception"));
  } finally {
    running = false;
  }
}

// Enter in the code box runs it, before the box sees it (so no line break
// is added where the cursor is); Shift+Enter is left to the box: a new line
let inputFocused = false;
input.onFocus = () => { inputFocused = true; };
input.onBlur = () => { inputFocused = false; };
ui.onKey((ev) => {
  if (ev.key !== "Enter" || ev.shift || ev.ctrl || ev.alt || !inputFocused) return false;
  run();
  return true;
});

examples.onChange = () => {
  const i = examples.selected;
  if (i <= 0) return;
  input.text = EXAMPLES[i - 1][1];
  examples.selected = 0;
  input.focus();
};

new ui.Button({ text: ui.symbols.home + " " + t("Back"), onClick: () => sys.exit() });

input.focus();
console.log("repl ready");
