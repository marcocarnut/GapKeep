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
import { analyze, analyzeTx, formatBtc, typeName, sighashName } from "./lib/analyze.js";
import { NETWORKS, disassemble } from "./lib/script.js";

// RIPEMD-160 is native in newer systems; without it a few key checks are
// skipped (and the summary says so)
setHashes({ sha256: crypto.sha256, ripemd160: typeof crypto.ripemd160 === "function" ? crypto.ripemd160 : null });

const MUTED = "#8a9199", RED = "#ef5350", AMBER = "#ffb300", GREEN = "#66bb6a", BLUE = "#64b5f6";
const LEVEL = { danger: { color: RED, symbol: ui.symbols.warning }, warn: { color: AMBER, symbol: ui.symbols.warning },
  info: { color: BLUE, symbol: ui.symbols.bell } };
const wide = ui.width >= 1000;
const F = wide ? { title: 28, big: 24, text: 18, small: 16 } : { title: 22, big: 18, text: 14, small: 12 };
const NETWORK_ORDER = ["mainnet", "testnet", "regtest"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const btc = (sats) => (sats === null || sats === undefined ? "unknown" : `${formatBtc(Number(sats))} BTC`);
const group4 = (s) => s.replace(/(.{4})(?=.)/g, "$1 ");

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
  page = { name, rows: [] };
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

// A row that Tab, the arrows and Enter reach: the page scrolls to it.
function row(parent, props, onClick) {
  const r = new ui.Panel(parent, {
    layout: "column", gap: 2, width: "100%", padding: wide ? [8, 14] : [5, 8], scrollable: false,
    focusable: true, clickable: true, onClick, ...props,
  });
  const i = page.rows.length;
  r.on("focus", () => (page.focused = i));
  page.rows.push(r);
  return r;
}

function line(parent, left, right, props = {}) {
  props = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
  const r = new ui.Container(parent, { layout: "row", gap: 10, width: "100%", alignItems: "start" });
  const l = new ui.Label(r, { text: left, grow: 1, overflow: "wrap", font: F.text, ...props });
  if (right !== null) new ui.Label(r, { text: right, font: F.text, textAlign: "right", ...props });
  return l;
}

function section(parent, text) {
  new ui.Label(parent, { text, font: F.big, color: MUTED, width: "100%" });
}

function roleText(o) {
  return { change: "Change, back to your wallet", receive: "To your own wallet (a receiving address)",
    mine: "To your own wallet" }[o.role] || null;
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

  // the totals first: what a person checks before anything else
  const external = a.outputs.filter((o) => !o.mine);
  const top = row(list, { gap: 4 }, () => details("Summary", summaryText(a, l)));
  if (a.complete) {
    line(top, `Pays ${plural(a.outputs.length, "output")}`, btc(a.totalOut), { font: F.big });
  } else {
    line(top, `Sends to ${external.length} ${external.length === 1 ? "address" : "addresses"}`, btc(a.sent), { font: F.big });
    if (a.toSelf) line(top, "Change back to your wallet", btc(a.toSelf), { color: GREEN });
  }
  const rate = a.feeRate !== null ? ` (${a.feeRate.toFixed(1)} sat/vB)` : "";
  if (!a.complete) {
    line(top, "Fee" + rate, a.fee === null ? "unknown" : btc(a.fee),
      { color: a.warnings.some((w) => /fee is high|more than the inputs/.test(w.text)) ? RED : undefined });
    line(top, `Spends ${plural(a.inputs.length, "coin")}`, btc(a.totalIn), { color: MUTED });
  }
  new ui.Label(top, {
    text: `${NETWORKS[a.network].name} (${state.network ? "chosen" : state.inherited
      ? "as the transaction before: a signed one doesn't say" : a.networkGuess.why})`, font: F.small, color: MUTED,
    width: "100%", overflow: "wrap",
  });

  for (const w of a.warnings) {
    const r = row(list, { borderColor: LEVEL[w.level].color }, () => details("Warning", w.text));
    new ui.Label(r, { text: LEVEL[w.level].symbol + " " + w.text, color: LEVEL[w.level].color, width: "100%",
      overflow: "wrap", font: F.text });
  }

  section(list, `Outputs (${a.outputs.length})`);
  for (const o of a.outputs) {
    const r = row(list, {}, () => details(`Output ${o.index + 1}`, outputText(o)));
    const where = o.address ? group4(o.address) : o.type === "op_return" ? "OP_RETURN (data, unspendable)" : typeName(o.type) + " script";
    line(r, `${o.index + 1}. ${where}`, btc(o.amount), { color: o.mine ? GREEN : undefined });
    if (o.mine) {
      new ui.Label(r, { text: `${ui.symbols.ok} ${roleText(o)}: ${o.derivations[0].path}` +
        (o.unchecked ? " (key not checked against the script)" : ""), color: GREEN, font: F.small });
    }
  }

  section(list, `Inputs (${a.inputs.length})`);
  for (const i of a.inputs) {
    const r = row(list, {}, () => details(`Input ${i.index + 1}`, inputText(i)));
    line(r, `${i.index + 1}. ${i.address ? group4(i.address) : i.prevTxid.slice(0, 16) + "...:" + i.vout}`,
      i.amount === null ? "amount unknown" : btc(i.amount), { color: i.problems.length ? RED : undefined });
    const bits = [typeName(i.type)];
    if (i.multisig) bits.push(`${i.multisig.m}-of-${i.multisig.n}`);
    if (i.derivations.length) bits.push(`${i.derivations[0].path} [${i.derivations[0].fingerprint}]`);
    bits.push(i.final ? "signed, final" : i.signatures ? `${plural(i.signatures, "signature")}` : "not signed");
    new ui.Label(r, { text: bits.join(", "), font: F.small, color: MUTED, width: "100%", overflow: "wrap" });
  }

  section(list, "Details");
  const d = row(list, {}, () => details("Details", detailText(a)));
  new ui.Label(d, { text: detailText(a), font: F.small, width: "100%", overflow: "wrap" });

  again.focus();
  page.focused = -1;
  console.log(`psbtview: ${plural(a.inputs.length, "input")}, ${plural(a.outputs.length, "output")}, ` +
    `sent ${a.sent ?? "?"} sat, change ${a.toSelf ?? "?"} sat, fee ${a.fee ?? "?"} sat, ${a.vsize ?? "?"} vB, ` +
    `${a.network}, ${plural(a.warnings.length, "warning")}`);
  for (const w of a.warnings) console.log(`psbtview: ${w.level}: ${w.text.slice(0, 120)}`);
}

function summaryText(a, l) {
  return [
    a.complete ? `Pays ${btc(a.totalOut)} in all.` : `Spends ${btc(a.totalIn)} from ${plural(a.inputs.length, "coin")}.`,
    a.complete ? null : `Sends ${btc(a.sent)} to others, ${btc(a.toSelf)} back to your wallet.`,
    a.complete ? null : `Fee: ${a.fee === null ? "unknown" : `${a.fee} sat`}` +
      (a.feeRate !== null ? `, ${a.feeRate.toFixed(2)} sat/vB` : "") + (a.vsize ? ` over ${a.vsize} vB` : "") +
      (a.sizeExact ? "." : " (size estimated for when it is signed)."),
    `Read from a ${l.encoding} QR code: ${l.chars} characters, ${l.size} bytes.`,
  ].filter((x) => x !== null).join("\n");
}

function outputText(o) {
  return [
    o.address ? `Address: ${o.address}` : `No address (${typeName(o.type)})`,
    `Amount: ${btc(o.amount)} (${o.amount} sat)`,
    `Type: ${typeName(o.type)}`,
    `Script: ${disassemble(o.script).slice(0, 300)}`,
    ...o.derivations.map((d) => `Key ${d.path} [${d.fingerprint}]${d.taproot ? " (taproot)" : ""}`),
    o.mine ? roleText(o) + (o.unchecked ? ": the key could not be checked against the script here." : ".") : null,
    ...o.problems.map((p) => "Problem: " + p),
  ].filter((x) => x !== null).join("\n");
}

function inputText(i) {
  return [
    `Spends: ${i.prevTxid}:${i.vout}`,
    i.address ? `From: ${i.address}` : null,
    `Amount: ${i.amount === null ? "unknown" : `${btc(i.amount)} (${i.amount} sat)`}`,
    `Type: ${typeName(i.type)}${i.multisig ? `, ${i.multisig.m}-of-${i.multisig.n} multisig` : ""}`,
    `Described by: ${{ full: "its previous transaction", witness: "the spent output only", both: "both",
      none: "nothing" }[i.utxo]}`,
    ...i.derivations.map((d) => `Key ${d.path} [${d.fingerprint}]${d.taproot ? " (taproot)" : ""}`),
    `Signatures: ${i.final ? "final" : `${i.signatures}${i.signaturesNeeded ? " of " + i.signaturesNeeded : ""}`}`,
    i.sighash !== null ? `Sighash: ${sighashName(i.sighash)}` : null,
    `Sequence: 0x${i.sequence.toString(16)}`,
    ...i.problems.map((p) => "Problem: " + p),
  ].filter((x) => x !== null).join("\n");
}

function detailText(a) {
  const lt = a.locktimeKind === "none" ? "none" : a.locktimeKind === "height" ? `block ${a.locktime}`
    : a.locktime === null ? "can't be met" : new Date(a.locktime * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC";
  return [
    `Transaction ID: ${a.txid ?? "known only once signed"}`,
    `Version ${a.txVersion}, locktime ${lt}, ${a.rbf ? "replaceable (RBF)" : "not replaceable"}`,
    `Size: ${a.vsize ?? "?"} vB${a.sizeExact ? "" : " once signed (estimated)"}`,
    `Signed inputs: ${a.signed.inputs} of ${a.inputs.length}`,
    a.fingerprints.length ? `Wallets (key fingerprints): ${a.fingerprints.join(", ")}` : null,
  ].filter((x) => x !== null).join("\n");
}

async function details(title, text) {
  await ui.alert(text, { title });
  if (page.rows[page.focused]) page.rows[page.focused].focus();
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
  if (state.page === "summary" && page.rows.length) {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 4, PageUp: -4 }[ev.key];
    if (step) {
      const i = Math.max(0, Math.min(page.rows.length - 1, (page.focused ?? -1) + step));
      page.rows[i].focus();
      page.rows[i].scrollIntoView();
      return true;
    }
  }
  return false;
});

showHome();
console.log(`psbtview ready (RIPEMD-160 ${typeof crypto.ripemd160 === "function" ? "native" : "not available"})`);
