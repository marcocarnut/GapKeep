// codex32 for zerogap: recombine codex32 (BIP-93) shares into the BIP-39
// phrase they were split from. A port of dice39's codex32_recover.html.
//
// The codex32 arithmetic, the strings and entropy-to-words are dice39's own
// code, copied verbatim into ./vendor by tools/extract_codex32.py. Checking
// and recombining shares is ./lib/codex32.js, a pure module other apps can
// import. This file is only the user interface.
//
// Never logged: shares, the secret, the seed, the words. The log goes to the
// serial port in test builds; it gets counts and sizes only.

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import "./lib/cryptoshim.js";
import { RECOVER_SIZES, wordsFromEntropy, hex, SEEDQR_ECC, seedQrDigits } from "./vendor/recover.js";
import { checkShare, recover, normalizeShare, Codex32Error } from "./lib/codex32.js";
import { runCodex32SelfTest } from "./lib/selftest.js";
import { S, F } from "./lib/strings.js";

const GREEN = "#66bb6a", AMBER = "#ffb300", RED = "#ef5350", MUTED = "#8a9199";
const wide = ui.width >= 900;
const MAX_SHARES = 9;
const ACCEPT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";

const state = {
  page: null,
  texts: [""],        // what is typed in each box (kept here, never in zg:session)
  committed: [],      // box i was left or submitted: show all of its errors
  fields: [],         // { row, ta, note } of the boxes on screen
  focused: -1,        // the box with the keyboard focus
  error: null,        // message under the boxes
  result: null,       // { seed, words, secret, id, thresholdChar, count }
  selftest: null,     // { passed, failed }
  scanCount: 0,
};
let page = {};        // widgets of the page shown

// --- helpers ------------------------------------------------------------------

function newPage(name, subtitle) {
  state.page = name;
  state.fields = [];
  state.focused = -1;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [20, 32] : [12, 16], gap: wide ? 12 : 8, scrollable: true });
  page = {};
  const head = new ui.Container({ layout: "row", alignItems: "end", gap: 12, width: "100%" });
  new ui.Label(head, { text: "codex32", font: wide ? 32 : 28 });
  new ui.Label(head, { text: subtitle, font: wide ? 20 : 18, color: MUTED, grow: 1 });
  return head;
}

function paragraph(parent, text, props) {
  return new ui.Label(parent, { text, width: "100%", font: wide ? 16 : 14, ...props });
}

function warning(parent, text) {
  const box = new ui.Panel(parent, { width: "100%", layout: "column", padding: 10, borderColor: AMBER, borderWidth: 2 });
  new ui.Label(box, { text: ui.symbols.warning + "  " + text, font: wide ? 16 : 14, width: "100%" });
  return box;
}

function buttonRow(parent) {
  return new ui.Container(parent, { layout: "row-wrap", gap: 10, width: "100%" });
}

const need = (share) => (share.threshold === 0 ? 1 : share.threshold);
const filled = () => state.texts.filter((t) => normalizeShare(t)).length;

// The first share that checks out, which sets how many boxes there are
function firstValid() {
  for (const t of state.texts) {
    const r = checkShare(t);
    if (r.ok) return r.share;
  }
  return null;
}

// --- entering shares ----------------------------------------------------------

function showEntry(focusIndex) {
  newPage("entry", S.h1Title);
  paragraph(ui.screen, S.subtitle);
  warning(ui.screen, S.warnHtml);
  new ui.Label({ text: S.inputHeading, font: wide ? 22 : 18 });
  paragraph(ui.screen, S.inputHelp, { color: MUTED });

  page.boxes = new ui.Container({ layout: "column", gap: 4, width: "100%" });
  page.error = paragraph(ui.screen, "", { color: RED, hidden: true });
  const buttons = buttonRow(ui.screen);
  page.recover = new ui.Button(buttons, { text: ui.symbols.ok + "  " + S.recoverBtn, onClick: doRecover });
  new ui.Button(buttons, { text: ui.symbols.image + "  " + S.scanBtn, onClick: showScan });
  new ui.Button(buttons, { text: ui.symbols.trash + "  " + S.clearBtn, onClick: clearAll });
  new ui.Button(buttons, { text: "About", onClick: showAbout });
  page.selftest = paragraph(ui.screen, "", { font: 12 });

  syncBoxes();
  showError(state.error);
  showSelftest();
  const i = Math.min(focusIndex || 0, state.fields.length - 1);
  if (focusIndex === "recover") page.recover.focus();
  else state.fields[i].ta.focus();
}

