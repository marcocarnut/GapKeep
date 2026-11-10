// Signer: shows what a Bitcoin transaction does, then signs it. It takes the
// transaction first, so you see it before any secret is in memory:
//
//   1. Read the PSBT from a QR code (Electrum's Base43, for now), merge other
//      copies of it (BIP-174's Combiner). A finished transaction is only
//      shown. Change is a claim here: the PSBT's word.
//   2. Load the keys: codex32 shares, BIP-39 words, an xprv, a WIF. For each,
//      the app says what it can sign, and derives the change itself: the
//      summary comes again, with change checked or flagged.
//   3. Sign, and show a finished transaction, or a PSBT that needs more
//      signatures. The keys are forgotten then, unless you keep them for the
//      next transaction.
//
// The account's public key is on offer too, as a descriptor or Electrum's
// zpub, once a master key is loaded.
//
// Libraries: lib/psbt (reading and explaining PSBTs), lib/codex32.js and vendor/ (the codex32 app's, copied the same way), and
// the signing library (lib/bip39.js, bip32.js, keys.js, sign.js, combine.js,
// review.js; tested under Node by tests/signer/run_node.mjs).
//
// The text on screen is translated (gk:i18n, lang/<language>.json; the
// libraries' text through tr(), lib/psbt/view.js). Amounts, addresses,
// fees, txids, fingerprints and paths are always {placeholders}. The log
// stays in English.
//
// Never logged: shares, words, the passphrase, the seed, keys, public keys.
// The log goes to the serial port in test builds; it gets counts and sizes
// only. Keys live in this app's memory until they are forgotten or the app
// ends; never in gk:session or on the card.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as crypto from "gk:crypto";
import { t, tm, plural } from "gk:i18n";
import { setHashes } from "./lib/psbt/hashes.js";
import { DecodeError, toHex } from "./lib/psbt/bytes.js";
import { electrumQrText } from "./lib/psbt/transport.js";
import { parsePsbt } from "./lib/psbt/psbt.js";
import { parseTx, txid as txidOf } from "./lib/psbt/tx.js";
import { analyze, analyzeTx, guessNetwork } from "./lib/psbt/analyze.js";
import { NETWORKS } from "./lib/psbt/script.js";
import { Rows, showAnalysis, group4, tr, btc, networkName, MUTED, RED, GREEN, AMBER, wide, FONT } from "./lib/psbt/view.js";
import { checkShare, recover, normalizeShare, Codex32Error } from "./lib/codex32.js";
import { codex32Message } from "./lib/codex32messages.js";
import * as M from "./lib/text.js";   // Messages: English for the log, translated on screen (tr)
import { Bip39Error } from "./lib/bip39.js";
import { KeyError } from "./lib/keys.js";
import { combine, CombineError } from "./lib/combine.js";
import { CodeReader, seriesFor, sizeProblem } from "./lib/codes.js";
import { applyPlan, flagSignatures } from "./lib/review.js";
import * as wallet from "./lib/wallet.js";

setHashes({ sha256: crypto.sha256, ripemd160: crypto.ripemd160 });

const MAX_SHARES = 9;
const MAX_KEYS = 8;
const PART_MS = 500;  // each code of a series on screen (core tunes it: B2)
const ACCEPT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
const NETWORK_ORDER = ["mainnet", "testnet", "regtest"];
const EXPORT_FORMS = [{ id: "descriptor", name: t("Descriptor"), field: "descriptor" },
  { id: "extended key", name: t("zpub/xpub"), field: "text" }];

// "3 inputs": for the log, which stays in English
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// An error from the libraries, in the person's language
const errorText = (e) => (e && e.text !== undefined ? tr(e.text) : String(e && e.message ? e.message : e));

// lib/bip39.js's errors (English there), from their code: never the word
function bip39Message(e) {
  switch (e.code) {
    case "count": return t("A seed phrase has 12, 15, 18, 21 or 24 words, not {n}.", { n: e.count });
    case "word": return t("Word {n} is not in the BIP-39 word list.", { n: e.word });
    case "checksum": return t("The checksum is wrong: a word is mistyped, or the order is wrong.");
    default: return e.message;
  }
}

const state = {
  page: null,
  // what is being typed (kept here only, never in gk:session)
  texts: [""],        // the shares
  meaning: "bip39",   // what the shares hold: "bip39" (dice39) or "bip32" (BIP-93)
  words: "",
  privateText: "",
  passphrase: "",
  error: null,
  keyNote: null,      // said once on the keys' page
  keys: [],           // wallet.load...()'s results
  after: "review",    // what the keys are being loaded for: "review", "export"
  loaded: null,       // { kind, encoding, chars, size, copies, notes (from merging), psbt | tx }
  merging: false,     // the scanner is reading another copy
  network: null,      // chosen by the person; null: as guessed
  lastNetwork: null,  // of the last transaction shown: for a signed one, which says nothing
  signed: null,       // { psbt bytes, tx bytes | null, count, series: show BBQr }
  exportForm: 0,      // index into EXPORT_FORMS
  exportType: 0,      // index into wallet.EXPORTS
  exportNetwork: "mainnet",
  account: 0,         // the account number exported; its PSBTs are signed too
  selftest: null,     // { passed, failed: [] }
};
let page = {};
let busy = false;

// --- helpers ------------------------------------------------------------------

// A field that shows a secret: emptied before its page goes. (Both heaps
// wipe what they free; this keeps the text from lasting until then.)
function secret(field) {
  page.secrets = page.secrets || [];
  page.secrets.push(field);
  return field;
}

function emptySecrets() {
  for (const f of page.secrets || []) {
    if (!f.alive) continue;
    f.onChange = null; // what state holds may be wanted back (a scanner's page and return)
    f.onBlur = null;
    f.text = "";
  }
  page.secrets = [];
}

