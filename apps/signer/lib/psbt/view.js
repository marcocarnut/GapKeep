// A transaction's summary as zg:ui widgets: the totals, the warnings, each
// output and input, the details. The only module of lib/psbt that imports zg:ui;
// the others are pure.
//
//   const rows = new Rows(page);          // rows that Tab, arrows, Enter reach
//   showAnalysis(list, rows, a, { encoding, chars, size }, options)
//
// Its text is translated (zg:i18n): amounts, addresses, paths and
// fingerprints are always {placeholders}, written the language's way, and
// the libraries' Messages (../text.js) through tr().
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "zg:ui";
import { t, plural, formatBtc, formatSats, formatNumber } from "zg:i18n";
import { typeName, sighashName } from "./analyze.js";
import { NETWORKS, disassemble } from "./script.js";
import { Message } from "../text.js";

export const MUTED = "#8a9199", RED = "#ef5350", AMBER = "#ffb300", GREEN = "#66bb6a", BLUE = "#64b5f6";
export const LEVEL = { danger: { color: RED, symbol: ui.symbols.warning }, warn: { color: AMBER, symbol: ui.symbols.warning },
  info: { color: BLUE, symbol: ui.symbols.bell } };
export const wide = ui.width >= 1000;
export const FONT = wide ? { title: 28, big: 24, text: 18, small: 16 } : { title: 22, big: 18, text: 14, small: 12 };
export const group4 = (s) => s.replace(/(.{4})(?=.)/g, "$1 ");

// An amount in satoshis as BTC with its unit, the language's way
export const btc = (sats) => (sats === null || sats === undefined ? t("unknown", { $context: "amount" })
  : t("{amount} BTC", { amount: formatBtc(sats) }));

// A library's Message (../text.js) in the person's language; other text as it is.
export function tr(m) {
  if (!(m instanceof Message)) return m === null || m === undefined ? m : String(m);
  const p = {};
  for (const [k, v] of Object.entries(m.params)) p[k] = value(v);
  return m.forms ? plural(m.forms.n, m.forms.one, m.forms.other, p) : t(m.key, p);
}

function value(v) {
  if (v instanceof Message) return tr(v);
  if (v && typeof v === "object") {
    if ("$btc" in v) return formatBtc(v.$btc);
    if ("$sats" in v) return formatSats(v.$sats);
    if ("$number" in v) return formatNumber(v.$number, v.decimals === undefined ? undefined : { decimals: v.decimals });
  }
  return v;
}

// A network's name, as the person reads it
export function networkName(network) {
  return { mainnet: t("Mainnet"), testnet: t("Testnet / Signet"), regtest: t("Regtest") }[network] || NETWORKS[network].name;
}

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
    await ui.alert(text, { title, buttons: [t("OK")] });
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
  return { change: t("Change, back to your wallet"), receive: t("To your own wallet (a receiving address)"),
    mine: t("To your own wallet") }[o.role] || null;
}

