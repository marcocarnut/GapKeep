// A transaction's summary as zg:ui widgets: the totals, the warnings, each
// output and input, the details. The only module of lib/psbt that imports zg:ui;
// the others are pure.
//
//   const rows = new Rows(page);          // rows that Tab, arrows, Enter reach
//   showAnalysis(list, rows, a, { encoding, chars, size }, options)
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "zg:ui";
import { formatBtc, typeName, sighashName } from "./analyze.js";
import { NETWORKS, disassemble } from "./script.js";

export const MUTED = "#8a9199", RED = "#ef5350", AMBER = "#ffb300", GREEN = "#66bb6a", BLUE = "#64b5f6";
export const LEVEL = { danger: { color: RED, symbol: ui.symbols.warning }, warn: { color: AMBER, symbol: ui.symbols.warning },
  info: { color: BLUE, symbol: ui.symbols.bell } };
export const wide = ui.width >= 1000;
export const FONT = wide ? { title: 28, big: 24, text: 18, small: 16 } : { title: 22, big: 18, text: 14, small: 12 };
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const btc = (sats) => (sats === null || sats === undefined ? "unknown" : `${formatBtc(Number(sats))} BTC`);
export const group4 = (s) => s.replace(/(.{4})(?=.)/g, "$1 ");

// Rows a person moves through with Tab, the arrow keys and Page Up/Down;
// Enter opens a row's details. keys(ev) handles the keys: call it from
// ui.onKey while the rows are on screen.
export class Rows {
  constructor() {
    this.rows = [];
    this.focused = -1;
  }

  add(parent, props, onClick) {
    const r = new ui.Panel(parent, {
      layout: "column", gap: 2, width: "100%", padding: wide ? [8, 14] : [5, 8], scrollable: false,
      focusable: true, clickable: true, onClick, ...props,
    });
    const i = this.rows.length;
    r.on("focus", () => (this.focused = i));
    this.rows.push(r);
    return r;
  }

  keys(ev) {
    if (!this.rows.length) return false;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 4, PageUp: -4 }[ev.key];
    if (!step) return false;
    const i = Math.max(0, Math.min(this.rows.length - 1, this.focused + step));
    this.rows[i].focus();
    this.rows[i].scrollIntoView();
    return true;
  }

  // a dialog, then the focus back where it was
  async details(title, text) {
    await ui.alert(text, { title });
    if (this.rows[this.focused]) this.rows[this.focused].focus();
  }
}

export function line(parent, left, right, props = {}) {
  props = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
  const r = new ui.Container(parent, { layout: "row", gap: 10, width: "100%", alignItems: "start" });
  const l = new ui.Label(r, { text: left, grow: 1, overflow: "wrap", font: FONT.text, ...props });
  if (right !== null) new ui.Label(r, { text: right, font: FONT.text, textAlign: "right", ...props });
  return l;
}

export function section(parent, text) {
  new ui.Label(parent, { text, font: FONT.big, color: MUTED, width: "100%" });
}

export function roleText(o) {
  return { change: "Change, back to your wallet", receive: "To your own wallet (a receiving address)",
    mine: "To your own wallet" }[o.role] || null;
}