function newPage(name, title) {
  emptySecrets();
  stopParts();
  state.page = name;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [20, 32] : [10, 12], gap: wide ? 12 : 6, scrollable: true });
  page = { name, rows: new Rows() };
  const head = new ui.Container({ layout: "row", alignItems: "end", gap: 12, width: "100%" });
  new ui.Label(head, { text: title, font: FONT.title, grow: 1 });
  if (state.keys.length) {
    new ui.Label(head, { text: ui.symbols.ok + " " + plural(state.keys.length, "{n} key", "{n} keys"), font: FONT.small,
      color: GREEN });
  }
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

// No key goes in until the self-test has passed.
function gate(button) {
  button.disabled = !selftestOk();
  if (!selftestOk()) paragraph(ui.screen, state.selftest ? t("The self-test failed: no key can be loaded.")
    : t("Waiting for the self-test."), { color: RED });
}

// --- home -----------------------------------------------------------------------

function showHome() {
  newPage("home", ui.symbols.ok + " " + t("Signer"));
  paragraph(ui.screen, t("Shows what a Bitcoin transaction does, then signs it. First show it the transaction, " +
    "as a QR code: you see what it does before any key is in memory. Then load the keys."));
  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: ui.symbols.image + " " + t("Scan a transaction"), onClick: () => showScan(false) });
  if (state.loaded) new ui.Button(buttons, { text: ui.symbols.list + " " + t("Last transaction"), onClick: showReview });
  new ui.Button(buttons, { text: ui.symbols.upload + " " + t("Public key"), onClick: askExport });
  if (state.keys.length) new ui.Button(buttons, { text: ui.symbols.trash + " " + t("Forget the keys"), onClick: forgetKeys });
  new ui.Button(buttons, { text: ui.symbols.home + " " + t("Leave"), onClick: () => sys.exit() });

  if (state.keys.length) {
    paragraph(ui.screen, plural(state.keys.length, "{n} key in memory.", "{n} keys in memory."), { color: GREEN });
  }
  paragraph(ui.screen, t("Setting up Electrum (once): show it the public key (\"Public key\", its zpub), as a new " +
    "wallet: Standard wallet, Use a master key, then scan the QR code. Electrum then makes transactions that " +
    "this device signs. Each time: in Electrum, make the transaction, then Export (or Share), Show as QR code; " +
    "here, Scan a transaction; after signing, in Electrum: Tools, Load transaction, From QR code."), { color: MUTED });
  page.selftest = paragraph(ui.screen, "", { font: FONT.small });
  showSelftest();
  first.focus();
}

function showSelftest() {
  if (!page.selftest) return;
  const st = state.selftest;
  if (!st) page.selftest.set({ text: t("Self-test running..."), color: MUTED });
  else if (!st.failed.length) {
    page.selftest.set({ text: ui.symbols.ok + " " + t("Self-test passed ({n} checks: BIP-39, BIP-32, signatures, " +
      "against the BIPs' test vectors).", { n: st.passed }), color: GREEN });
  } else {
    page.selftest.set({ text: ui.symbols.close + " " + t("Self-test FAILED: do not sign with this device.") + "\n" +
      st.failed.join("\n"), color: RED });
  }
}

function forgetKeys() {
  for (const k of state.keys) wallet.wipeKey(k);
  state.keys = [];
  state.signed = null;
  wipeEntries();
  console.log("signer: keys forgotten");
  showHome();
}

function wipeEntries() {
  state.texts = [""];
  state.words = "";
  state.privateText = "";
  state.passphrase = "";
  state.error = null;
  sys.gc();
}

// --- the keys ------------------------------------------------------------------

function addKey(key, how) {
  state.keyNote = null;
  if (state.keys.some((k) => k.fingerprint === key.fingerprint)) {
    wallet.wipeKey(key);
    state.keyNote = t("That key is loaded already.");
    console.log("signer: that key is loaded already");
  } else if (state.keys.length >= MAX_KEYS) {
    wallet.wipeKey(key);
    console.log("signer: too many keys");
    return showError(t("At most {max} keys at a time.", { max: MAX_KEYS }));
  } else {
    state.keys.push(key);
    console.log(`signer: key loaded (${how})`);
  }
  state.signed = null;
  wipeEntries();
  if (state.after === "export" && state.keys.some((k) => k.master)) showExport();
  else showKeys();
}

// Which key page, for a key that is needed.
function askKeys(after) {
  state.after = after;
  showKeys();
}

function askExport() {
  if (state.keys.some((k) => k.master)) showExport();
  else askKeys("export");
}

const signOptions = (network) => ({ network, accounts: wallet.accountsFor(state.account) });

function coverage() {
  const l = state.loaded;
  if (!l || l.kind !== "psbt" || !state.keys.length) return null;
  const plan = wallet.plan(l.psbt, state.keys, signOptions(state.network ?? state.lastNetwork));
  return { plan, total: l.psbt.inputs.length };
}

