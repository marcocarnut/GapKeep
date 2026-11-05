// Signer: signs transactions made in Electrum (PSBTs, from its QR code) with
// a key recombined from codex32 shares, and shows the signed transaction as
// a QR code for Electrum to read back.
//
//   1. Load the key: the codex32 shares (typed or scanned), what they hold
//      (BIP-39 entropy as dice39 makes them, or a BIP-32 master seed as
//      BIP-93 says), and the BIP-39 passphrase if any.
//   2. Export the account's public key once, for Electrum's watch-only wallet.
//   3. For each payment: scan Electrum's QR code, check what it does, sign,
//      and show the result to Electrum's camera.
//
// Libraries: lib/psbt (the PSBT Viewer's, copied by tools/share_libs.py),
// lib/codex32.js and vendor/ (the codex32 app's, copied the same way), and
// the signing library (lib/bip39.js, lib/bip32.js, lib/sign.js; tested
// under Node by tests/signer/run_node.mjs).
//
// Never logged: shares, words, the passphrase, the seed, keys. The log goes
// to the serial port in test builds; it gets counts and sizes only. The key
// lives in this app's memory until "Forget the key" or the app ends; never
// in zg:session or on the card.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as crypto from "zg:crypto";
import { setHashes } from "./lib/psbt/hashes.js";
import { DecodeError, toHex } from "./lib/psbt/bytes.js";
import { readPayload, electrumQrText } from "./lib/psbt/transport.js";
import { parsePsbt, serializePsbt } from "./lib/psbt/psbt.js";
import { analyze } from "./lib/psbt/analyze.js";
import { NETWORKS } from "./lib/psbt/script.js";
import { Rows, showAnalysis, MUTED, RED, GREEN, AMBER, wide, FONT, plural } from "./lib/psbt/view.js";
import { checkShare, recover, normalizeShare, Codex32Error } from "./lib/codex32.js";
import * as wallet from "./lib/wallet.js";

setHashes({ sha256: crypto.sha256, ripemd160: crypto.ripemd160 });

const MAX_SHARES = 9;
const ACCEPT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
const NETWORK_ORDER = ["mainnet", "testnet", "regtest"];

const state = {
  page: null,
  // the shares being entered (kept here only, never in zg:session)
  texts: [""],
  meaning: "bip39",   // what the shares hold: "bip39" (dice39) or "bip32" (BIP-93)
  passphrase: "",
  error: null,
  key: null,          // wallet.loadKey()'s result
  loaded: null,       // { encoding, chars, size, psbt }
  network: null,      // chosen by the person; null: as guessed
  signed: null,       // { psbt bytes, tx bytes | null, count }
  exportType: 0,      // index into wallet.EXPORTS
  exportNetwork: "mainnet",
  selftest: null,     // { passed, failed: [] }
};
let page = {};

// --- helpers ------------------------------------------------------------------

function newPage(name, title) {
  state.page = name;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [20, 32] : [10, 12], gap: wide ? 12 : 6, scrollable: true });
  page = { name, rows: new Rows() };
  const head = new ui.Container({ layout: "row", alignItems: "end", gap: 12, width: "100%" });
  new ui.Label(head, { text: title, font: FONT.title, grow: 1 });
  if (state.key) new ui.Label(head, { text: `${ui.symbols.ok} key ${state.key.fingerprint}`, font: FONT.small, color: GREEN });
  return head;
}

const paragraph = (parent, text, props = {}) =>
  new ui.Label(parent, { text, width: "100%", overflow: "wrap", font: FONT.text, ...props });

const buttonRow = (parent) => new ui.Container(parent, { layout: "row-wrap", gap: 8, width: "100%" });

function warning(parent, text, color = AMBER) {
  const box = new ui.Panel(parent, { width: "100%", layout: "column", padding: 10, borderColor: color, borderWidth: 2 });
  new ui.Label(box, { text: ui.symbols.warning + "  " + text, font: FONT.text, width: "100%", overflow: "wrap" });
  return box;
}