// The analysis `a` (analyze() or analyzeTx()) into `list`, a column.
// `source`: { encoding, chars, size } of the QR code it came from.
// options:
//   networkNote   text after the network's name (why this network)
//   changeClaimed outputs marked `mine` are only the PSBT's word so far (the
//                 Signer, before the keys are in)
//   inputNote(i)  null or { text, color }: a line under input i (the Signer:
//                 whether it will be signed)
export function showAnalysis(list, rows, a, source, options = {}) {
  const external = a.outputs.filter((o) => !o.mine);
  const top = rows.add(list, { gap: 4 }, () => rows.details("Summary", summaryText(a, source)));
  if (a.complete) {
    line(top, `Pays ${plural(a.outputs.length, "output")}`, btc(a.totalOut), { font: FONT.big });
  } else {
    line(top, `Sends to ${external.length} ${external.length === 1 ? "address" : "addresses"}`, btc(a.sent), { font: FONT.big });
    if (a.toSelf) {
      if (options.changeClaimed) line(top, "Claimed change (not checked yet)", btc(a.toSelf), { color: AMBER });
      else line(top, "Change back to your wallet", btc(a.toSelf), { color: a.outputs.some((o) => o.mine && o.far) ? AMBER : GREEN });
    }
  }
  const rate = a.feeRate !== null ? ` (${a.feeRate.toFixed(1)} sat/vB)` : "";
  if (!a.complete) {
    line(top, "Fee" + rate, a.fee === null ? "unknown" : btc(a.fee),
      { color: a.warnings.some((w) => /fee is high|more than the inputs/.test(w.text)) ? RED : undefined });
    line(top, `Spends ${plural(a.inputs.length, "coin")}`, btc(a.totalIn), { color: MUTED });
  }
  new ui.Label(top, {
    text: `${NETWORKS[a.network].name} (${options.networkNote || a.networkGuess.why})`, font: FONT.small, color: MUTED,
    width: "100%", overflow: "wrap",
  });

  for (const w of a.warnings) {
    const r = rows.add(list, { borderColor: LEVEL[w.level].color }, () => rows.details("Warning", w.text));
    new ui.Label(r, { text: LEVEL[w.level].symbol + " " + w.text, color: LEVEL[w.level].color, width: "100%",
      overflow: "wrap", font: FONT.text });
  }

  section(list, `Outputs (${a.outputs.length})`);
  for (const o of a.outputs) {
    const r = rows.add(list, {}, () => rows.details(`Output ${o.index + 1}`, outputText(o)));
    const where = o.address ? group4(o.address) : o.type === "op_return" ? "OP_RETURN (data, unspendable)" : typeName(o.type) + " script";
    const claimed = options.changeClaimed && o.mine;
    line(r, `${o.index + 1}. ${where}`, btc(o.amount), { color: claimed || o.far ? AMBER : o.mine ? GREEN : undefined });
    if (claimed) {
      new ui.Label(r, { text: `${ui.symbols.warning} Claimed change (not checked yet): ${o.derivations[0].path}`,
        color: AMBER, font: FONT.small });
    } else if (o.mine && o.far) {
      new ui.Label(r, { text: `${ui.symbols.warning} ${roleText(o)}: ${o.checkedPath}. Index ${o.far}: found only if the wallet looks that far ahead`,
        color: AMBER, font: FONT.small, width: "100%", overflow: "wrap" });
    } else if (o.mine) {
      const path = o.checkedPath !== undefined ? o.checkedPath : o.derivations[0].path;
      new ui.Label(r, { text: `${ui.symbols.ok} ${roleText(o)}${path ? ": " + path : ""}` +
        (o.unchecked ? " (key not checked against the script)" : ""), color: GREEN, font: FONT.small });
    } else if (o.stray !== undefined) {
      new ui.Label(r, { text: `${ui.symbols.warning} Yours${o.stray ? `, but at ${o.stray}` : ""}: the wallet may not see it`,
        color: AMBER, font: FONT.small, width: "100%", overflow: "wrap" });
    } else if (o.unverified) {
      new ui.Label(r, { text: `${ui.symbols.warning} Claims to be change: not proved, see above`, color: AMBER, font: FONT.small });
    }
  }

  section(list, `Inputs (${a.inputs.length})`);
  for (const i of a.inputs) {
    const r = rows.add(list, {}, () => rows.details(`Input ${i.index + 1}`, inputText(i)));
    line(r, `${i.index + 1}. ${i.address ? group4(i.address) : i.prevTxid.slice(0, 16) + "...:" + i.vout}`,
      i.amount === null ? "amount unknown" : btc(i.amount), { color: i.problems.length ? RED : undefined });
    const bits = [typeName(i.type)];
    if (i.multisig) bits.push(`${i.multisig.m}-of-${i.multisig.n}`, `keys ${[...new Set(i.derivations.map((d) => d.fingerprint))].join(", ")}`);
    else if (i.derivations.length) bits.push(`${i.derivations[0].path} [${i.derivations[0].fingerprint}]`);
    bits.push(i.final ? "signed, final" : i.signatures ? `${plural(i.signatures, "signature")}` : "not signed");
    new ui.Label(r, { text: bits.join(", "), font: FONT.small, color: MUTED, width: "100%", overflow: "wrap" });
    const note = options.inputNote ? options.inputNote(i) : null;
    if (note) new ui.Label(r, { text: note.text, font: FONT.small, color: note.color, width: "100%", overflow: "wrap" });
  }

  section(list, "Details");
  const d = rows.add(list, {}, () => rows.details("Details", detailText(a)));
  new ui.Label(d, { text: detailText(a), font: FONT.small, width: "100%", overflow: "wrap" });
}

export function summaryText(a, source) {
  return [
    a.complete ? `Pays ${btc(a.totalOut)} in all.` : `Spends ${btc(a.totalIn)} from ${plural(a.inputs.length, "coin")}.`,
    a.complete ? null : `Sends ${btc(a.sent)} to others, ${btc(a.toSelf)} back to your wallet.`,
    a.complete ? null : `Fee: ${a.fee === null ? "unknown" : `${a.fee} sat`}` +
      (a.feeRate !== null ? `, ${a.feeRate.toFixed(2)} sat/vB` : "") + (a.vsize ? ` over ${a.vsize} vB` : "") +
      (a.sizeExact ? "." : " (size estimated for when it is signed)."),
    `Read from a ${source.encoding} QR code: ${source.chars} characters, ${source.size} bytes.`,
  ].filter((x) => x !== null).join("\n");
}

export function outputText(o) {
  return [
    o.address ? `Address: ${o.address}` : `No address (${typeName(o.type)})`,
    `Amount: ${btc(o.amount)} (${o.amount} sat)`,
    `Type: ${typeName(o.type)}`,
    `Script: ${disassemble(o.script).slice(0, 300)}`,
    ...o.derivations.map((d) => `Key ${d.path} [${d.fingerprint}]${d.taproot ? " (taproot)" : ""}`),
    o.mine ? roleText(o) + (o.unchecked ? ": the key could not be checked against the script here." : ".") : null,
    o.far ? `Your wallet finds it only if it looks as far ahead as index ${o.far} (gap limit).` : null,
    ...o.problems.map((p) => "Problem: " + p),
  ].filter((x) => x !== null).join("\n");
}

export function inputText(i) {
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

export function detailText(a) {
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