function showKeys() {
  wipeEntries();
  newPage("keys", ui.symbols.plus + " " + t("Keys"));
  const c = coverage();
  if (state.keyNote) paragraph(ui.screen, state.keyNote, { color: AMBER });
  state.keyNote = null;
  if (!state.keys.length) {
    paragraph(ui.screen, state.after === "export"
      ? t("The public key comes from a master key: codex32 shares, seed words or a master xprv.")
      : t("Load the keys that sign this transaction. They stay in this app's memory only, and are forgotten " +
        "after signing, unless you keep them for the next one."), { color: MUTED });
  }
  state.keys.forEach((k, i) => {
    const what = c ? plural(c.total, "Key {fingerprint}: signs {signs} of {n} input.",
      "Key {fingerprint}: signs {signs} of {n} inputs.", { fingerprint: k.fingerprint, signs: c.plan.keys[i].signs })
      : t("Key {fingerprint}.", { fingerprint: k.fingerprint });
    paragraph(ui.screen, ui.symbols.ok + " " + what, { font: FONT.big, color: GREEN });
    paragraph(ui.screen, t("From {source}.", { source: tr(k.description) }));
    if (k.master) {
      const acct = wallet.exportKey(k, "p2wpkh", "mainnet");
      paragraph(ui.screen, t("Native segwit account {path}: fingerprint {fingerprint}.",
        { path: acct.path, fingerprint: acct.fingerprint }));
    }
  });
  if (state.keys.length) {
    paragraph(ui.screen, t("Check a fingerprint against what you know of this wallet: a wallet made from the seed " +
      "phrase shows the master fingerprint; Electrum's watch-only wallet, made from the public key this device " +
      "exports, shows the account's (Wallet, Information). A different one means another passphrase, " +
      "other shares, or the other choice of what the shares hold."), { color: MUTED });
  }
  const buttons = buttonRow(ui.screen);
  let first = null;
  if (state.keys.length && state.loaded) {
    first = new ui.Button(buttons, { text: ui.symbols.list + " " + t("Back to the transaction"), onClick: showReview });
  }
  const shares = new ui.Button(buttons, { text: ui.symbols.plus + " " + t("Codex32 shares"), onClick: () => showShares(0) });
  new ui.Button(buttons, { text: ui.symbols.plus + " " + t("Seed words"), onClick: showWords });
  new ui.Button(buttons, { text: ui.symbols.plus + " " + t("xprv or WIF"), onClick: showPrivate });
  if (state.keys.length) new ui.Button(buttons, { text: ui.symbols.trash + " " + t("Forget the keys"), onClick: forgetKeys });
  new ui.Button(buttons, { text: ui.symbols.left + " " + t("Back"), onClick: () => (state.loaded ? showReview() : showHome()) });
  (first || shares).focus();
}

// The BIP-39 passphrase, for the shares' page and the words' page.
function passphraseRow(submit) {
  const row = new ui.Container({ layout: "column", gap: 4, width: "100%" });
  paragraph(row, t("BIP-39 passphrase (leave empty if none). A different passphrase is a different wallet: " +
    "check the fingerprint shown next."), { color: MUTED });
  const pass = page.pass = secret(new ui.TextArea(row, { oneLine: true, password: true, width: "100%", text: state.passphrase,
    maxLength: 256, placeholder: t("no passphrase"), font: FONT.text }));
  pass.onChange = (ev) => (state.passphrase = ev.value);
  pass.onSubmit = submit;
  new ui.Checkbox(row, { text: t("Show the passphrase"), onChange: (ev) => (pass.password = !ev.value) });
  return row;
}

function showError(msg) {
  state.error = msg;
  if (page.error) page.error.set({ text: msg || "", hidden: !msg });
}

// --- seed words -----------------------------------------------------------------

const countWords = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function showWords() {
  newPage("words", ui.symbols.plus + " " + t("Seed words"));
  paragraph(ui.screen, t("Type the BIP-39 words, separated by spaces, or scan them as text."), { color: MUTED });
  const area = secret(new ui.TextArea({ width: "100%", height: wide ? 130 : 90, maxLength: 400, text: state.words, font: FONT.text,
    accept: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ \n", placeholder: "abandon ability able ..." }));
  const wordCount = (text) => plural(countWords(text), "{n} word", "{n} words");
  page.count = paragraph(ui.screen, wordCount(state.words), { font: FONT.small, color: MUTED });
  area.onChange = (ev) => {
    state.words = ev.value;
    page.count.text = wordCount(ev.value);
    showError(null);
  };
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });
  passphraseRow(loadWords);
  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " " + t("Load the key"), onClick: loadWords });
  new ui.Button(buttons, { text: ui.symbols.image + " " + t("Scan"), onClick: () => showKeyScan("words") });
  new ui.Button(buttons, { text: ui.symbols.left + " " + t("Back"), onClick: showKeys });
  gate(page.load);
  showError(state.error);
  area.focus();
}

function loadWords() {
  if (busy || state.page !== "words" || !selftestOk()) return;
  busy = true;
  let key;
  try {
    key = wallet.loadWords(state.words, state.passphrase);
  } catch (e) {
    if (!(e instanceof Bip39Error)) throw e;
    console.log("signer: words refused");
    return showError(bip39Message(e));
  } finally {
    busy = false;
  }
  addKey(key, "seed words");
}

// --- xprv or WIF ----------------------------------------------------------------

function showPrivate() {
  newPage("private", ui.symbols.plus + " " + t("xprv or WIF"));
  paragraph(ui.screen, t("Type or scan a private key: an extended one (xprv, or its zprv and yprv forms), or a " +
    "single key (WIF). A master key signs anything of its wallet, an account's key what is below it, and a " +
    "single key its own coins."), { color: MUTED });
  const field = secret(new ui.TextArea({ oneLine: true, password: true, width: "100%", maxLength: 160, text: state.privateText,
    font: FONT.text, accept: ACCEPT, placeholder: t("xprv... or a WIF key") }));
  field.onChange = (ev) => {
    state.privateText = ev.value;
    showError(null);
  };
  field.onSubmit = loadPrivate;
  new ui.Checkbox({ text: t("Show the key"), onChange: (ev) => (field.password = !ev.value) });
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });
  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " " + t("Load the key"), onClick: loadPrivate });
  new ui.Button(buttons, { text: ui.symbols.image + " " + t("Scan"), onClick: () => showKeyScan("private") });
  new ui.Button(buttons, { text: ui.symbols.left + " " + t("Back"), onClick: showKeys });
  gate(page.load);
  showError(state.error);
  field.focus();
}

function loadPrivate() {
  if (busy || state.page !== "private" || !selftestOk()) return;
  let key;
  try {
    key = wallet.loadPrivate(state.privateText);
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    console.log("signer: private key refused");
    return showError(errorText(e));
  }
  addKey(key, key.kind);
}