const selftestOk = () => state.selftest && !state.selftest.failed.length;

// --- home -----------------------------------------------------------------------

function showHome() {
  newPage("home", ui.symbols.ok + " Signer");
  paragraph(ui.screen, "Signs transactions made in Electrum, with a key recombined from codex32 shares. " +
    "Electrum shows the transaction as a QR code; this shows the signed one back as a QR code.");
  const buttons = buttonRow(ui.screen);
  let first;
  if (!state.key) {
    first = new ui.Button(buttons, { text: ui.symbols.plus + " Load the key", onClick: () => showShares(0) });
  } else {
    first = new ui.Button(buttons, { text: ui.symbols.image + " Scan a transaction", onClick: showScan });
    new ui.Button(buttons, { text: ui.symbols.upload + " Public key for Electrum", onClick: showExport });
  }
  if (state.loaded) new ui.Button(buttons, { text: ui.symbols.list + " Last transaction", onClick: showReview });
  if (state.key) new ui.Button(buttons, { text: ui.symbols.trash + " Forget the key", onClick: forgetKey });
  new ui.Button(buttons, { text: ui.symbols.home + " Leave", onClick: () => sys.exit() });

  if (state.key) {
    const k = state.key;
    paragraph(ui.screen, `Key loaded: master fingerprint ${k.fingerprint}, from ${k.description}.`, { color: GREEN });
  } else {
    paragraph(ui.screen, "First load the key: type or scan the codex32 shares. The key stays in this app's " +
      "memory only, until you forget it or leave the app.", { color: MUTED });
  }
  paragraph(ui.screen, "Setting up Electrum (once): show it the public key (\"Public key for Electrum\"), as a new " +
    "wallet: Standard wallet, Use a master key, then scan the QR code. Electrum then makes transactions that " +
    "this device signs. Each time: in Electrum, make the transaction, then Export (or Share), Show as QR code; " +
    "here, Scan a transaction; after signing, in Electrum: Tools, Load transaction, From QR code.", { color: MUTED });
  page.selftest = paragraph(ui.screen, "", { font: FONT.small });
  showSelftest();
  first.focus();
}

function showSelftest() {
  if (!page.selftest) return;
  const st = state.selftest;
  if (!st) page.selftest.set({ text: "Self-test running...", color: MUTED });
  else if (!st.failed.length) {
    page.selftest.set({ text: `${ui.symbols.ok} Self-test passed (${st.passed} checks: BIP-39, BIP-32, ` +
      "signatures, against the BIPs' test vectors).", color: GREEN });
  } else {
    page.selftest.set({ text: `${ui.symbols.close} Self-test FAILED: do not sign with this device.\n` +
      st.failed.join("\n"), color: RED });
  }
}

function forgetKey() {
  if (state.key) wallet.wipeKey(state.key);
  state.key = null;
  state.signed = null;
  state.passphrase = "";
  sys.gc();
  console.log("signer: key forgotten");
  showHome();
}

// --- the shares -----------------------------------------------------------------

function boxCount() {
  let need = 2, last = 1;
  for (const t of state.texts) {
    const r = checkShare(t);
    if (r.ok) {
      need = r.share.threshold === 0 ? 1 : r.share.threshold;
      break;
    }
  }
  state.texts.forEach((t, i) => { if (normalizeShare(t)) last = Math.max(last, i + 1); });
  return Math.min(MAX_SHARES, Math.max(need, last));
}