// As many boxes as the first valid share's threshold asks for (2 until one
// is valid), and never fewer than hold text or than the box being typed in
function boxCount() {
  const v = firstValid();
  let last = state.focused + 1;
  state.texts.forEach((t, i) => { if (normalizeShare(t)) last = Math.max(last, i + 1); });
  return Math.min(MAX_SHARES, Math.max(v ? need(v) : 2, last));
}

// Adds or removes boxes at the end to match boxCount()
function syncBoxes() {
  const n = boxCount();
  while (state.texts.length < n) state.texts.push("");
  state.texts.length = n;   // past n there is only empty boxes
  while (state.fields.length > n) state.fields.pop().row.delete();
  while (state.fields.length < n) state.fields.push(makeBox(state.fields.length));
  state.fields.forEach((f, i) => updateNote(i));
}

function makeBox(i) {
  const row = new ui.Container(page.boxes, { layout: "column", gap: 2, width: "100%" });
  const line = new ui.Container(row, { layout: "row", alignItems: "center", gap: 8, width: "100%" });
  new ui.Label(line, { text: `${i + 1}.`, width: 24, textAlign: "right", color: MUTED });
  const ta = new ui.TextArea(line, {
    oneLine: true, grow: 1, maxLength: 160, accept: ACCEPT, text: state.texts[i] || "",
    placeholder: i === 0 ? "ms1..." : "",
    font: wide ? 20 : 16,
  });
  const note = new ui.Label(row, { text: "", font: wide ? 16 : 12, width: "100%", padding: [0, 0, 0, 32] });
  ta.onChange = (ev) => {
    state.texts[i] = ev.value;
    if (!normalizeShare(ev.value)) state.committed[i] = false;
    hideError();
    syncBoxes();
  };
  ta.onFocus = () => { state.focused = i; };
  ta.onBlur = () => {
    if (state.focused === i) state.focused = -1;
    if (state.page !== "entry" || !ta.alive) return;
    if (normalizeShare(state.texts[i])) state.committed[i] = true;
    updateNote(i);
  };
  ta.onSubmit = () => {
    if (normalizeShare(state.texts[i])) state.committed[i] = true;
    updateNote(i);
    const r = checkShare(state.texts[i]);
    if (!r.ok) {   // stay: the note says why
      console.log(`codex32: box ${i + 1} refused: ${r.error.code}` + (r.error.suggestion ? ", a fix suggested" : ""));
      return;
    }
    const next = state.fields.findIndex((f, j) => j > i && !normalizeShare(state.texts[j]));
    if (next >= 0) state.fields[next].ta.focus();
    else doRecover();
  };
  return { row, ta, note };
}

// The line under box i: what the share is, or what is wrong with it
function updateNote(i) {
  const f = state.fields[i];
  if (!f) return;
  const text = state.texts[i];
  if (!normalizeShare(text)) return f.note.set({ text: "", hidden: true });
  // the typo search only when its answer is shown
  const r = checkShare(text, { suggest: !!state.committed[i] });
  if (r.ok) {
    const s = r.share;
    const conflict = conflictWithEarlier(i, s);
    if (conflict) return f.note.set({ text: ui.symbols.close + " " + conflict, color: RED, hidden: false });
    const what = s.isSecret
      ? `the secret itself (index S), identifier ${s.id.toUpperCase()}`
      : `share ${s.index.toUpperCase()}, identifier ${s.id.toUpperCase()}, threshold ${s.thresholdChar}`;
    return f.note.set({ text: `${ui.symbols.ok} Valid: ${what}, ${s.seedBytes}-byte seed.`, color: GREEN, hidden: false });
  }
  const e = r.error;
  const soft = e.code === "length" || e.code === "checksum" || (e.code === "prefix" && e.partial);
  if (soft && !state.committed[i]) {
    const n = normalizeShare(text).length;
    return f.note.set({ text: `${n} character${n === 1 ? "" : "s"}`, color: MUTED, hidden: false });
  }
  f.note.set({ text: ui.symbols.close + " " + e.message, color: RED, hidden: false });
}