// A key as a QR code of plain text, into the page that asked.
function showKeyScan(what) {
  const back = () => (what === "words" ? showWords() : showPrivate());
  newPage("keyscan", ui.symbols.image + " " + t("Scan the key"));
  page.back = back;
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 8, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 480 : 280, height: wide ? 360 : 210,
    onDetect: ({ text }) => {
      if (state.page !== "keyscan") return;
      if (text === null) return say(t("That code doesn't hold text."), RED);
      console.log("signer: scanned a key");
      page.scanner.stop();
      if (what === "words") state.words = text;
      else state.privateText = text.trim();
      back();
    },
    onError: ({ reason }) => say(t("The camera stopped: {reason}.", { reason }), RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, t("Show the QR code."), { color: MUTED });
  new ui.Button(side, { text: ui.symbols.left + " " + t("Back"), onClick: back }).focus();
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
  newPage("shares", ui.symbols.plus + " " + t("Codex32 shares"));
  paragraph(ui.screen, t("Type the codex32 shares (spaces don't matter), or scan them. As many as the threshold: " +
    "the fourth character of each share."), { color: MUTED });
  page.boxes = new ui.Container({ layout: "column", gap: 4, width: "100%" });
  page.fields = [];
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });

  // what the shares hold
  new ui.Label({ text: t("The shares hold"), font: FONT.big, color: MUTED });
  const meaning = new ui.Dropdown({
    width: "100%",
    options: [t("A seed phrase's entropy, as dice39 makes them (BIP-39: 12 or 24 words)"),
      t("A BIP-32 master seed, as BIP-93 says")],
    selected: state.meaning === "bip39" ? 0 : 1,
    onChange: (ev) => {
      state.meaning = ev.value === 0 ? "bip39" : "bip32";
      page.passRow.hidden = state.meaning !== "bip39";
    },
  });
  page.passRow = passphraseRow(() => loadShares());
  page.passRow.hidden = state.meaning !== "bip39";

  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " " + t("Load the key"), onClick: loadShares });
  new ui.Button(buttons, { text: ui.symbols.image + " " + t("Scan shares"), onClick: showShareScan });
  new ui.Button(buttons, { text: ui.symbols.trash + " " + t("Clear"), onClick: clearShares });
  new ui.Button(buttons, { text: ui.symbols.left + " " + t("Back"), onClick: showKeys });
  gate(page.load);

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
  const ta = secret(new ui.TextArea(line, { oneLine: true, grow: 1, maxLength: 160, accept: ACCEPT, text: state.texts[i] || "",
    placeholder: i === 0 ? "ms1..." : "", font: wide ? 20 : 16, mono: true }));
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
    else loadShares();
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
    const what = s.isSecret
      ? t("the secret itself, identifier {id}, {bytes}-byte seed", { id: s.id.toUpperCase(), bytes: s.seedBytes })
      : t("share {index}, identifier {id}, threshold {k}, {bytes}-byte seed",
        { index: s.index.toUpperCase(), id: s.id.toUpperCase(), k: s.thresholdChar, bytes: s.seedBytes });
    return f.note.set({ text: ui.symbols.ok + " " + what, color: GREEN, hidden: false });
  }
  const e = r.error;
  const soft = e.code === "length" || e.code === "checksum" || (e.code === "prefix" && e.partial);
  if (soft && !f.committed) {
    const n = normalizeShare(text).length;
    return f.note.set({ text: plural(n, "{n} character", "{n} characters"), color: MUTED, hidden: false });
  }
  f.note.set({ text: ui.symbols.close + " " + codex32Message(e), color: RED, hidden: false });
}

function clearShares() {
  state.texts = [""];
  state.passphrase = "";
  state.error = null;
  sys.gc();
  console.log("signer: shares cleared");
  showShares(0);
}

// Recombines the shares, then derives the master key (PBKDF2 for a seed
// phrase: about 0.1 s on a Pi Zero).
function loadShares() {
  if (busy || state.page !== "shares" || !selftestOk()) return;
  const texts = state.texts.filter((t) => normalizeShare(t));
  if (!texts.length) return showError(t("Type or scan the shares first."));
  let res;
  try {
    res = recover(texts);
  } catch (e) {
    if (!(e instanceof Codex32Error)) throw e;
    console.log(`signer: shares refused: ${e.code}`);
    page.fields.forEach((f, i) => { f.committed = !!normalizeShare(state.texts[i]); updateNote(i); });
    return showError(codex32Message(e));
  }
  busy = true;
  let key;
  try {
    key = wallet.loadKey(res.seed, { meaning: state.meaning, passphrase: state.passphrase });
  } catch (e) {
    console.log(`signer: key refused: ${e.name}`);
    return showError(e instanceof Bip39Error ? bip39Message(e) : errorText(e));
  } finally {
    res.seed.fill(0);
    busy = false;
  }
  addKey(key, `${state.meaning}, ${count(texts.length, "share")}`);
}

// --- scanning shares ------------------------------------------------------------

function showShareScan() {
  newPage("sharescan", ui.symbols.image + " " + t("Scan shares"));
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 8, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 480 : 280, height: wide ? 360 : 210,
    onDetect: ({ text }) => scannedShare(text),
    onError: ({ reason }) => say(t("The camera stopped: {reason}.", { reason }), RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, t("Show the shares' QR codes, one at a time."), { color: MUTED });
  new ui.Button(side, { text: ui.symbols.left + " " + t("Done"), onClick: () => showShares(firstEmpty()) }).focus();
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
    return say(t("That is not a codex32 share."), RED);
  }
  const s = r.share;
  const have = state.texts.map((t) => checkShare(t)).filter((x) => x.ok).map((x) => x.share);
  if (have.length && (have[0].id !== s.id || have[0].threshold !== s.threshold)) {
    return say(t("That share is from another split (identifier {id}).", { id: s.id.toUpperCase() }), RED);
  }
  if (have.some((o) => o.index === s.index)) {
    return say(t("Share {index} is in already.", { index: s.index.toUpperCase() }), AMBER);
  }
  let slot = state.texts.findIndex((t) => !normalizeShare(t));
  if (slot < 0) slot = state.texts.length;
  if (slot >= MAX_SHARES) return say(t("No room for more shares."), RED);
  state.texts[slot] = s.string;
  const k = s.threshold === 0 ? 1 : s.threshold, n = have.length + 1;
  console.log(`signer: scanned share ${n} of ${k}`);
  if (n >= k) {
    page.scanner.stop();
    showShares("load");
    return;
  }
  say(t("Share {index} added: {have} of {need}. Next one.", { index: s.index.toUpperCase(), have: n, need: k }), GREEN);
}

