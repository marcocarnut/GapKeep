// PSBT Viewer: what a transaction from Electrum does, before anyone signs
// it. Electrum shows an unsigned transaction (a PSBT, BIP-174) as one QR
// code, in Base43; this app reads it with the camera and shows what it
// spends, where the money goes, which outputs come back to the same wallet
// (change), the fee, and what to be careful about. It signs nothing.
//
// The decoding is in lib/ (pure modules, tested under Node by
// tests/psbt/run_node.mjs). Transactions are not secret, but the log gets
// only counts and amounts.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as crypto from "zg:crypto";
import { setHashes } from "./lib/hashes.js";
import { DecodeError, toHex } from "./lib/bytes.js";
import { readPayload } from "./lib/transport.js";
import { parsePsbt } from "./lib/psbt.js";
import { parseTx } from "./lib/tx.js";
import { analyze, analyzeTx } from "./lib/analyze.js";
import { NETWORKS } from "./lib/script.js";
import { Rows, showAnalysis, MUTED, RED, wide, FONT as F, plural } from "./lib/view.js";

// RIPEMD-160 is native in newer systems; without it a few key checks are
// skipped (and the summary says so)
setHashes({ sha256: crypto.sha256, ripemd160: typeof crypto.ripemd160 === "function" ? crypto.ripemd160 : null });

const NETWORK_ORDER = ["mainnet", "testnet", "regtest"];

const state = {
  page: null,       // "home", "scan", "summary"
  loaded: null,     // { kind, encoding, chars, size, psbt | tx }
  network: null,    // chosen by the person; null: as guessed
  lastNetwork: null, // of the last transaction shown: for one that says nothing
  notice: null,     // { text, color } on the home page
};

let page = {};

function newPage(name) {
  state.page = name;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [24, 32] : [10, 12], gap: wide ? 12 : 6, alignItems: "center" });
  page = { name, rows: new Rows() };
  return new ui.Container({ layout: "column", gap: wide ? 12 : 6, width: "100%", maxWidth: 1200, grow: 1 });
}

function header(parent, text) {
  const row = new ui.Container(parent, { layout: "row", alignItems: "center", gap: 12, width: "100%" });
  new ui.Label(row, { text, font: F.title, grow: 1 });
  return row;
}

const paragraph = (parent, text, props = {}) =>
  new ui.Label(parent, { text, width: "100%", overflow: "wrap", font: F.text, ...props });

// --- home ----------------------------------------------------------------------

function showHome() {
  const col = newPage("home");
  header(col, ui.symbols["eye-open"] + " PSBT Viewer");
  paragraph(col, "Shows what a transaction made in Electrum does: what it spends, where the money goes, " +
    "which outputs come back to your wallet as change, and the fee. It signs nothing.");
  paragraph(col, "In Electrum, make the transaction, then in its window choose Export (or Share), " +
    "then Show as QR code, and show that code to the camera.", { color: MUTED });
  const buttons = new ui.Container(col, { layout: "row-wrap", gap: 8, width: "100%" });
  const scan = new ui.Button(buttons, { text: ui.symbols.plus + " Scan QR code", onClick: showScan });
  if (state.loaded) new ui.Button(buttons, { text: ui.symbols.list + " Last transaction", onClick: showSummary });
  new ui.Button(buttons, { text: ui.symbols.home + " Leave", onClick: () => sys.exit() });
  if (state.notice) paragraph(col, state.notice.text, { color: state.notice.color });
  scan.focus();
}

// --- scanning ------------------------------------------------------------------