function showShares(focus) {
  newPage("shares", ui.symbols.plus + " Load the key");
  paragraph(ui.screen, "Type the codex32 shares (spaces don't matter), or scan them. As many as the threshold: " +
    "the third character of each share.", { color: MUTED });
  page.boxes = new ui.Container({ layout: "column", gap: 4, width: "100%" });
  page.fields = [];
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });

  // what the shares hold
  new ui.Label({ text: "The shares hold", font: FONT.big, color: MUTED });
  const meaning = new ui.Dropdown({
    width: "100%",
    options: ["A seed phrase's entropy, as dice39 makes them (BIP-39: 12 or 24 words)",
      "A BIP-32 master seed, as BIP-93 says"],
    selected: state.meaning === "bip39" ? 0 : 1,
    onChange: (ev) => {
      state.meaning = ev.value === 0 ? "bip39" : "bip32";
      page.passRow.hidden = state.meaning !== "bip39";
    },
  });
  page.passRow = new ui.Container({ layout: "column", gap: 4, width: "100%", hidden: state.meaning !== "bip39" });
  paragraph(page.passRow, "BIP-39 passphrase (leave empty if none). A different passphrase is a different wallet: " +
    "check the fingerprint shown next.", { color: MUTED });
  const pass = page.pass = new ui.TextArea(page.passRow, { oneLine: true, password: true, width: "100%", text: state.passphrase,
    maxLength: 256, placeholder: "no passphrase", font: FONT.text });
  pass.onChange = (ev) => (state.passphrase = ev.value);
  pass.onSubmit = () => loadKey();
  new ui.Checkbox(page.passRow, { text: "Show the passphrase", onChange: (ev) => (pass.password = !ev.value) });

  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " Load the key", onClick: loadKey });
  new ui.Button(buttons, { text: ui.symbols.image + " Scan shares", onClick: showShareScan });
  new ui.Button(buttons, { text: ui.symbols.trash + " Clear", onClick: clearShares });
  new ui.Button(buttons, { text: ui.symbols.left + " Back", onClick: showHome });
  page.load.disabled = !selftestOk();
  if (!selftestOk()) paragraph(ui.screen, state.selftest ? "The self-test failed: no key can be loaded."
    : "Waiting for the self-test.", { color: RED });

  syncBoxes();
  showError(state.error);
  if (focus === "load") page.load.focus();
  else page.fields[Math.min(focus || 0, page.fields.length - 1)].ta.focus();
}

function syncBoxes() {
  const n = boxCount();
  while (state.texts.length < n) state.texts.push("");
  state.texts.length = n;
  while (page.fields.length > n) page.fields.pop().row.delete();
  while (page.fields.length < n) page.fields.push(makeBox(page.fields.length));
  page.fields.forEach((f, i) => updateNote(i));
}

function makeBox(i) {
  const row = new ui.Container(page.boxes, { layout: "column", gap: 2, width: "100%" });
  const line = new ui.Container(row, { layout: "row", alignItems: "center", gap: 8, width: "100%" });
  new ui.Label(line, { text: `${i + 1}.`, width: 24, textAlign: "right", color: MUTED });
  const ta = new ui.TextArea(line, { oneLine: true, grow: 1, maxLength: 160, accept: ACCEPT, text: state.texts[i] || "",
    placeholder: i === 0 ? "ms1..." : "", font: wide ? 20 : 16 });
  const note = new ui.Label(row, { text: "", font: FONT.small, width: "100%", padding: [0, 0, 0, 32], hidden: true });
  const f = { row, ta, note, committed: false };
  ta.onChange = (ev) => {
    state.texts[i] = ev.value;
    f.committed = false;
    showError(null);
    syncBoxes();
  };
  ta.onBlur = () => {
    if (state.page !== "shares" || !ta.alive) return;
    f.committed = !!normalizeShare(state.texts[i]);
    updateNote(i);
  };
  ta.onSubmit = () => {
    f.committed = !!normalizeShare(state.texts[i]);
    updateNote(i);
    if (!checkShare(state.texts[i]).ok) return;
    const next = page.fields.findIndex((g, j) => j > i && !normalizeShare(state.texts[j]));
    if (next >= 0) page.fields[next].ta.focus();
    else if (state.meaning === "bip39") page.pass.focus();
    else loadKey();
  };
  return f;
}