// --- the public key ------------------------------------------------------------

function showExport() {
  const key = state.keys.find((k) => k.master);
  if (!key) return showHome();
  newPage("export", ui.symbols.upload + " " + t("Public key"));
  page.key = key;
  paragraph(ui.screen, t("Show this once to the wallet that will make the transactions this device signs: a " +
    "descriptor for a wallet that takes them; the zpub for Electrum (File, New/Restore, Standard wallet, Use a " +
    "master key, then the camera button)."), { color: MUTED });
  const opts = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  new ui.Dropdown(opts, {
    options: EXPORT_FORMS.map((x) => x.name), selected: state.exportForm,
    onChange: (ev) => { state.exportForm = ev.value; drawExport(); },
  });
  new ui.Dropdown(opts, {
    grow: 1,
    options: wallet.EXPORTS.map((x) => tr(x.name)), selected: state.exportType,
    onChange: (ev) => { state.exportType = ev.value; drawExport(); },
  });
  new ui.Dropdown(opts, {
    options: NETWORK_ORDER.map(networkName), selected: NETWORK_ORDER.indexOf(state.exportNetwork),
    onChange: (ev) => { state.exportNetwork = NETWORK_ORDER[ev.value]; drawExport(); },
  });
  const row = new ui.Container({ layout: "row", alignItems: "center", gap: 8, width: "100%" });
  new ui.Label(row, { text: t("Account"), font: FONT.text });
  const account = new ui.TextArea(row, { oneLine: true, width: 140, maxLength: 10, accept: "0123456789", text: String(state.account), font: FONT.text });
  account.onChange = (ev) => {
    const n = ev.value === "" ? null : Number(ev.value);
    page.account = n !== null && n <= wallet.MAX_ACCOUNT ? n : null;
    if (page.account !== null) state.account = page.account;
    drawExport();
  };
  new ui.Label(row, { text: t("This device signs for the account shown here."), font: FONT.small, color: MUTED, grow: 1, overflow: "wrap" });
  page.account = state.account;
  page.out = new ui.Container({ layout: "column", gap: 6, width: "100%", alignItems: "center" });
  const back = new ui.Button({ text: ui.symbols.left + " " + t("Back"), onClick: showHome });
  drawExport();
  back.focus();
}

function drawExport() {
  page.out.clear();
  if (page.account === null) {
    new ui.Label(page.out, { text: t("An account number is 0 to {max}.", { max: wallet.MAX_ACCOUNT }), font: FONT.text, color: RED });
    return;
  }
  const x = wallet.exportKey(page.key, wallet.EXPORTS[state.exportType].id, state.exportNetwork, page.account);
  const form = EXPORT_FORMS[state.exportForm];
  const text = x[form.field];
  const size = Math.min(ui.height - 200, ui.width - 64, 420);
  new ui.QRCode(page.out, { data: text, size, ecc: "M" });
  new ui.Label(page.out, { text: t("Account {path}, fingerprint {accountFingerprint}; master fingerprint {masterFingerprint}",
    { path: x.path, accountFingerprint: x.fingerprint, masterFingerprint: x.master }), font: FONT.text,
    width: "100%", overflow: "wrap", textAlign: "center" });
  new ui.Label(page.out, { text, font: FONT.small, width: "100%", overflow: "wrap", textAlign: "center" });
  const note = wallet.EXPORTS[state.exportType].note;
  if (note && form.id !== "descriptor") new ui.Label(page.out, { text: tr(note), font: FONT.text, color: AMBER, width: "100%", overflow: "wrap", textAlign: "center" });
  console.log(`signer: showing the ${wallet.EXPORTS[state.exportType].id} public key (${state.exportNetwork}), ` +
    `account ${page.account}, ${form.id}, ${text.length} characters`);
}

// --- scanning a transaction -------------------------------------------------------

function showScan(merging) {
  state.merging = merging;
  newPage("scan", ui.symbols.image + " " + (merging ? t("Scan another copy") : t("Scan a transaction")));
  page.reader = new CodeReader();
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 6, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 560 : 280, height: wide ? 420 : 210,
    onDetect: ({ text, bytes }) => scannedTx(text, bytes),
    onError: ({ reason }) => say(t("The camera stopped: {reason}.", { reason }), RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, merging
    ? t("Show a copy of the same transaction, with other signatures: it is merged into this one.")
    : t("Show the transaction's QR code (Electrum: Export, Show as QR code), or a wallet's animated BBQr codes. " +
      "Large ones need a steady hand and good light."));
  const buttons = buttonRow(side);
  new ui.Button(buttons, { text: ui.symbols.left + " " + t("Back"), onClick: () => (state.loaded ? showReview() : showHome()) }).focus();
  page.again = new ui.Button(buttons, { text: ui.symbols.refresh + " " + t("Start over"), hidden: true, onClick: () => {
    page.reader.reset();
    page.again.hidden = true;
    say(t("Show the first code of the series."), MUTED);
  } });
}

// text: a Message or English; the log gets the English
function refuse(text) {
  console.log(`signer: refused a code: ${text}`);
  say(ui.symbols.warning + " " + tr(text), RED);
}