// A share that cannot go with the ones in the boxes above it (as the page's
// scanner says it): another split, or the same index twice
function conflictWithEarlier(i, s) {
  for (let j = 0; j < i; j++) {
    const r = checkShare(state.texts[j]);
    if (!r.ok) continue;
    const o = r.share;
    if (o.id !== s.id || o.threshold !== s.threshold) {
      return F(S.scanMismatch, { id: s.id.toUpperCase(), k: s.thresholdChar }) + ` Box ${j + 1} has ` +
        `${o.id.toUpperCase()}, threshold ${o.thresholdChar}.`;
    }
    if (o.index === s.index) return `Box ${j + 1} has share index ${s.index.toUpperCase()} already.`;
  }
  return null;
}

function showError(msg) {
  state.error = msg;
  if (state.page === "entry" && page.error) page.error.set({ text: msg || "", hidden: !msg });
}
const hideError = () => showError(null);

function showSelftest() {
  if (state.page !== "entry") return;
  const st = state.selftest;
  page.recover.disabled = !st || st.failed.length > 0;
  if (!st) page.selftest.set({ text: "Self-test running...", color: MUTED });
  else if (!st.failed.length) {
    page.selftest.set({ text: `${ui.symbols.ok} Self-test passed (${st.passed} checks: every BIP-93 test vector, ` +
      "valid and invalid, typo suggestions, BIP-39 words).", color: GREEN });
  } else {
    page.selftest.set({ text: `${ui.symbols.close} Self-test FAILED. Do not use this device to recover a seed.\n` +
      st.failed.join("\n"), color: RED });
  }
}

// --- recovering ---------------------------------------------------------------

let recovering = false;

async function doRecover() {
  if (recovering || state.page !== "entry") return;
  // (the button is disabled until then; Enter in the last box is not)
  if (!state.selftest) return showError("The self-test is still running: try again in a moment.");
  if (state.selftest.failed.length) return showError("The self-test failed: this device must not recover a seed.");
  hideError();
  const texts = state.texts.filter((t) => normalizeShare(t));
  if (!texts.length) return showError(S.errNoShares);
  let res;
  try {
    res = recover(texts);
  } catch (e) {
    if (!(e instanceof Codex32Error)) throw e;
    console.log(`codex32: recovery refused: ${e.code}` + (e.share ? ` (share ${e.share})` : ""));
    state.committed = state.texts.map((t) => !!normalizeShare(t));
    state.fields.forEach((f, i) => updateNote(i));
    showError(S.errPrefix.trim() + " " + e.message);
    // to the box at fault (counted among the filled ones)
    if (e.share) {
      let k = 0;
      const box = state.texts.findIndex((t) => normalizeShare(t) && ++k === e.share);
      if (box >= 0) state.fields[box].ta.focus();
    }
    return;
  }
  if (!RECOVER_SIZES[res.seed.length]) {
    console.log(`codex32: recovered ${res.seed.length} bytes, not a 12-, 15-, 18- or 24-word phrase: refused`);
    res.seed.fill(0);
    return showError(F(S.errWrongSize, { n: res.seed.length }));
  }
  recovering = true;
  let words;
  try {
    words = await wordsFromEntropy(res.seed);
  } catch (e) {
    res.seed.fill(0);
    return showError(S.errPrefix.trim() + " " + (e && e.message ? e.message : e));
  } finally {
    recovering = false;
  }
  wipeResult();
  state.result = { seed: res.seed, words, secret: res.secret, id: res.id, thresholdChar: res.thresholdChar,
    count: texts.length };
  console.log(`codex32: recovered a ${res.seed.length}-byte seed (${words.length} words) from ` +
    `${texts.length} share${texts.length === 1 ? "" : "s"}`);
  showResult();
}