function updateNote(i) {
  const f = page.fields[i];
  if (!f) return;
  const text = state.texts[i];
  if (!normalizeShare(text)) return f.note.set({ text: "", hidden: true });
  const r = checkShare(text, { suggest: f.committed });
  if (r.ok) {
    const s = r.share;
    const what = s.isSecret ? `the secret itself, identifier ${s.id.toUpperCase()}`
      : `share ${s.index.toUpperCase()}, identifier ${s.id.toUpperCase()}, threshold ${s.thresholdChar}`;
    return f.note.set({ text: `${ui.symbols.ok} ${what}, ${s.seedBytes}-byte seed`, color: GREEN, hidden: false });
  }
  const e = r.error;
  const soft = e.code === "length" || e.code === "checksum" || (e.code === "prefix" && e.partial);
  if (soft && !f.committed) {
    const n = normalizeShare(text).length;
    return f.note.set({ text: plural(n, "character"), color: MUTED, hidden: false });
  }
  f.note.set({ text: ui.symbols.close + " " + e.message, color: RED, hidden: false });
}

function showError(msg) {
  state.error = msg;
  if (state.page === "shares" && page.error) page.error.set({ text: msg || "", hidden: !msg });
}

function clearShares() {
  state.texts = [""];
  state.passphrase = "";
  state.error = null;
  sys.gc();
  console.log("signer: shares cleared");
  showShares(0);
}

function wipeShares() {
  state.texts = [""];
  state.passphrase = "";
  sys.gc();
}

let busy = false;

// Recombines the shares, then derives the master key (PBKDF2 for a seed
// phrase: about 0.1 s on a Pi Zero).
function loadKey() {
  if (busy || state.page !== "shares" || !selftestOk()) return;
  const texts = state.texts.filter((t) => normalizeShare(t));
  if (!texts.length) return showError("Type or scan the shares first.");
  let res;
  try {
    res = recover(texts);
  } catch (e) {
    if (!(e instanceof Codex32Error)) throw e;
    console.log(`signer: shares refused: ${e.code}`);
    page.fields.forEach((f, i) => { f.committed = !!normalizeShare(state.texts[i]); updateNote(i); });
    return showError(e.message);
  }
  busy = true;
  let key;
  try {
    key = wallet.loadKey(res.seed, { meaning: state.meaning, passphrase: state.passphrase });
  } catch (e) {
    console.log(`signer: key refused: ${e.name}`);
    return showError(e.message);
  } finally {
    res.seed.fill(0);
    busy = false;
  }
  if (state.key) wallet.wipeKey(state.key);
  state.key = key;
  state.signed = null;
  wipeShares();
  console.log(`signer: key loaded (${state.meaning}, ${texts.length} share${texts.length === 1 ? "" : "s"})`);
  showKeyLoaded();
}

function showKeyLoaded() {
  const k = state.key;
  newPage("loaded", ui.symbols.ok + " Key loaded");
  new ui.Label({ text: `Master fingerprint: ${k.fingerprint}`, font: FONT.big });
  paragraph(ui.screen, `From ${k.description}.`);
  const acct = wallet.exportKey(k, "p2wpkh", "mainnet");
  paragraph(ui.screen, `Native segwit account ${acct.path}: fingerprint ${acct.fingerprint}.`);
  paragraph(ui.screen, "Check one of them against what you know of this wallet: a wallet made from the seed " +
    "phrase shows the master fingerprint; Electrum's watch-only wallet, made from the public key this device " +
    "exports, shows the account's (Wallet, Information). A different one means another passphrase, " +
    "other shares, or the other choice of what the shares hold.", { color: MUTED });
  const buttons = buttonRow(ui.screen);
  const scan = new ui.Button(buttons, { text: ui.symbols.image + " Scan a transaction", onClick: showScan });
  new ui.Button(buttons, { text: ui.symbols.upload + " Public key for Electrum", onClick: showExport });
  new ui.Button(buttons, { text: ui.symbols.home + " Home", onClick: showHome });
  scan.focus();
}

// --- scanning shares ------------------------------------------------------------

function showShareScan() {
  newPage("sharescan", ui.symbols.image + " Scan shares");
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 8, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 480 : 280, height: wide ? 360 : 210,
    onDetect: ({ text }) => scannedShare(text),
    onError: ({ reason }) => say(`The camera stopped: ${reason}.`, RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, "Show the shares' QR codes, one at a time.", { color: MUTED });
  new ui.Button(side, { text: ui.symbols.left + " Done", onClick: () => showShares(firstEmpty()) }).focus();
}