function scannedTx(text, bytes) {
  if (state.page !== "scan") return;
  let r, loaded;
  try {
    const got = page.reader.read(text, bytes);
    page.again.hidden = !page.reader.started;
    if (got.part) {
      if (got.part.added) {
        console.log(`signer: BBQr part: ${got.part.have} of ${got.part.total}`);
        say(t("{have} of {total} parts read. Keep it in view.", { have: got.part.have, total: got.part.total }), GREEN);
      }
      return;
    }
    r = got.payload;
    loaded = { kind: r.kind, encoding: r.encoding, chars: r.chars, size: r.bytes.length, copies: 1, notes: [] };
    if (r.kind === "psbt") loaded.psbt = parsePsbt(r.bytes);
    else loaded.tx = parseTx(r.bytes);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    // the libraries' own sentences, or the decoder's English, which says what is wrong with the bytes
    if (e.text !== undefined && typeof e.text !== "string") return refuse(e.text);
    const why = e.message.endsWith(".") ? e.message : e.message + ".";
    return refuse(/^(This|The code|That|These)/.test(why) ? why
      : M.t("Not a transaction Electrum would load: {why}", { why }));
  }
  const big = sizeProblem(loaded.psbt ? loaded.psbt.tx : loaded.tx);
  if (big) return refuse(big);
  if (state.merging) {
    if (r.kind !== "psbt") return refuse(M.t("That is a finished transaction: there is nothing to merge."));
    let m;
    try {
      m = combine(state.loaded.psbt, loaded.psbt);
    } catch (e) {
      if (!(e instanceof CombineError)) throw e;
      return refuse(e.text);
    }
    state.loaded.psbt = m.psbt;
    state.loaded.copies++;
    state.loaded.notes.push(...m.notes);
    state.signed = null;
    console.log(`signer: merged a copy (${r.encoding}, ${count(m.added, "new field")})`);
  } else {
    console.log(`signer: read a ${r.kind === "psbt" ? "PSBT" : "finished transaction"} (${loaded.encoding}, ` +
      `${loaded.chars} characters, ${loaded.size} bytes)`);
    state.loaded = loaded;
    state.network = null;
    state.signed = null;
  }
  page.scanner.stop();
  showReview();
}

// --- review and sign ------------------------------------------------------------------

function networkButton(parent, a) {
  new ui.Button(parent, {
    text: t("Network: {network}", { network: networkName(a.network) }),
    onClick: () => {
      state.network = NETWORK_ORDER[(NETWORK_ORDER.indexOf(a.network) + 1) % NETWORK_ORDER.length];
      showReview();
    },
  });
}

// A transaction is not secret; warnings are cut short, as they can name
// wallets' fingerprints.
function logTotals(a) {
  console.log(`signer: totals: sent ${a.sent ?? "?"} sat, change ${a.toSelf ?? "?"} sat, fee ${a.fee ?? "?"} sat, ` +
    `${a.vsize ?? "?"} vB, ${a.network}`);
  for (const w of a.warnings) console.log(`signer: ${w.level}: ${w.text.slice(0, 48)}`);
}

function reviewList() {
  return new ui.Container({ layout: "column", gap: wide ? 8 : 5, width: "100%", grow: 1, scrollable: true });
}

function showFinished() {
  const l = state.loaded;
  const inherited = !state.network && state.lastNetwork !== null;
  const a = analyzeTx(l.tx, { network: state.network ?? state.lastNetwork });
  state.lastNetwork = a.network;
  newPage("review", t("Finished transaction"));
  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: ui.symbols.image + " " + t("Scan another"), onClick: () => showScan(false) });
  networkButton(buttons, a);
  new ui.Button(buttons, { text: ui.symbols.home + " " + t("Home"), onClick: showHome });
  paragraph(ui.screen, t("It is signed already: there is nothing to sign here."), { color: MUTED });
  // to compare with what the wallet or a block explorer shows
  const txid = txidOf(l.tx);
  // only the ID in mono: 0/O and 1/l/I apart
  paragraph(ui.screen, tm("Transaction ID: <tt>{txid}</tt>", { txid: group4(txid) }), { font: FONT.small, markup: true });
  showAnalysis(reviewList(), page.rows, a, l, {
    networkNote: state.network ? t("chosen", { $context: "network" })
      : inherited ? t("as the transaction before: a signed one doesn't say") : null,
  });
  first.focus();
  console.log(`signer: finished transaction: ${count(a.inputs.length, "input")}, ${count(a.outputs.length, "output")}, ` +
    `${a.network}, ${count(a.warnings.length, "warning")}`);
  console.log(`signer: txid: ${txid}`);
  logTotals(a);
}

// A key for another network than the transaction's is worth a word: its
// coins and addresses are not the ones shown.
function keyNetworkWarnings(a) {
  const test = a.network !== "mainnet";
  for (const k of state.keys) {
    if (k.network && (k.network === "test") !== test) {
      a.warnings.push({ level: "warn", text: k.network === "test"
        ? M.t("Key {fingerprint} is a test network key, and this transaction looks like {network}.",
          { fingerprint: k.fingerprint, network: M.t(NETWORKS[a.network].name) })
        : M.t("Key {fingerprint} is a mainnet key, and this transaction looks like {network}.",
          { fingerprint: k.fingerprint, network: M.t(NETWORKS[a.network].name) }) });
    }
  }
}

// The network decides the addresses shown. What the PSBT says of it (its
// paths' coin types, its xpubs' versions) is the computer's word, and a
// mainnet transaction shown as a test one looks harmless. So: the person's
// choice; else their own keys' (an xprv's or WIF's version; mainnet wins);
// else the PSBT's guess, and when that isn't mainnet, a warning says so.
// (Seed words and codex32 shares don't say.) -> { network, note, guessed }
function reviewNetwork(psbt) {
  if (state.network) return { network: state.network, note: t("chosen", { $context: "network" }) };
  const said = new Set(state.keys.map((k) => k.network).filter(Boolean));
  if (said.has("mainnet")) return { network: "mainnet", note: t("as your keys say") };
  if (said.has("test")) return { network: "testnet", note: t("as your keys say") };
  const guess = guessNetwork(psbt);
  return { network: guess.network, note: null, guessed: guess.network !== "mainnet" ? guess : null };
}