// The page's placeholders for the phrase on screen: {t} words, {third} of
// them per part of the 3-part QR, {bytes} of entropy (16, 20, 24 or 32)
function lenVars() {
  const t = state.result ? state.result.words.length : 24;
  const bytes = Number(Object.keys(RECOVER_SIZES).find((n) => RECOVER_SIZES[n].words === t));
  return { t, third: Math.ceil(t / 3), bytes };
}
const FL = (text, vars) => F(text, { ...lenVars(), ...(vars || {}) });

function showResult() {
  const r = state.result;
  newPage("result", S.resultHeading);

  const meta = new ui.Container({ layout: "row-wrap", gap: 20, width: "100%" });
  for (const [k, v] of [[S.metaThreshold, r.thresholdChar], [S.metaId, r.id.toUpperCase()],
    [S.metaShares, String(r.count)]]) {
    new ui.Label(meta, { text: `${k}: ${v}`, font: wide ? 18 : 16 });
  }

  const cols = wide ? 4 : 3;
  const tileWidth = Math.floor((ui.width - (wide ? 64 : 32) - 10 - (cols - 1) * 8) / cols);
  const grid = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  r.words.forEach((w, i) => {
    const tile = new ui.Panel(grid, {
      width: tileWidth, layout: "row", gap: 8, padding: [6, 10], alignItems: "center", scrollable: false,
    });
    new ui.Label(tile, { text: String(i + 1), color: MUTED, font: 14, width: 24 });
    new ui.Label(tile, { text: w, font: wide ? 22 : 18 });
  });

  // the buttons straight under the words: focused, they are in view with them
  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: S.tabWordsLabel, onClick: () => showExport("words") });
  new ui.Button(buttons, { text: "SeedQR and Compact SeedQR", onClick: () => showExport("seed") });
  new ui.Button(buttons, { text: ui.symbols.left + "  Back to the shares", onClick: () => backToEntry() });
  new ui.Button(buttons, { text: ui.symbols.trash + "  " + S.clearBtn, onClick: clearAll });

  paragraph(ui.screen, FL(S.entropyLabel) + "\n" + hex(r.seed), { font: wide ? 16 : 14 });
  paragraph(ui.screen, S.secretLabel + "\n" + r.secret, { font: wide ? 16 : 14 });
  paragraph(ui.screen, FL(S.resultNote), { color: MUTED });

  showKeys(ui.screen, r);

  new ui.Label({ text: S.exportHeading, font: wide ? 22 : 18 });
  paragraph(ui.screen, S.exportCompareHtml, { color: MUTED });
  first.focus();
}

// The place for what a wallet derives from the seed: the master key
// fingerprint and the xpub, once zg:crypto has PBKDF2 and secp256k1. Mind
// which seed: these shares (dice39's) carry BIP-39 entropy, so the BIP-32
// master seed is PBKDF2 of r.words (BIP-39), not r.seed. Shares that follow
// BIP-93 to the letter carry the BIP-32 master seed itself.
function showKeys(parent, r) {
  // not yet
}

// Leaving the result: the words go, the shares stay in their boxes
function backToEntry() {
  wipeResult();
  showEntry("recover");
}

// --- exports ------------------------------------------------------------------

