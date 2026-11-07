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
// Never logged: shares, words, the passphrase, the seed, keys, public keys.
// The log goes to the serial port in test builds; it gets counts and sizes
// only. Keys live in this app's memory until they are forgotten or the app
// ends; never in zg:session or on the card.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as crypto from "zg:crypto";
import { setHashes } from "./lib/psbt/hashes.js";
import { DecodeError, toHex } from "./lib/psbt/bytes.js";
import { electrumQrText } from "./lib/psbt/transport.js";
import { parsePsbt } from "./lib/psbt/psbt.js";
import { parseTx } from "./lib/psbt/tx.js";
import { analyze, analyzeTx } from "./lib/psbt/analyze.js";
import { NETWORKS } from "./lib/psbt/script.js";
import { Rows, showAnalysis, MUTED, RED, GREEN, AMBER, wide, FONT, plural } from "./lib/psbt/view.js";
import { checkShare, recover, normalizeShare, Codex32Error } from "./lib/codex32.js";
import { Bip39Error } from "./lib/bip39.js";
import { KeyError } from "./lib/keys.js";
import { combine, CombineError } from "./lib/combine.js";
import { CodeReader } from "./lib/codes.js";
import { applyPlan, flagSignatures } from "./lib/review.js";
import * as wallet from "./lib/wallet.js";

setHashes({ sha256: crypto.sha256, ripemd160: crypto.ripemd160 });

const MAX_SHARES = 9;
const MAX_KEYS = 8;
const ACCEPT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
const NETWORK_ORDER = ["mainnet", "testnet", "regtest"];
const EXPORT_FORMS = [{ id: "descriptor", name: "Descriptor", field: "descriptor" }, { id: "extended key", name: "zpub", field: "text" }];

const state = {
  page: null,
  // what is being typed (kept here only, never in zg:session)
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
  signed: null,       // { psbt bytes, tx bytes | null, count }
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
  state.page = name;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [20, 32] : [10, 12], gap: wide ? 12 : 6, scrollable: true });
  page = { name, rows: new Rows() };
  const head = new ui.Container({ layout: "row", alignItems: "end", gap: 12, width: "100%" });
  new ui.Label(head, { text: title, font: FONT.title, grow: 1 });
  if (state.keys.length) new ui.Label(head, { text: `${ui.symbols.ok} ${plural(state.keys.length, "key")}`, font: FONT.small, color: GREEN });
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
  if (!selftestOk()) paragraph(ui.screen, state.selftest ? "The self-test failed: no key can be loaded."
    : "Waiting for the self-test.", { color: RED });
}

// --- home -----------------------------------------------------------------------