function showScan() {
  const col = newPage("scan");
  header(col, ui.symbols.plus + " Scan QR code");
  const body = new ui.Container(col, { layout: wide ? "row" : "column", gap: wide ? 20 : 6, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"],
    width: wide ? 560 : 280,
    height: wide ? 420 : 210,
    onDetect: ({ text, bytes }) => scanned(text, bytes),
    onError: ({ reason }) => {
      say(`The camera stopped: ${reason}.`, RED);
      console.log(`psbtview: camera error: ${reason}`);
    },
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, "Show Electrum's QR code of the transaction. Large ones need a steady hand " +
    "and good light.", { font: F.text });
  const back = new ui.Button(side, { text: ui.symbols.left + " Back", onClick: back_ });
  back.focus();
}

function back_() {
  if (state.loaded) showSummary();
  else showHome();
}

function say(text, color) {
  if (state.page === "scan") page.status.set({ text, color });
}

function scanned(text, bytes) {
  const t0 = sys.uptime();
  let loaded;
  try {
    const r = readPayload(text, bytes);
    loaded = { kind: r.kind, encoding: r.encoding, chars: text === null ? bytes.length : text.length, size: r.bytes.length };
    if (r.kind === "psbt") loaded.psbt = parsePsbt(r.bytes);
    else loaded.tx = parseTx(r.bytes);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    // not a transaction, or broken: say why, and keep scanning
    const why = e.message.endsWith(".") ? e.message : e.message + ".";
    const msg = /^(This|The code)/.test(why) ? why : "This code is not a transaction Electrum would load: " + why;
    say(ui.symbols.warning + " " + msg, RED);
    console.log(`psbtview: refused a code: ${msg}`);
    return;
  }
  const ms = sys.uptime() - t0;
  console.log(`psbtview: read a ${loaded.kind === "psbt" ? "PSBT" : "signed transaction"} (${loaded.encoding}, ` +
    `${loaded.chars} characters, ${loaded.size} bytes) in ${ms.toFixed(0)} ms`);
  state.loaded = loaded;
  state.network = null;
  page.scanner.stop();
  showSummary();
}

// --- the summary -----------------------------------------------------------------

function summaryAnalysis() {
  const l = state.loaded;
  const opts = { network: state.network };
  // a signed transaction has no key paths: take the network seen last
  state.inherited = l.kind === "tx" && !opts.network && state.lastNetwork !== null;
  if (state.inherited) opts.network = state.lastNetwork;
  return l.kind === "psbt" ? analyze(l.psbt, opts) : analyzeTx(l.tx, opts);
}

function showSummary() {
  const a = summaryAnalysis();
  const l = state.loaded;
  state.lastNetwork = a.network;
  const col = newPage("summary");
  const head = header(col, a.complete ? "Signed transaction" : "Transaction to sign");
  const buttons = new ui.Container(col, { layout: "row-wrap", gap: 8, width: "100%" });
  const again = new ui.Button(buttons, { text: ui.symbols.plus + " Scan another", onClick: showScan });
  new ui.Button(buttons, {
    text: "Network: " + NETWORKS[a.network].name,
    onClick: () => {
      state.network = NETWORK_ORDER[(NETWORK_ORDER.indexOf(a.network) + 1) % NETWORK_ORDER.length];
      console.log(`psbtview: network ${state.network}`);
      showSummary();
      page.network.focus();
    },
  });
  page.network = buttons.children[1];
  new ui.Button(buttons, { text: ui.symbols.home + " Leave", onClick: () => sys.exit() });
  new ui.Label(head, { text: l.kind === "psbt" ? `PSBT v${a.version}` : "", font: F.small, color: MUTED });

  const list = new ui.Container(col, { layout: "column", gap: wide ? 8 : 5, width: "100%", grow: 1, scrollable: true });
  showAnalysis(list, page.rows, a, l, {
    networkNote: state.network ? "chosen" : state.inherited ? "as the transaction before: a signed one doesn't say" : null,
  });

  again.focus();
  console.log(`psbtview: ${plural(a.inputs.length, "input")}, ${plural(a.outputs.length, "output")}, ` +
    `sent ${a.sent ?? "?"} sat, change ${a.toSelf ?? "?"} sat, fee ${a.fee ?? "?"} sat, ${a.vsize ?? "?"} vB, ` +
    `${a.network}, ${plural(a.warnings.length, "warning")}`);
  for (const w of a.warnings) console.log(`psbtview: ${w.level}: ${w.text.slice(0, 120)}`);
}

// --- keys ------------------------------------------------------------------------

// Arrows move between the rows of the summary (Tab does too, through the
// buttons); Escape goes back.
ui.onKey((ev) => {
  if (ev.key === "Escape" && state.page === "scan") {
    back_();
    return true;
  }
  if (ev.key === "Escape" && state.page === "summary") {
    state.notice = null;
    showHome();
    return true;
  }
  if (state.page === "summary") return page.rows.keys(ev);
  return false;
});

showHome();
console.log(`psbtview ready (RIPEMD-160 ${typeof crypto.ripemd160 === "function" ? "native" : "not available"})`);