function showReview() {
  const l = state.loaded;
  if (!l) return showHome();
  if (l.kind === "tx") return showFinished();
  const net = reviewNetwork(l.psbt);
  const a = analyze(l.psbt, { network: net.network });
  state.lastNetwork = a.network;
  const haveKeys = state.keys.length > 0;
  const plan = wallet.plan(l.psbt, state.keys, signOptions(a.network));
  if (haveKeys) applyPlan(a, plan);
  else flagSignatures(a, plan);
  keyNetworkWarnings(a);
  if (net.guessed) {
    a.warnings.unshift({ level: "warn", text: M.t("The network, {network}, is only the PSBT's guess ({why}). If these " +
      "are real bitcoin, choose Mainnet (the Network button): only then are the addresses shown the real ones.",
    { network: M.t(NETWORKS[a.network].name), why: net.guessed.why }) });
  }
  a.warnings.unshift(...l.notes);

  newPage("review", t("Transaction to sign"));
  const buttons = buttonRow(ui.screen);
  const signable = plan.signable;
  let first;
  if (plan.complete && signable === 0) {
    first = new ui.Button(buttons, { text: ui.symbols.ok + " " + t("Finish the transaction"), onClick: () => sign(a) });
  } else if (!haveKeys) {
    first = new ui.Button(buttons, { text: ui.symbols.plus + " " + t("Load the keys to sign"), onClick: () => askKeys("review") });
  } else {
    first = new ui.Button(buttons, { text: ui.symbols.edit + " " + plural(signable, "Sign {n} input", "Sign {n} inputs"),
      onClick: () => sign(a) });
    first.disabled = signable === 0;
  }
  if (haveKeys && !first.disabled) first.disabled = !selftestOk();
  if (haveKeys) new ui.Button(buttons, { text: ui.symbols.plus + " " + t("Keys"), onClick: () => askKeys("review") });
  new ui.Button(buttons, { text: ui.symbols.copy + " " + t("Merge a copy"), onClick: () => showScan(true) });
  new ui.Button(buttons, { text: ui.symbols.image + " " + t("Scan another"), onClick: () => showScan(false) });
  networkButton(buttons, a);
  new ui.Button(buttons, { text: ui.symbols.home + " " + t("Home"), onClick: showHome });

  if (l.copies > 1) paragraph(ui.screen, t("Merged from {copies} copies.", { copies: l.copies }), { color: MUTED });
  if (haveKeys) {
    const each = state.keys.map((k, i) => t("key {fingerprint} signs {signs}", { fingerprint: k.fingerprint,
      signs: plan.keys[i].signs })).join(", ");
    paragraph(ui.screen, plural(a.inputs.length, "{n} input: {keys}.", "{n} inputs: {keys}.", { keys: each }),
      { color: plan.signable ? GREEN : RED });
    if (plan.signable && !plan.complete) {
      paragraph(ui.screen, t("Not every input can be signed here: the result is a PSBT that needs more signatures."),
        { color: AMBER });
    }
  } else if (!plan.complete) {
    paragraph(ui.screen, t("Check it. Change is only the transaction's claim until the keys are in."), { color: MUTED });
  }

  showAnalysis(reviewList(), page.rows, a, l, {
    networkNote: net.note,
    changeClaimed: !haveKeys,
    inputNote: (i) => {
      const p = plan.inputs[i.index];
      if (p.sign) {
        const sigs = p.multisig ? { have: p.multisig.have + p.multisig.will, need: p.multisig.m } : null;
        const text = !sigs ? (p.path ? t("Will be signed ({path})", { path: p.path }) : t("Will be signed"))
          : p.path ? t("Will be signed ({path}), {have} of {need} signatures", { path: p.path, ...sigs })
            : t("Will be signed, {have} of {need} signatures", sigs);
        return { text: ui.symbols.edit + " " + text, color: GREEN };
      }
      if (p.signed || p.final) return { text: ui.symbols.ok + " " + t("Signed already"), color: GREEN };
      if (p.multisig && !haveKeys) {
        return { text: t("{have} of {need} signatures", { have: p.multisig.have, need: p.multisig.m }), color: AMBER };
      }
      return haveKeys ? { text: ui.symbols.close + " " + t("Not signed: {reason}", { reason: tr(p.reason) }), color: AMBER }
        : null;
    },
  });
  first.focus();
  console.log(`signer: review: ${count(a.inputs.length, "input")}, ${signable} to sign, ${count(a.outputs.length, "output")}, ` +
    `fee ${a.fee ?? "?"} sat, ${a.network}, ${count(a.warnings.length, "warning")}`);
  logTotals(a);
  const several = plan.inputs.filter((i) => i.multisig);
  if (several.length) console.log(`signer: multisig: ${several.map((i) => `${i.multisig.have}+${i.multisig.will}/${i.multisig.m}`).join(" ")}`);
  const of = (test) => a.outputs.filter(test).length;
  console.log(`signer: change: ${haveKeys ? 0 : of((o) => o.mine)} claimed, ${haveKeys ? of((o) => o.mine) : 0} checked, ` +
    `${of((o) => o.stray !== undefined)} stray, ${of((o) => o.unverified)} unverified, ` +
    `${haveKeys ? plan.outputs.filter((o) => o.problem).length : 0} refuted, ${of((o) => o.far)} far`);
}

async function sign(a) {
  if (busy || !selftestOk()) return;
  if (a.warnings.some((w) => w.level === "danger")) {
    const answer = await ui.alert(t("There are serious warnings (in red) about this transaction. Sign it anyway?"),
      { title: t("Sign?"), buttons: [t("Don't sign"), t("Sign anyway")] });
    console.log(`signer: red warnings: ${answer === 1 ? "signing anyway" : "not signed"}`);
    if (answer !== 1) return;
  }
  busy = true;
  let r;
  try {
    r = wallet.sign(state.loaded.psbt, state.keys, signOptions(a.network));
  } finally {
    busy = false;
  }
  state.signed = r;
  // (a transaction is not secret: its hash lets the tests compare it with Electrum's)
  console.log(`signer: signed ${count(r.count, "input")}` +
    (r.tx ? `, transaction complete (SHA-256 ${toHex(crypto.sha256(r.tx).subarray(0, 8))})` : ""));
  console.log(`signer: txid: ${r.txid || "none yet"}`);
  showSigned(r.tx ? "tx" : "psbt");
}

// --- the signed transaction -----------------------------------------------------------

// The end of a transaction: keys are forgotten unless asked otherwise.
function finish(keep) {
  state.loaded = null;
  state.signed = null;
  state.network = null;
  if (keep) return showScan(false);
  if (state.keys.length) return forgetKeys();
  showHome();
}