function showHome() {
  newPage("home", ui.symbols.ok + " Signer");
  paragraph(ui.screen, "Shows what a Bitcoin transaction does, then signs it. First show it the transaction, " +
    "as a QR code: you see what it does before any key is in memory. Then load the keys.");
  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: ui.symbols.image + " Scan a transaction", onClick: () => showScan(false) });
  if (state.loaded) new ui.Button(buttons, { text: ui.symbols.list + " Last transaction", onClick: showReview });
  new ui.Button(buttons, { text: ui.symbols.upload + " Public key", onClick: askExport });
  if (state.keys.length) new ui.Button(buttons, { text: ui.symbols.trash + " Forget the keys", onClick: forgetKeys });
  new ui.Button(buttons, { text: ui.symbols.home + " Leave", onClick: () => sys.exit() });

  if (state.keys.length) paragraph(ui.screen, `${plural(state.keys.length, "key")} in memory.`, { color: GREEN });
  paragraph(ui.screen, "Setting up Electrum (once): show it the public key (\"Public key\", its zpub), as a new " +
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
    state.keyNote = "That key is loaded already.";
    console.log("signer: that key is loaded already");
  } else if (state.keys.length >= MAX_KEYS) {
    wallet.wipeKey(key);
    console.log("signer: too many keys");
    return showError(`At most ${MAX_KEYS} keys at a time.`);
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
  newPage("keys", ui.symbols.plus + " Keys");
  const c = coverage();
  if (state.keyNote) paragraph(ui.screen, state.keyNote, { color: AMBER });
  state.keyNote = null;
  if (!state.keys.length) {
    paragraph(ui.screen, state.after === "export"
      ? "The public key comes from a master key: codex32 shares, seed words or a master xprv."
      : "Load the keys that sign this transaction. They stay in this app's memory only, and are forgotten " +
        "after signing, unless you keep them for the next one.", { color: MUTED });
  }
  state.keys.forEach((k, i) => {
    const signs = c ? `: signs ${c.plan.keys[i].signs} of ${plural(c.total, "input")}` : "";
    paragraph(ui.screen, `${ui.symbols.ok} Key ${k.fingerprint}${signs}.`, { font: FONT.big, color: GREEN });
    paragraph(ui.screen, `From ${k.description}.`);
    if (k.master) {
      const acct = wallet.exportKey(k, "p2wpkh", "mainnet");
      paragraph(ui.screen, `Native segwit account ${acct.path}: fingerprint ${acct.fingerprint}.`);
    }
  });
  if (state.keys.length) {
    paragraph(ui.screen, "Check a fingerprint against what you know of this wallet: a wallet made from the seed " +
      "phrase shows the master fingerprint; Electrum's watch-only wallet, made from the public key this device " +
      "exports, shows the account's (Wallet, Information). A different one means another passphrase, " +
      "other shares, or the other choice of what the shares hold.", { color: MUTED });
  }
  const buttons = buttonRow(ui.screen);
  let first = null;
  if (state.keys.length && state.loaded) {
    first = new ui.Button(buttons, { text: ui.symbols.list + " Back to the transaction", onClick: showReview });
  }
  const shares = new ui.Button(buttons, { text: ui.symbols.plus + " Codex32 shares", onClick: () => showShares(0) });
  new ui.Button(buttons, { text: ui.symbols.plus + " Seed words", onClick: showWords });
  new ui.Button(buttons, { text: ui.symbols.plus + " xprv or WIF", onClick: showPrivate });
  if (state.keys.length) new ui.Button(buttons, { text: ui.symbols.trash + " Forget the keys", onClick: forgetKeys });
  new ui.Button(buttons, { text: ui.symbols.left + " Back", onClick: () => (state.loaded ? showReview() : showHome()) });
  (first || shares).focus();
}

// The BIP-39 passphrase, for the shares' page and the words' page.
function passphraseRow(submit) {
  const row = new ui.Container({ layout: "column", gap: 4, width: "100%" });
  paragraph(row, "BIP-39 passphrase (leave empty if none). A different passphrase is a different wallet: " +
    "check the fingerprint shown next.", { color: MUTED });
  const pass = page.pass = secret(new ui.TextArea(row, { oneLine: true, password: true, width: "100%", text: state.passphrase,
    maxLength: 256, placeholder: "no passphrase", font: FONT.text }));
  pass.onChange = (ev) => (state.passphrase = ev.value);
  pass.onSubmit = submit;
  new ui.Checkbox(row, { text: "Show the passphrase", onChange: (ev) => (pass.password = !ev.value) });
  return row;
}

function showError(msg) {
  state.error = msg;
  if (page.error) page.error.set({ text: msg || "", hidden: !msg });
}

// --- seed words -----------------------------------------------------------------

const countWords = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function showWords() {
  newPage("words", ui.symbols.plus + " Seed words");
  paragraph(ui.screen, "Type the BIP-39 words, separated by spaces, or scan them as text.", { color: MUTED });
  const area = secret(new ui.TextArea({ width: "100%", height: wide ? 130 : 90, maxLength: 400, text: state.words, font: FONT.text,
    accept: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ \n", placeholder: "abandon ability able ..." }));
  page.count = paragraph(ui.screen, plural(countWords(state.words), "word"), { font: FONT.small, color: MUTED });
  area.onChange = (ev) => {
    state.words = ev.value;
    page.count.text = plural(countWords(ev.value), "word");
    showError(null);
  };
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });
  passphraseRow(loadWords);
  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " Load the key", onClick: loadWords });
  new ui.Button(buttons, { text: ui.symbols.image + " Scan", onClick: () => showKeyScan("words") });
  new ui.Button(buttons, { text: ui.symbols.left + " Back", onClick: showKeys });
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
    return showError(e.message);
  } finally {
    busy = false;
  }
  addKey(key, "seed words");
}