function firstEmpty() {
  const i = state.texts.findIndex((t) => !normalizeShare(t));
  return i >= 0 ? i : "load";
}

function say(text, color) {
  if (page.status) page.status.set({ text, color });
}

function scannedShare(text) {
  if (state.page !== "sharescan") return;
  const r = text == null ? null : checkShare(text.trim());
  if (!r || !r.ok) {
    console.log("signer: scanned a code that is not a codex32 share");
    return say("That is not a codex32 share.", RED);
  }
  const s = r.share;
  const have = state.texts.map((t) => checkShare(t)).filter((x) => x.ok).map((x) => x.share);
  if (have.length && (have[0].id !== s.id || have[0].threshold !== s.threshold)) {
    return say(`That share is from another split (identifier ${s.id.toUpperCase()}).`, RED);
  }
  if (have.some((o) => o.index === s.index)) return say(`Share ${s.index.toUpperCase()} is in already.`, AMBER);
  let slot = state.texts.findIndex((t) => !normalizeShare(t));
  if (slot < 0) slot = state.texts.length;
  if (slot >= MAX_SHARES) return say("No room for more shares.", RED);
  state.texts[slot] = s.string;
  const k = s.threshold === 0 ? 1 : s.threshold, n = have.length + 1;
  console.log(`signer: scanned share ${n} of ${k}`);
  if (n >= k) {
    page.scanner.stop();
    showShares("load");
    return;
  }
  say(`Share ${s.index.toUpperCase()} added: ${n} of ${k}. Next one.`, GREEN);
}

// --- the public key for Electrum ----------------------------------------------

function showExport() {
  if (!state.key) return showHome();
  newPage("export", ui.symbols.upload + " Public key for Electrum");
  paragraph(ui.screen, "Show this to Electrum once, to make the watch-only wallet whose transactions this device " +
    "signs: File, New/Restore, Standard wallet, Use a master key, then the camera button.", { color: MUTED });
  const opts = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  new ui.Dropdown(opts, {
    grow: 1,
    options: wallet.EXPORTS.map((x) => x.name), selected: state.exportType,
    onChange: (ev) => { state.exportType = ev.value; drawExport(); },
  });
  new ui.Dropdown(opts, {
    options: NETWORK_ORDER.map((n) => NETWORKS[n].name), selected: NETWORK_ORDER.indexOf(state.exportNetwork),
    onChange: (ev) => { state.exportNetwork = NETWORK_ORDER[ev.value]; drawExport(); },
  });
  page.out = new ui.Container({ layout: "column", gap: 6, width: "100%", alignItems: "center" });
  const back = new ui.Button({ text: ui.symbols.left + " Back", onClick: showHome });
  drawExport();
  back.focus();
}

function drawExport() {
  page.out.clear();
  const x = wallet.exportKey(state.key, wallet.EXPORTS[state.exportType].id, state.exportNetwork);
  const size = Math.min(ui.height - 200, ui.width - 64, 420);
  new ui.QRCode(page.out, { data: x.text, size, ecc: "M" });
  new ui.Label(page.out, { text: `Account ${x.path}, fingerprint ${x.fingerprint}`, font: FONT.text });
  new ui.Label(page.out, { text: x.text, font: FONT.small, width: "100%", overflow: "wrap", textAlign: "center" });
  console.log(`signer: showing the ${wallet.EXPORTS[state.exportType].id} public key (${state.exportNetwork})`);
}

// --- scanning a transaction -------------------------------------------------------

function showScan() {
  newPage("scan", ui.symbols.image + " Scan a transaction");
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 6, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 560 : 280, height: wide ? 420 : 210,
    onDetect: ({ text, bytes }) => scannedTx(text, bytes),
    onError: ({ reason }) => say(`The camera stopped: ${reason}.`, RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, "Show Electrum's QR code of the transaction (Export, Show as QR code). " +
    "Large ones need a steady hand and good light.");
  new ui.Button(side, { text: ui.symbols.left + " Back", onClick: () => (state.loaded ? showReview() : showHome()) }).focus();
}