function showSigned(form) {
  const s = state.signed;
  newPage("signed", ui.symbols.ok + " " + (s.tx ? t("Signed") : t("Partly signed")));
  const bytes = form === "tx" ? s.tx : s.psbt;
  const text = electrumQrText(bytes);
  const what = form === "tx" ? t("The complete, signed transaction.")
    : s.tx ? t("The PSBT with its signatures.") : t("The PSBT with the signatures so far: it needs more before it can be sent.");
  // the code beside the buttons: a camera must see all of it, unscrolled
  const body = new ui.Container({ layout: "row", gap: 12, width: "100%", alignItems: "start" });
  const left = new ui.Container(body, { layout: "column", gap: 4, alignItems: "center" });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1 });
  const note = paragraph(side, "", { color: MUTED, font: FONT.small });
  // to compare with what the wallet says it broadcast
  if (s.txid) paragraph(side, tm("Transaction ID: <tt>{txid}</tt>", { txid: group4(s.txid) }), { font: FONT.small, markup: true });
  else paragraph(side, t("No transaction ID yet: it isn't final until all its signatures are in."), { color: AMBER, font: FONT.small });
  const buttons = buttonRow(side);
  const done = new ui.Button(buttons, { text: ui.symbols.ok + " " + (state.keys.length ? t("Done, forget the keys") : t("Done")),
    onClick: () => finish(false) });
  if (state.keys.length) {
    new ui.Button(buttons, { text: ui.symbols.right + " " + t("Next transaction (keep keys)"), onClick: () => finish(true) });
  }
  if (s.tx) {
    new ui.Button(buttons, { text: form === "tx" ? t("Show as PSBT") : t("Show the transaction"),
      onClick: () => showSigned(form === "tx" ? "psbt" : "tx") });
  }
  done.focus();
  const size = Math.min(ui.height - (wide ? 110 : 80), ui.width - (wide ? 420 : 310));

  // Electrum reads one code, and no BBQr: that first, when it fits
  let qr = null;
  if (!s.series) {
    for (const ecc of ["M", "L"]) {
      try {
        qr = new ui.QRCode(left, { data: text, size, ecc });
        break;
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
      }
    }
  }
  if (qr) {
    note.text = what + " " + t("In Electrum: Tools, Load transaction, From QR code; check it there, then Broadcast.");
    new ui.Button(buttons, { text: t("Show as BBQr"), onClick: () => { s.series = true; showSigned(form); } });
    new ui.Label(left, { text: t("{bytes} bytes, {chars} characters, {size}x{size}",
      { bytes: bytes.length, chars: text.length, size: qr.modules }), font: FONT.small, color: MUTED });
    console.log(`signer: showing the signed ${form} (${bytes.length} bytes, ${text.length} characters)`);
    return;
  }
  note.text = what + " " + (s.series ? t("Animated BBQr codes, for a wallet that reads them; Electrum doesn't.")
    : t("Animated BBQr codes, for a wallet that reads them; Electrum doesn't, and this is too large for one code."));
  // compressing is JavaScript, and slow on a Zero: a turn of its own, as a
  // handler has 10 s
  setTimeout(() => {
    if (state.page !== "signed" || state.signed !== s) return;
    const t0 = sys.uptime();
    const series = seriesFor(bytes, form);
    const ms = sys.uptime() - t0;
    showParts(left, buttons, series, size);
    if (s.series) new ui.Button(buttons, { text: t("Show as one code"), onClick: () => { s.series = false; showSigned(form); } });
    console.log(`signer: showing the signed ${form} as BBQr (${bytes.length} bytes, ${count(series.parts.length, "part")}, ` +
      `version ${series.version}, encoding ${series.encoding}, SHA-256 ${toHex(crypto.sha256(bytes).subarray(0, 8))}, ${ms.toFixed(0)} ms)`);
  }, 0);
}

let partsTimer = null;

function stopParts() {
  if (partsTimer !== null) clearInterval(partsTimer);
  partsTimer = null;
}

// A BBQr series, each part in turn, all at one version; Pause and Next part
// for a camera that is slow.
function showParts(parent, buttons, series, size) {
  const { parts, version } = series;
  let i = 0;
  const qr = new ui.QRCode(parent, { ecc: "L", version, data: parts[0], size });
  const label = new ui.Label(parent, { text: "", font: FONT.small, color: MUTED });
  const draw = (log) => {
    qr.data = parts[i];
    label.text = t("Part {part} of {parts}, {size}x{size}", { part: i + 1, parts: parts.length, size: qr.modules });
    if (log) console.log(`signer: part ${i + 1} of ${parts.length}, ${qr.modules} modules`);
  };
  const step = () => {
    i = (i + 1) % parts.length;
    draw(false);
  };
  const run = () => (partsTimer = setInterval(step, PART_MS));
  const pause = new ui.Button(buttons, { text: ui.symbols.pause + " " + t("Pause"), onClick: () => {
    if (parts.length < 2) return;
    if (partsTimer !== null) {
      stopParts();
      pause.text = ui.symbols.play + " " + t("Play");
    } else {
      run();
      pause.text = ui.symbols.pause + " " + t("Pause");
    }
  } });
  new ui.Button(buttons, { text: ui.symbols.next + " " + t("Next part"), onClick: () => {
    stopParts();
    pause.text = ui.symbols.play + " " + t("Play");
    i = (i + 1) % parts.length;
    draw(true);
  } });
  draw(true);
  if (parts.length > 1) run();
}

// --- keys ------------------------------------------------------------------------------

ui.onKey((ev) => {
  if (ev.key === "Escape") {
    const p = state.page;
    if (p === "sharescan") showShares(firstEmpty());
    else if (p === "keyscan") page.back();
    else if (p === "scan" || p === "keys") state.loaded ? showReview() : showHome();
    else if (p === "shares" || p === "words" || p === "private") showKeys();
    else if (p === "signed") finish(false);
    else if (p === "export" || p === "review") showHome();
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