// --- xprv or WIF ----------------------------------------------------------------

function showPrivate() {
  newPage("private", ui.symbols.plus + " xprv or WIF");
  paragraph(ui.screen, "Type or scan a private key: an extended one (xprv, or its zprv and yprv forms), or a " +
    "single key (WIF). A master key signs anything of its wallet, an account's key what is below it, and a " +
    "single key its own coins.", { color: MUTED });
  const field = secret(new ui.TextArea({ oneLine: true, password: true, width: "100%", maxLength: 160, text: state.privateText,
    font: FONT.text, accept: ACCEPT, placeholder: "xprv... or a WIF key" }));
  field.onChange = (ev) => {
    state.privateText = ev.value;
    showError(null);
  };
  field.onSubmit = loadPrivate;
  new ui.Checkbox({ text: "Show the key", onChange: (ev) => (field.password = !ev.value) });
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });
  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " Load the key", onClick: loadPrivate });
  new ui.Button(buttons, { text: ui.symbols.image + " Scan", onClick: () => showKeyScan("private") });
  new ui.Button(buttons, { text: ui.symbols.left + " Back", onClick: showKeys });
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
    return showError(e.message);
  }
  addKey(key, key.kind);
}

// A key as a QR code of plain text, into the page that asked.
function showKeyScan(what) {
  const back = () => (what === "words" ? showWords() : showPrivate());
  newPage("keyscan", ui.symbols.image + " Scan the key");
  page.back = back;
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 8, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 480 : 280, height: wide ? 360 : 210,
    onDetect: ({ text }) => {
      if (state.page !== "keyscan") return;
      if (text === null) return say("That code doesn't hold text.", RED);
      console.log("signer: scanned a key");
      page.scanner.stop();
      if (what === "words") state.words = text;
      else state.privateText = text.trim();
      back();
    },
    onError: ({ reason }) => say(`The camera stopped: ${reason}.`, RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, "Show the QR code.", { color: MUTED });
  new ui.Button(side, { text: ui.symbols.left + " Back", onClick: back }).focus();
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
  newPage("shares", ui.symbols.plus + " Codex32 shares");
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
  page.passRow = passphraseRow(() => loadShares());
  page.passRow.hidden = state.meaning !== "bip39";

  const buttons = buttonRow(ui.screen);
  page.load = new ui.Button(buttons, { text: ui.symbols.ok + " Load the key", onClick: loadShares });
  new ui.Button(buttons, { text: ui.symbols.image + " Scan shares", onClick: showShareScan });
  new ui.Button(buttons, { text: ui.symbols.trash + " Clear", onClick: clearShares });
  new ui.Button(buttons, { text: ui.symbols.left + " Back", onClick: showKeys });
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
    placeholder: i === 0 ? "ms1..." : "", font: wide ? 20 : 16 }));
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
  addKey(key, `${state.meaning}, ${plural(texts.length, "share")}`);
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

// --- the public key ------------------------------------------------------------