function scannedTx(text, bytes) {
  if (state.page !== "scan") return;
  let loaded;
  try {
    const r = readPayload(text, bytes);
    if (r.kind !== "psbt") {
      return say("This is a signed transaction already: nothing to sign. (The PSBT Viewer shows what it does.)", AMBER);
    }
    loaded = { encoding: r.encoding, chars: text === null ? bytes.length : text.length, size: r.bytes.length,
      psbt: parsePsbt(r.bytes) };
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    const why = e.message.endsWith(".") ? e.message : e.message + ".";
    console.log(`signer: refused a code: ${why}`);
    return say(ui.symbols.warning + " " + (/^(This|The code)/.test(why) ? why : "Not a transaction Electrum would load: " + why), RED);
  }
  console.log(`signer: read a PSBT (${loaded.encoding}, ${loaded.chars} characters, ${loaded.size} bytes)`);
  page.scanner.stop();
  state.loaded = loaded;
  state.network = null;
  state.signed = null;
  showReview();
}

// --- review and sign ------------------------------------------------------------------

function showReview() {
  const l = state.loaded;
  const a = analyze(l.psbt, { network: state.network });
  const plan = state.key ? wallet.plan(l.psbt, state.key, { network: a.network }) : null;
  // change only where deriving the key proves it (the analysis trusts the
  // fingerprint, which anyone can write)
  if (plan) {
    for (const o of a.outputs) {
      const p = plan.outputs[o.index];
      if (o.mine && !p.ours) {
        a.warnings.unshift({ level: "danger", text: `Output ${o.index + 1} claims to be your change, but its key ` +
          `doesn't derive from this wallet${p.problem ? ` (${p.problem})` : ""}: it pays someone else.` });
      }
      o.mine = p.ours;
      o.unchecked = false;
      if (p.ours) {
        o.role = p.role || "mine";
        o.derivations = [{ ...o.derivations[0], path: p.path }];
      }
      for (const odd of p.oddities || []) a.warnings.push({ level: "warn", text: `Output ${o.index + 1}: ${odd}` });
    }
    a.toSelf = a.outputs.filter((o) => o.mine).reduce((s, o) => s + o.amount, 0);
    a.sent = a.totalOut === null ? null : a.totalOut - a.toSelf;
    for (const i of plan.inputs) {
      for (const odd of i.oddities || []) a.warnings.push({ level: "warn", text: `Input ${i.index + 1}: ${odd}` });
    }
  }

  newPage("review", "Transaction to sign");
  const buttons = buttonRow(ui.screen);
  const count = plan ? plan.inputs.filter((i) => i.sign).length : 0;
  let first;
  if (!state.key) {
    first = new ui.Button(buttons, { text: ui.symbols.plus + " Load the key to sign", onClick: () => showShares(0) });
  } else {
    first = new ui.Button(buttons, { text: ui.symbols.edit + ` Sign ${plural(count, "input")}`, onClick: () => sign(a) });
    first.disabled = count === 0 || !selftestOk();
  }
  new ui.Button(buttons, { text: ui.symbols.image + " Scan another", onClick: showScan });
  new ui.Button(buttons, {
    text: "Network: " + NETWORKS[a.network].name,
    onClick: () => {
      state.network = NETWORK_ORDER[(NETWORK_ORDER.indexOf(a.network) + 1) % NETWORK_ORDER.length];
      showReview();
    },
  });
  new ui.Button(buttons, { text: ui.symbols.home + " Home", onClick: showHome });
  if (plan && count === 0) paragraph(ui.screen, "Nothing here can be signed with this key: see each input.", { color: RED });

  const list = new ui.Container({ layout: "column", gap: wide ? 8 : 5, width: "100%", grow: 1, scrollable: true });
  showAnalysis(list, page.rows, a, l, {
    networkNote: state.network ? "chosen" : null,
    inputNote: (i) => {
      if (!plan) return null;
      const p = plan.inputs[i.index];
      return p.sign ? { text: `${ui.symbols.edit} Will be signed (${p.path})`, color: GREEN }
        : { text: `${ui.symbols.close} Not signed: ${p.reason}`, color: AMBER };
    },
  });
  first.focus();
  console.log(`signer: review: ${plural(a.inputs.length, "input")}, ${count} to sign, ${plural(a.outputs.length, "output")}, ` +
    `fee ${a.fee ?? "?"} sat, ${a.network}, ${plural(a.warnings.length, "warning")}`);
}