// One export on screen at a time, behind its confirmation, as on the page.
function showExport(kind) {
  const r = state.result;
  const words = kind === "words";
  newPage("export", words ? S.tabWordsLabel : S.tabSeedLabel);
  paragraph(ui.screen, words ? S.qrIntro : S.seedIntro);
  warning(ui.screen, FL(words ? S.qrWarningHtml : S.seedWarningHtml));
  // a Checkbox's label does not wrap: the page's sentence goes above it
  paragraph(ui.screen, words ? S.qrConfirmLabel : S.seedConfirmLabel);
  const confirm = new ui.Checkbox({ text: "I understand" });
  const buttons = buttonRow(ui.screen);
  const modes = words
    ? [["single", FL(S.qrBtnSingle)], ["split", FL(S.qrBtnSplit)]]
    : [["seed", S.qrBtnSeed], ["compact", S.qrBtnCompact]];
  const modeButtons = modes.map(([mode, text]) =>
    new ui.Button(buttons, { text, disabled: true, onClick: () => drawQr(mode) }));
  const note = words ? null : paragraph(ui.screen, S.qrFormatNote, { color: MUTED, hidden: true });
  const out = new ui.Container({ layout: "row-wrap", gap: 12, width: "100%", justify: "center" });
  const back = buttonRow(ui.screen);
  new ui.Button(back, { text: ui.symbols.left + "  Back", onClick: showResult });

  confirm.onChange = (ev) => {
    for (const b of modeButtons) b.disabled = !ev.value;
    if (note) note.hidden = !ev.value;
    if (!ev.value) out.clear();
  };

  function qrBox(data, label, ecc, size) {
    const box = new ui.Container(out, { layout: "column", gap: 4, alignItems: "center" });
    const qr = new ui.QRCode(box, { size, ecc, data });
    new ui.Label(box, { text: label.replace("{g}", `${qr.modules}x${qr.modules}`), font: 12,
      maxWidth: Math.max(size, 200), textAlign: "center" });
    return qr;
  }

  function drawQr(mode) {
    out.clear();
    const big = Math.min(ui.height - 120, ui.width - 64, 520);
    if (mode === "single") qrBox(r.words.join(" "), FL(S.qrLabelSingle), "M", big);
    if (mode === "seed") qrBox(seedQrDigits(r.words), S.qrLabelSeed, SEEDQR_ECC, big);
    if (mode === "compact") qrBox(r.seed, S.qrLabelCompact, SEEDQR_ECC, big);
    if (mode === "split") {
      const per = r.words.length / 3;
      const size = Math.min(Math.floor((ui.width - (wide ? 64 : 32) - 40) / 3), 360);
      for (let i = 0; i < 3; i++) {
        qrBox(r.words.slice(i * per, i * per + per).join(" "),
          FL(S.qrLabelSplit, { a: i * per + 1, b: i * per + per }), "M", size);
      }
    }
    console.log(`codex32: showing the ${mode} QR export`);
    out.scrollIntoView();
  }
  confirm.focus();
}

// --- scanning -----------------------------------------------------------------