const feeIsBad = (a) => a.warnings.some((w) => /fee is high|more than the inputs/.test(w.text));

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
  const top = rows.add(list, { gap: 4 }, () => rows.details(t("Summary"), summaryText(a, source)));
  if (a.complete) {
    line(top, plural(a.outputs.length, "Pays {n} output", "Pays {n} outputs"), btc(a.totalOut), { font: FONT.big });
  } else {
    line(top, plural(external.length, "Sends to {n} address", "Sends to {n} addresses"), btc(a.sent), { font: FONT.big });
    if (a.toSelf) {
      if (options.changeClaimed) line(top, t("Claimed change (not checked yet)"), btc(a.toSelf), { color: AMBER });
      else line(top, t("Change back to your wallet"), btc(a.toSelf), { color: a.outputs.some((o) => o.mine && o.far) ? AMBER : GREEN });
    }
  }
  if (!a.complete) {
    line(top, a.feeRate !== null ? t("Fee ({feeRate} sat/vB)", { feeRate: formatNumber(a.feeRate, { decimals: 1 }) }) : t("Fee"),
      btc(a.fee), { color: feeIsBad(a) ? RED : undefined });
    line(top, plural(a.inputs.length, "Spends {n} coin", "Spends {n} coins"), btc(a.totalIn), { color: MUTED });
  }
  new ui.Label(top, {
    text: t("{network} ({why})", { network: networkName(a.network), why: tr(options.networkNote || a.networkGuess.why) }),
    font: FONT.small, color: MUTED, width: "100%", overflow: "wrap",
  });

  for (const w of a.warnings) {
    const text = tr(w.text);
    const r = rows.add(list, { borderColor: LEVEL[w.level].color }, () => rows.details(t("Warning"), text));
    new ui.Label(r, { text: LEVEL[w.level].symbol + " " + text, color: LEVEL[w.level].color, width: "100%",
      overflow: "wrap", font: FONT.text });
  }

  section(list, t("Outputs ({n})", { n: a.outputs.length }));
  for (const o of a.outputs) {
    const r = rows.add(list, {}, () => rows.details(t("Output {n}", { n: o.index + 1 }), outputText(o)));
    const where = o.address ? group4(o.address) : o.type === "op_return" ? t("OP_RETURN (data, unspendable)")
      : t("{type} script", { type: typeName(o.type) });
    const claimed = options.changeClaimed && o.mine;
    line(r, t("{n}. {where}", { n: o.index + 1, where }), btc(o.amount),
      { color: claimed || o.far ? AMBER : o.mine ? GREEN : undefined });
    const note = (text, color) => new ui.Label(r, { text, color, font: FONT.small, width: "100%", overflow: "wrap" });
    if (claimed) {
      note(ui.symbols.warning + " " + t("Claimed change (not checked yet): {path}", { path: o.derivations[0].path }), AMBER);
    } else if (o.mine && o.far) {
      note(ui.symbols.warning + " " + t("{role}: {path}. Index {index}: found only if the wallet looks that far ahead",
        { role: roleText(o), path: o.checkedPath, index: String(o.far) }), AMBER);
    } else if (o.mine) {
      const path = o.checkedPath !== undefined ? o.checkedPath : o.derivations[0].path;
      const role = path ? t("{role}: {path}", { role: roleText(o), path }) : roleText(o);
      note(ui.symbols.ok + " " + (o.unchecked ? t("{role} (key not checked against the script)", { role }) : role), GREEN);
    } else if (o.stray !== undefined) {
      note(ui.symbols.warning + " " + (o.stray ? t("Yours, but at {path}: the wallet may not see it", { path: o.stray })
        : t("Yours: the wallet may not see it")), AMBER);
    } else if (o.unverified) {
      note(ui.symbols.warning + " " + t("Claims to be change: not proved, see above"), AMBER);
    }
  }

  section(list, t("Inputs ({n})", { n: a.inputs.length }));
  for (const i of a.inputs) {
    const r = rows.add(list, {}, () => rows.details(t("Input {n}", { n: i.index + 1 }), inputText(i)));
    const where = i.address ? group4(i.address) : i.prevTxid.slice(0, 16) + "...:" + i.vout;
    line(r, t("{n}. {where}", { n: i.index + 1, where }), i.amount === null ? t("amount unknown") : btc(i.amount),
      { color: i.problems.length ? RED : undefined });
    const bits = [typeName(i.type)];
    if (i.multisig) {
      bits.push(t("{m}-of-{n}", { m: i.multisig.m, n: i.multisig.n }),
        t("keys {fingerprints}", { fingerprints: [...new Set(i.derivations.map((d) => d.fingerprint))].join(", ") }));
    } else if (i.derivations.length) {
      bits.push(t("{path} [{fingerprint}]", { path: i.derivations[0].path, fingerprint: i.derivations[0].fingerprint }));
    }
    bits.push(i.final ? t("signed, final") : i.signatures ? plural(i.signatures, "{n} signature", "{n} signatures")
      : t("not signed"));
    new ui.Label(r, { text: bits.join(", "), font: FONT.small, color: MUTED, width: "100%", overflow: "wrap" });
    const note = options.inputNote ? options.inputNote(i) : null;
    if (note) new ui.Label(r, { text: note.text, font: FONT.small, color: note.color, width: "100%", overflow: "wrap" });
  }

  section(list, t("Details"));
  const d = rows.add(list, {}, () => rows.details(t("Details"), detailText(a)));
  new ui.Label(d, { text: detailText(a), font: FONT.small, width: "100%", overflow: "wrap" });
}