function showExport() {
  const key = state.keys.find((k) => k.master);
  if (!key) return showHome();
  newPage("export", ui.symbols.upload + " Public key");
  page.key = key;
  paragraph(ui.screen, "Show this once to the wallet that will make the transactions this device signs: a " +
    "descriptor for a wallet that takes them; the zpub for Electrum (File, New/Restore, Standard wallet, Use a " +
    "master key, then the camera button).", { color: MUTED });
  const opts = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  new ui.Dropdown(opts, {
    options: EXPORT_FORMS.map((x) => x.name), selected: state.exportForm,
    onChange: (ev) => { state.exportForm = ev.value; drawExport(); },
  });
  new ui.Dropdown(opts, {
    grow: 1,
    options: wallet.EXPORTS.map((x) => x.name), selected: state.exportType,
    onChange: (ev) => { state.exportType = ev.value; drawExport(); },
  });
  new ui.Dropdown(opts, {
    options: NETWORK_ORDER.map((n) => NETWORKS[n].name), selected: NETWORK_ORDER.indexOf(state.exportNetwork),
    onChange: (ev) => { state.exportNetwork = NETWORK_ORDER[ev.value]; drawExport(); },
  });
  const row = new ui.Container({ layout: "row", alignItems: "center", gap: 8, width: "100%" });
  new ui.Label(row, { text: "Account", font: FONT.text });
  const account = new ui.TextArea(row, { oneLine: true, width: 140, maxLength: 10, accept: "0123456789", text: String(state.account), font: FONT.text });
  account.onChange = (ev) => {
    const n = ev.value === "" ? null : Number(ev.value);
    page.account = n !== null && n <= wallet.MAX_ACCOUNT ? n : null;
    if (page.account !== null) state.account = page.account;
    drawExport();
  };
  new ui.Label(row, { text: "This device signs for the account shown here.", font: FONT.small, color: MUTED, grow: 1, overflow: "wrap" });
  page.account = state.account;
  page.out = new ui.Container({ layout: "column", gap: 6, width: "100%", alignItems: "center" });
  const back = new ui.Button({ text: ui.symbols.left + " Back", onClick: showHome });
  drawExport();
  back.focus();
}

function drawExport() {
  page.out.clear();
  if (page.account === null) {
    new ui.Label(page.out, { text: `An account number is 0 to ${wallet.MAX_ACCOUNT}.`, font: FONT.text, color: RED });
    return;
  }
  const x = wallet.exportKey(page.key, wallet.EXPORTS[state.exportType].id, state.exportNetwork, page.account);
  const form = EXPORT_FORMS[state.exportForm];
  const text = x[form.field];
  const size = Math.min(ui.height - 200, ui.width - 64, 420);
  new ui.QRCode(page.out, { data: text, size, ecc: "M" });
  new ui.Label(page.out, { text: `Account ${x.path}, fingerprint ${x.fingerprint}; master fingerprint ${x.master}`, font: FONT.text,
    width: "100%", overflow: "wrap", textAlign: "center" });
  new ui.Label(page.out, { text, font: FONT.small, width: "100%", overflow: "wrap", textAlign: "center" });
  console.log(`signer: showing the ${wallet.EXPORTS[state.exportType].id} public key (${state.exportNetwork}), ` +
    `account ${page.account}, ${form.id}, ${text.length} characters`);
}

// --- scanning a transaction -------------------------------------------------------

function showScan(merging) {
  state.merging = merging;
  newPage("scan", ui.symbols.image + (merging ? " Scan another copy" : " Scan a transaction"));
  page.reader = new CodeReader();
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 6, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"], width: wide ? 560 : 280, height: wide ? 420 : 210,
    onDetect: ({ text, bytes }) => scannedTx(text, bytes),
    onError: ({ reason }) => say(`The camera stopped: ${reason}.`, RED),
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, merging
    ? "Show a copy of the same transaction, with other signatures: it is merged into this one."
    : "Show the transaction's QR code (Electrum: Export, Show as QR code), or a wallet's animated BBQr codes. " +
      "Large ones need a steady hand and good light.");
  const buttons = buttonRow(side);
  new ui.Button(buttons, { text: ui.symbols.left + " Back", onClick: () => (state.loaded ? showReview() : showHome()) }).focus();
  page.again = new ui.Button(buttons, { text: ui.symbols.refresh + " Start over", hidden: true, onClick: () => {
    page.reader.reset();
    page.again.hidden = true;
    say("Show the first code of the series.", MUTED);
  } });
}