function showScan() {
  newPage("scan", S.scanBtn);
  const body = new ui.Container({ layout: wide ? "row" : "column", gap: wide ? 20 : 8, width: "100%" });
  page.scanner = new ui.Scanner(body, {
    detect: ["qr"],
    width: wide ? 480 : 280,
    height: wide ? 360 : 210,
    onDetect: ({ text }) => scanned(text),
    onError: ({ reason }) => {
      say(reason === "no camera" ? S.scanNoCamera : `The camera stopped: ${reason}.`, RED);
      console.log(`codex32: camera error: ${reason}`);
    },
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, F(S.scanAiming, { n: filled() }), { color: MUTED });
  page.done = new ui.Button(side, { text: ui.symbols.close + "  " + S.scanStop, onClick: () => showEntry(firstEmpty()) });
  page.done.focus();
}

function say(text, color) {
  if (state.page === "scan") page.status.set({ text, color });
}

function firstEmpty() {
  const i = state.texts.findIndex((t) => !normalizeShare(t));
  return i >= 0 ? i : "recover";
}

// As the page's handleScannedValue: a share is checked against those already
// in the boxes before it is added
function scanned(text) {
  if (state.page !== "scan") return;
  const r = text == null ? null : checkShare(text.trim());
  if (!r || !r.ok) {
    console.log("codex32: scanned a code that is not a codex32 share");
    return say(S.scanNotShare, RED);
  }
  const s = r.share;
  const have = state.texts.map((t) => checkShare(t)).filter((x) => x.ok).map((x) => x.share);
  const first = have[0];
  if (first && (first.id !== s.id || first.threshold !== s.threshold)) {
    console.log("codex32: scanned a share of another split");
    return say(F(S.scanMismatch, { id: s.id.toUpperCase(), k: s.thresholdChar }), RED);
  }
  if (have.some((o) => o.index === s.index)) {
    console.log("codex32: scanned a share already there");
    return say(F(S.scanDuplicate, { i: s.index.toUpperCase() }), RED);
  }
  let slot = state.texts.findIndex((t) => !normalizeShare(t));
  if (slot < 0) slot = state.texts.length;
  if (slot >= MAX_SHARES) return say(S.scanNotShare, RED);
  state.texts[slot] = s.string;
  state.committed[slot] = true;
  const k = need(s);
  const n = have.length + 1;
  console.log(`codex32: scanned share ${n} of ${k}`);
  if (n >= k) {
    page.scanner.stop();
    hideError();
    showEntry("recover");
    return;
  }
  say(F(S.scanAdded, { i: s.index.toUpperCase(), n, k }), GREEN);
}

// --- clearing -----------------------------------------------------------------

function wipeResult() {
  const r = state.result;
  if (!r) return;
  r.seed.fill(0);
  r.words.length = 0;
  state.result = null;
}

// Everything typed, scanned and recovered goes; the next screen is empty
function clearAll() {
  wipeResult();
  state.texts = [""];
  state.committed = [];
  state.error = null;
  sys.gc();
  console.log("codex32: cleared");
  showEntry(0);
}

// --- about --------------------------------------------------------------------

function showAbout() {
  newPage("about", "About");
  paragraph(ui.screen,
    "This is dice39's codex32 recombiner (codex32_recover.html) running on zerogap. It takes the shares " +
    "dice39 splits a phrase into, any k of a k-of-n split, and gives the phrase back.");
  paragraph(ui.screen,
    "The codex32 arithmetic, the messages and the step from entropy to words are dice39's own JavaScript, " +
    "copied byte for byte from codex32_recover.html by tools/extract_codex32.py; each copied file names the " +
    "source file and its SHA-256. On top, for a keyboard: each share is checked as it is typed, the BIP-93 " +
    "lengths are enforced, and when the checksum fails because of one mistyped character, the app says which " +
    "one and what it should probably be (BIP-93 suggests offering that; it never fixes the share by itself).",
    { color: MUTED });
  paragraph(ui.screen,
    "Different from the web page: no clipboard (this device has none), so no copy button; Escape leaves the " +
    "camera and the QR pages; a single unshared secret (threshold 0) is accepted. The shares and the result " +
    "are only ever in this app's memory, never in the session store or on the card.", { color: MUTED });
  paragraph(ui.screen, `dice39 is licensed under the GNU AGPL v3. zerogap ${sys.version.zerogap}, ` +
    `QuickJS ${sys.version.quickjs}, LVGL ${sys.version.lvgl}.`, { color: MUTED, font: 12 });
  new ui.Button({ text: ui.symbols.left + "  Back", onClick: () => showEntry(0) }).focus();
}

// Escape leaves the camera, the exports and About
ui.onKey((ev) => {
  if (ev.key !== "Escape") return false;
  if (state.page === "scan") showEntry(firstEmpty());
  else if (state.page === "export") showResult();
  else if (state.page === "about") showEntry(0);
  else return false;
  return true;
});

// --- start ----------------------------------------------------------------------

showEntry(0);
console.log("codex32 ready");
runCodex32SelfTest().then((st) => {
  state.selftest = st;
  console.log(`codex32 selftest: ${st.passed} passed, ${st.failed.length} failed`);
  for (const f of st.failed) console.log("codex32 selftest FAIL:", f);
  showSelftest();
});