async function sign(a) {
  if (busy || !state.key || !selftestOk()) return;
  if (a.warnings.some((w) => w.level === "danger")) {
    const answer = await ui.alert("There are serious warnings (in red) about this transaction. Sign it anyway?",
      { title: "Sign?", buttons: ["Don't sign", "Sign anyway"] });
    if (answer !== 1) return;
  }
  busy = true;
  let r;
  try {
    r = wallet.sign(state.loaded.psbt, state.key, { network: a.network });
  } finally {
    busy = false;
  }
  state.signed = r;
  // (a transaction is not secret: its hash lets the tests compare it with Electrum's)
  console.log(`signer: signed ${plural(r.count, "input")}` +
    (r.tx ? `, transaction complete (SHA-256 ${toHex(crypto.sha256(r.tx).subarray(0, 8))})` : ""));
  showSigned(r.tx ? "tx" : "psbt");
}

// --- the signed transaction -----------------------------------------------------------

function showSigned(form) {
  const s = state.signed;
  newPage("signed", ui.symbols.ok + " Signed");
  const bytes = form === "tx" ? s.tx : s.psbt;
  const text = electrumQrText(bytes);
  paragraph(ui.screen, (form === "tx"
    ? "The complete, signed transaction. "
    : "The PSBT with this device's signatures. ") +
    "In Electrum: Tools, Load transaction, From QR code; check it there, then Broadcast.", { color: MUTED });
  const buttons = buttonRow(ui.screen);
  const done = new ui.Button(buttons, { text: ui.symbols.ok + " Done", onClick: showHome });
  if (s.tx) {
    new ui.Button(buttons, { text: form === "tx" ? "Show as PSBT" : "Show the transaction",
      onClick: () => showSigned(form === "tx" ? "psbt" : "tx") });
  }
  const size = Math.min(ui.height - 140, ui.width - 64);
  let qr = null;
  for (const ecc of ["M", "L"]) {
    try {
      qr = new ui.QRCode({ data: text, size, ecc });
      break;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
  }
  if (!qr) warning(ui.screen, `Too large for one QR code (${text.length} characters).` +
    (form === "psbt" && s.tx ? " Try the transaction: it is smaller." : ""), RED);
  else new ui.Label({ text: `${bytes.length} bytes, ${text.length} characters, ${qr.modules}x${qr.modules}`, font: FONT.small, color: MUTED });
  done.focus();
  console.log(`signer: showing the signed ${form} (${bytes.length} bytes, ${text.length} characters)`);
}

// --- keys ------------------------------------------------------------------------------

ui.onKey((ev) => {
  if (ev.key === "Escape") {
    if (state.page === "sharescan") showShares(firstEmpty());
    else if (state.page === "scan") state.loaded ? showReview() : showHome();
    else if (["shares", "export", "loaded", "review", "signed"].includes(state.page)) showHome();
    else return false;
    return true;
  }
  if (state.page === "review") return page.rows.keys(ev);
  return false;
});

// --- start -----------------------------------------------------------------------------

showHome();
console.log("signer ready");
setTimeout(() => {
  state.selftest = wallet.selfTest();
  console.log(`signer selftest: ${state.selftest.passed} passed, ${state.selftest.failed.length} failed`);
  for (const f of state.selftest.failed) console.log("signer selftest FAIL:", f);
  if (state.page === "home") showSelftest();
}, 50);