export function summaryText(a, source) {
  const lines = [];
  if (a.complete) lines.push(t("Pays {total} in all.", { total: btc(a.totalOut) }));
  else {
    lines.push(plural(a.inputs.length, "Spends {spent} from {n} coin.", "Spends {spent} from {n} coins.",
      { spent: btc(a.totalIn) }));
    lines.push(t("Sends {sent} to others, {change} back to your wallet.", { sent: btc(a.sent), change: btc(a.toSelf) }));
    if (a.fee !== null && a.feeRate !== null) {
      const p = { fee: formatSats(a.fee), feeRate: formatNumber(a.feeRate, { decimals: 2 }), vsize: a.vsize };
      lines.push(a.sizeExact ? t("Fee: {fee} sat, {feeRate} sat/vB over {vsize} vB.", p)
        : t("Fee: {fee} sat, {feeRate} sat/vB over {vsize} vB (size estimated for when it is signed).", p));
    } else if (a.fee !== null) {
      lines.push(t("Fee: {fee} sat.", { fee: formatSats(a.fee) }));
    } else if (a.vsize) {
      lines.push(a.sizeExact ? t("Fee: unknown. Size: {vsize} vB.", { vsize: a.vsize })
        : t("Fee: unknown. Size: {vsize} vB once signed (estimated).", { vsize: a.vsize }));
    } else {
      lines.push(t("Fee: unknown."));
    }
  }
  lines.push(t("Read from a {encoding} QR code: {chars} characters, {bytes} bytes.",
    { encoding: source.encoding, chars: source.chars, bytes: source.size }));
  return lines.join("\n");
}

const keyLine = (d) => (d.taproot ? t("Key {path} [{fingerprint}] (taproot)", { path: d.path, fingerprint: d.fingerprint })
  : t("Key {path} [{fingerprint}]", { path: d.path, fingerprint: d.fingerprint }));

export function outputText(o) {
  return [
    o.address ? t("Address: {address}", { address: o.address }) : t("No address ({type})", { type: typeName(o.type) }),
    t("Amount: {amount} ({sats} sat)", { amount: btc(o.amount), sats: formatSats(o.amount) }),
    t("Type: {type}", { type: typeName(o.type) }),
    t("Script: {script}", { script: disassemble(o.script).slice(0, 300) }),
    ...o.derivations.map(keyLine),
    o.mine ? (o.unchecked ? t("{role}: the key could not be checked against the script here.", { role: roleText(o) })
      : t("{role}.", { role: roleText(o) })) : null,
    o.far ? t("Your wallet finds it only if it looks as far ahead as index {index} (gap limit).", { index: String(o.far) })
      : null,
    ...o.problems.map((p) => t("Problem: {problem}", { problem: tr(p) })),
  ].filter((x) => x !== null).join("\n");
}

export function inputText(i) {
  const described = { full: t("its previous transaction"), witness: t("the spent output only"), both: t("both"),
    none: t("nothing") }[i.utxo];
  return [
    t("Spends: {txid}:{vout}", { txid: i.prevTxid, vout: String(i.vout) }),
    i.address ? t("From: {address}", { address: i.address }) : null,
    i.amount === null ? t("Amount: unknown") : t("Amount: {amount} ({sats} sat)", { amount: btc(i.amount), sats: formatSats(i.amount) }),
    i.multisig ? t("Type: {type}, {m}-of-{n} multisig", { type: typeName(i.type), m: i.multisig.m, n: i.multisig.n })
      : t("Type: {type}", { type: typeName(i.type) }),
    t("Described by: {what}", { what: described }),
    ...i.derivations.map(keyLine),
    i.final ? t("Signatures: final") : i.signaturesNeeded ? t("Signatures: {have} of {need}", { have: i.signatures, need: i.signaturesNeeded })
      : t("Signatures: {have}", { have: i.signatures }),
    i.sighash !== null ? t("Sighash: {sighash}", { sighash: sighashName(i.sighash) }) : null,
    t("Sequence: {sequence}", { sequence: "0x" + i.sequence.toString(16) }),
    ...i.problems.map((p) => t("Problem: {problem}", { problem: tr(p) })),
  ].filter((x) => x !== null).join("\n");
}

export function detailText(a) {
  const lt = a.locktimeKind === "none" ? t("none", { $context: "locktime" })
    : a.locktimeKind === "height" ? t("block {height}", { height: String(a.locktime) })
      : a.locktime === null ? t("can't be met")
        : new Date(a.locktime * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC";
  return [
    a.txid ? t("Transaction ID: {txid}", { txid: a.txid }) : t("Transaction ID: known only once signed"),
    a.rbf ? t("Version {version}, locktime {locktime}, replaceable (RBF)", { version: String(a.txVersion), locktime: lt })
      : t("Version {version}, locktime {locktime}, not replaceable", { version: String(a.txVersion), locktime: lt }),
    a.vsize === null ? t("Size: unknown") : a.sizeExact ? t("Size: {vsize} vB", { vsize: a.vsize })
      : t("Size: {vsize} vB once signed (estimated)", { vsize: a.vsize }),
    t("Signed inputs: {signed} of {total}", { signed: a.signed.inputs, total: a.inputs.length }),
    a.fingerprints.length ? t("Wallets (key fingerprints): {fingerprints}", { fingerprints: a.fingerprints.join(", ") }) : null,
  ].filter((x) => x !== null).join("\n");
}