function refuse(text) {
  console.log(`signer: refused a code: ${text}`);
  say(ui.symbols.warning + " " + text, RED);
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
        say(`${got.part.have} of ${got.part.total} parts read. Keep it in view.`, GREEN);
      }
      return;
    }
    r = got.payload;
    loaded = { kind: r.kind, encoding: r.encoding, chars: r.chars, size: r.bytes.length, copies: 1, notes: [] };
    if (r.kind === "psbt") loaded.psbt = parsePsbt(r.bytes);
    else loaded.tx = parseTx(r.bytes);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    const why = e.message.endsWith(".") ? e.message : e.message + ".";
    return refuse(/^(This|The code|That|These)/.test(why) ? why : "Not a transaction Electrum would load: " + why);
  }
  if (state.merging) {
    if (r.kind !== "psbt") return refuse("That is a finished transaction: there is nothing to merge.");
    let m;
    try {
      m = combine(state.loaded.psbt, loaded.psbt);
    } catch (e) {
      if (!(e instanceof CombineError)) throw e;
      return refuse(e.message);
    }
    state.loaded.psbt = m.psbt;
    state.loaded.copies++;
    state.loaded.notes.push(...m.notes);
    state.signed = null;
    console.log(`signer: merged a copy (${r.encoding}, ${plural(m.added, "new field")})`);
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
    text: "Network: " + NETWORKS[a.network].name,
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
  newPage("review", "Finished transaction");
  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: ui.symbols.image + " Scan another", onClick: () => showScan(false) });
  networkButton(buttons, a);
  new ui.Button(buttons, { text: ui.symbols.home + " Home", onClick: showHome });
  paragraph(ui.screen, "It is signed already: there is nothing to sign here.", { color: MUTED });
  showAnalysis(reviewList(), page.rows, a, l, {
    networkNote: state.network ? "chosen" : inherited ? "as the transaction before: a signed one doesn't say" : null,
  });
  first.focus();
  console.log(`signer: finished transaction: ${plural(a.inputs.length, "input")}, ${plural(a.outputs.length, "output")}, ` +
    `${a.network}, ${plural(a.warnings.length, "warning")}`);
  logTotals(a);
}

// A key for another network than the transaction's is worth a word: its
// coins and addresses are not the ones shown.
function keyNetworkWarnings(a) {
  const test = a.network !== "mainnet";
  for (const k of state.keys) {
    if (k.network && (k.network === "test") !== test) {
      a.warnings.push({ level: "warn", text: `Key ${k.fingerprint} is a ${k.network === "test" ? "test network" : "mainnet"} key, ` +
        `and this transaction looks like ${NETWORKS[a.network].name}.` });
    }
  }
}

function showReview() {
  const l = state.loaded;
  if (!l) return showHome();
  if (l.kind === "tx") return showFinished();
  const a = analyze(l.psbt, { network: state.network });
  state.lastNetwork = a.network;
  const haveKeys = state.keys.length > 0;
  const plan = wallet.plan(l.psbt, state.keys, signOptions(a.network));
  if (haveKeys) applyPlan(a, plan);
  else flagSignatures(a, plan);
  keyNetworkWarnings(a);
  a.warnings.unshift(...l.notes);

  newPage("review", "Transaction to sign");
  const buttons = buttonRow(ui.screen);
  const count = plan.signable;
  let first;
  if (plan.complete && count === 0) {
    first = new ui.Button(buttons, { text: ui.symbols.ok + " Finish the transaction", onClick: () => sign(a) });
  } else if (!haveKeys) {
    first = new ui.Button(buttons, { text: ui.symbols.plus + " Load the keys to sign", onClick: () => askKeys("review") });
  } else {
    first = new ui.Button(buttons, { text: ui.symbols.edit + ` Sign ${plural(count, "input")}`, onClick: () => sign(a) });
    first.disabled = count === 0;
  }
  if (haveKeys && !first.disabled) first.disabled = !selftestOk();
  if (haveKeys) new ui.Button(buttons, { text: ui.symbols.plus + " Keys", onClick: () => askKeys("review") });
  new ui.Button(buttons, { text: ui.symbols.copy + " Merge a copy", onClick: () => showScan(true) });
  new ui.Button(buttons, { text: ui.symbols.image + " Scan another", onClick: () => showScan(false) });
  networkButton(buttons, a);
  new ui.Button(buttons, { text: ui.symbols.home + " Home", onClick: showHome });

  if (l.copies > 1) paragraph(ui.screen, `Merged from ${l.copies} copies.`, { color: MUTED });
  if (haveKeys) {
    const each = state.keys.map((k, i) => `key ${k.fingerprint} signs ${plan.keys[i].signs}`).join(", ");
    paragraph(ui.screen, `${plural(a.inputs.length, "input")}: ${each}.`, { color: plan.signable ? GREEN : RED });
    if (!plan.complete) paragraph(ui.screen, "Not every input can be signed here: the result is a PSBT that needs more signatures.", { color: AMBER });
  } else if (!plan.complete) {
    paragraph(ui.screen, "Check it. Change is only the transaction's claim until the keys are in.", { color: MUTED });
  }

  showAnalysis(reviewList(), page.rows, a, l, {
    networkNote: state.network ? "chosen" : null,
    changeClaimed: !haveKeys,
    inputNote: (i) => {
      const p = plan.inputs[i.index];
      if (p.sign) return { text: `${ui.symbols.edit} Will be signed${p.path ? ` (${p.path})` : ""}`, color: GREEN };
      if (p.signed || p.final) return { text: `${ui.symbols.ok} Signed already`, color: GREEN };
      return haveKeys ? { text: `${ui.symbols.close} Not signed: ${p.reason}`, color: AMBER } : null;
    },
  });
  first.focus();
  console.log(`signer: review: ${plural(a.inputs.length, "input")}, ${count} to sign, ${plural(a.outputs.length, "output")}, ` +
    `fee ${a.fee ?? "?"} sat, ${a.network}, ${plural(a.warnings.length, "warning")}`);
  logTotals(a);
  const of = (test) => a.outputs.filter(test).length;
  console.log(`signer: change: ${haveKeys ? 0 : of((o) => o.mine)} claimed, ${haveKeys ? of((o) => o.mine) : 0} checked, ` +
    `${of((o) => o.stray !== undefined)} stray, ${of((o) => o.unverified)} unverified, ` +
    `${haveKeys ? plan.outputs.filter((o) => o.problem).length : 0} refuted`);
}

async function sign(a) {
  if (busy || !selftestOk()) return;
  if (a.warnings.some((w) => w.level === "danger")) {
    const answer = await ui.alert("There are serious warnings (in red) about this transaction. Sign it anyway?",
      { title: "Sign?", buttons: ["Don't sign", "Sign anyway"] });
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
  console.log(`signer: signed ${plural(r.count, "input")}` +
    (r.tx ? `, transaction complete (SHA-256 ${toHex(crypto.sha256(r.tx).subarray(0, 8))})` : ""));
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
  newPage("signed", ui.symbols.ok + (s.tx ? " Signed" : " Partly signed"));
  const bytes = form === "tx" ? s.tx : s.psbt;
  const text = electrumQrText(bytes);
  paragraph(ui.screen, (form === "tx"
    ? "The complete, signed transaction. "
    : s.tx ? "The PSBT with its signatures. " : "The PSBT with the signatures so far: it needs more before it can be sent. ") +
    "In Electrum: Tools, Load transaction, From QR code; check it there, then Broadcast.", { color: MUTED });
  const buttons = buttonRow(ui.screen);
  const done = new ui.Button(buttons, { text: ui.symbols.ok + (state.keys.length ? " Done, forget the keys" : " Done"), onClick: () => finish(false) });
  if (state.keys.length) new ui.Button(buttons, { text: ui.symbols.right + " Next transaction (keep keys)", onClick: () => finish(true) });
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
