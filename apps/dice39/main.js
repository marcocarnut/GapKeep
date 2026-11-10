// dice39 for GapKeep: physical dice and a coin to a BIP-39 seed phrase.
//
// The algorithm is dice39's own code, copied verbatim into ./vendor by
// tools/extract_dice39.py; this file is only the user interface. See
// ./vendor/*.js for the provenance header (source file and its SHA-256).
//
// The text is translated (gk:i18n, lang/<language>.json; most of it in
// lib/strings.js). The log stays in English, and holds no secret.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as gkcrypto from "gk:crypto";
import { t, plural } from "gk:i18n";
import "./lib/cryptoshim.js";
import { BIP39_WORDS } from "./vendor/wordlist.js";
import { buildMnemonic, importMnemonic, PHRASE_SIZES, concatBytes, sha256 } from "./vendor/bip39core.js";
import { CODEX32 } from "./vendor/codex32.js";
import {
  parseDiceCode, isPartialDiceCode, diceWordFor, sortedPairsSuspected,
  seedQrDigits, samplesToBytes,
} from "./vendor/dice.js";
import { runDice39SelfTest } from "./lib/selftest.js";
import { entropyBitsTarget, newPad, addPadSample } from "./lib/entropypad.js";
import { S } from "./lib/strings.js";
import { setCrypto } from "./lib/crypto.js";
import { accountKey, MAX_ACCOUNT } from "./lib/pubkey.js";

setCrypto(gkcrypto);   // for the signer's BIP-39 and BIP-32 (lib/pubkey.js)

const GREEN = "#66bb6a", AMBER = "#ffb300", RED = "#ef5350", MUTED = "#8a9199";
const WORDS = new Set(BIP39_WORDS);

// Phrase lengths, in dice39's order
const SIZES = [24, 18, 15, 12];

const state = {
  total: 24,          // phrase length
  mode: "dice",       // "dice": dice words plus the device's; "import": a phrase you already have
  fields: [],         // word entry boxes
  samples: [],        // key timings, mixed into the device entropy
  pad: null,          // entropy pad: { samples, bits, last, lastTime }
  result: null,       // buildMnemonic output + extras
  selftest: null,     // { passed, failed }
  account: 0,         // the public key's account number
  passphrase: "",     // the BIP-39 passphrase ("" is none); never logged
  showPassphrase: false,
  keyForm: 0,         // the key's QR code: 0 descriptor, 1 zpub (KEY_FORMS)
  split: null,        // the last codex32 split: { scheme, id, shares, checked }
};

// --- entropy from key timing (additive; the hardware RNG is the floor) ---

const SAMPLE_CAP = 1200;
ui.onKey((ev) => {
  if (state.samples.length < SAMPLE_CAP) {
    state.samples.push({
      x: ev.key.length === 1 ? ev.key.charCodeAt(0) : ev.key.length,
      y: (ev.shift ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.alt ? 4 : 0),
      t: sys.uptime(),
      ms: Date.now(),
    });
  }
  return false;  // never consume: this only listens
});

// --- the entropy pad (accounting in lib/entropypad.js) ----------------------

// The pad, its progress bar and label. onUpdate runs after every accepted sample.
function entropyPad(parent, target, onUpdate) {
  new ui.Label(parent, { text: S.step2Heading, font: 18 });
  paragraph(parent, S.step2Body, { color: MUTED });
  // the bar goes above the pad (dice39 has it below): scrolled to the
  // focused pad on a small screen, it stays in view
  const row = new ui.Container(parent, { layout: "row", alignItems: "center", gap: 12, width: "100%" });
  const bar = new ui.Bar(row, { min: 0, max: target, value: 0, grow: 1 });
  const label = new ui.Label(row, { font: 14, color: MUTED });
  const pad = new ui.Container(parent, {
    width: "100%", height: 140, radius: 10, borderWidth: 2, borderColor: "#3a4152", bg: "#14171f",
    layout: "column", justify: "center", alignItems: "center", scrollable: false, focusable: true,
  });
  new ui.Label(pad, { text: S.padText, color: MUTED, clickable: false });

  const update = () => {
    const bits = Math.min(state.pad.bits, target);
    bar.value = bits;
    label.text = S.bitsLabel(bits, target, Math.round(bits / target * 100));
    if (bits >= target && !state.pad.announced) {
      state.pad.announced = true;   // counts only: never log what was sampled
      console.log(`dice39: entropy pad full: ${state.pad.samples.length} samples, ${state.pad.bits} bits`);
    }
    onUpdate();
  };
  pad.onPress = (ev) => { if (addPadSample(state.pad, ev, "tap")) update(); };
  // Without a mouse, any key typed on the focused pad is a tap without a
  // position (Space and Enter already arrive as presses, above). Held keys
  // count once; Tab, Escape and the arrows keep moving the focus.
  const NAVIGATION = new Set([" ", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown"]);
  pad.onKey = (ev) => {
    if (ev.repeat || ev.ctrl || ev.alt || NAVIGATION.has(ev.key)) return false;
    if (addPadSample(state.pad, { pointer: false, time: sys.uptime() }, "tap")) update();
    return true;
  };
  pad.onDrag = (ev) => { if (addPadSample(state.pad, ev, "drag")) update(); };
  update();
  return pad;
}

// --- helpers --------------------------------------------------------------

const normalize = (w) => (w || "").trim().toLowerCase();
const pairs = (code) => `${code.dice[0]}${code.dice[1]} ${code.dice[2]}${code.dice[3]}`;

// Clears the screen and starts a page: a scrollable column.
function page(title) {
  state.page = title;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: [14, 20], gap: 10, scrollable: true });
  const head = new ui.Container({ layout: "row", alignItems: "end", gap: 12, width: "100%" });
  new ui.Label(head, { text: "dice39", font: 28 });
  new ui.Label(head, { text: title, font: 18, color: MUTED, grow: 1 });
  return head;
}

function paragraph(parent, text, props) {
  return new ui.Label(parent, { text, width: "100%", font: 14, ...props });
}

function warning(parent, [headline, body]) {
  const box = new ui.Panel(parent, {
    width: "100%", layout: "column", gap: 4, padding: 10, borderColor: AMBER, borderWidth: 2,
  });
  new ui.Label(box, { text: ui.symbols.warning + "  " + headline, color: AMBER, width: "100%" });
  new ui.Label(box, { text: body, font: 14, width: "100%" });
}

function buttonRow(parent) {
  return new ui.Container(parent, { layout: "row-wrap", gap: 10, width: "100%" });
}

async function confirm(text, yes, title) {
  return (await ui.alert(text, { title, buttons: [t("Cancel"), yes] })) === 1;
}

// --- start ----------------------------------------------------------------

function showStart() {
  state.result = null;
  page(S.tagline);

  paragraph(ui.screen, S.need);
  paragraph(ui.screen, S.procedure, { color: MUTED });
  paragraph(ui.screen, S.order, { color: MUTED });

  const row = new ui.Container({ layout: "row", alignItems: "center", gap: 12 });
  new ui.Label(row, { text: t("Phrase length") });
  const len = new ui.Dropdown(row, {
    options: SIZES.map((n) => (n === 24 ? t("24 words (recommended)") : t("{n} words", { n }))),
    selected: SIZES.indexOf(state.total),
    width: 300,
    onChange: (ev) => {
      state.total = SIZES[ev.value];
    },
  });
  paragraph(ui.screen, S.lenNote, { color: MUTED, font: 12 });

  const buttons = buttonRow(ui.screen);
  const start = new ui.Button(buttons, {
    text: ui.symbols.right + "  " + t("Enter my dice words"),
    onClick: () => showEntry(),
  });
  const own = new ui.Button(buttons, { text: t("I already have a seed phrase"), onClick: () => showImport() });
  new ui.Button(buttons, { text: t("About"), onClick: showAbout });

  // Nothing is made or split before the self-test has passed: the buttons
  // stay disabled until it has, and the page is redrawn when it finishes.
  const st = state.selftest;
  start.disabled = own.disabled = !st || st.failed.length > 0;
  if (!st) {
    paragraph(ui.screen, t("Self-test running..."), { color: MUTED, font: 12 });
  } else if (st.failed.length === 0) {
    paragraph(ui.screen, ui.symbols.ok + " " + t("Self-test passed ({n} checks: BIP-39, BIP-84 and codex32 test " +
      "vectors, dice tables, round trips).", { n: st.passed }), { color: GREEN, font: 12 });
  } else {
    paragraph(ui.screen, ui.symbols.close + " " + t("Self-test FAILED. Do not use this device to make a seed.") +
      "\n" + st.failed.join("\n"), { color: RED });
  }
  (st && st.failed.length === 0 ? start : len).focus();
}

// --- word entry -----------------------------------------------------------

function showEntry() {
  const spec = PHRASE_SIZES[state.total];
  state.mode = "dice";
  page(t("Words 1 to {max} of {total}", { max: spec.maxUser, total: state.total }));
  paragraph(ui.screen, S.entryHelp, { color: MUTED });

  const grid = new ui.Container({ layout: "row-wrap", gap: 10, width: "100%" });
  const cellWidth = Math.max(180, Math.floor((ui.width - 40 - 20) / 3));
  state.fields = [];
  for (let i = 0; i < spec.maxUser; i++) state.fields.push(makeField(grid, i, cellWidth));

  const status = new ui.Label({ width: "100%", font: 14 });
  const target = entropyBitsTarget(spec);
  state.refresh = null;   // the previous page's, if any: its widgets are gone
  state.pad = newPad();
  const pad = entropyPad(ui.screen, target, () => state.refresh && state.refresh());
  const buttons = buttonRow(ui.screen);
  const generate = new ui.Button(buttons, {
    text: ui.symbols.ok + "  " + t("Generate"),
    disabled: true,
    onClick: () => onGenerate(),
  });
  backButton(buttons);

  state.next = () => (state.padFull() ? generate : pad);
  state.ready = () => {
    const n = countWords();
    return n >= spec.minUser && n <= spec.maxUser;
  };
  state.padFull = () => state.pad.bits >= target;
  state.refresh = () => {
    const n = countWords();
    const ready = state.ready();
    generate.disabled = !(ready && state.padFull());
    const typed = state.fields.filter((f) => normalize(f.ta.text)).length;
    const text = [plural(n, "{n} word entered ({min} to {max}).", "{n} words entered ({min} to {max}).",
      { min: spec.minUser, max: spec.maxUser })];
    if (ready) text.push(t("Words {from} to {total} will come from this device.", { from: n + 1, total: state.total }));
    else text.push(t("Enter at least {n} more.", { n: spec.minUser - n }));
    if (ready && !state.padFull()) text.push(t("Fill the entropy bar below to enable Generate."));
    if (typed > n) text.push(t("Words after the first empty or unfinished box are not used."));
    status.set({ text: text.join(" "), color: ready ? GREEN : MUTED });
  };
  state.refresh();
  state.fields[0].ta.focus();
}

// --- a phrase you already have -------------------------------------------
//
// All the words typed, checked by dice39's importMnemonic: a bad checksum is
// refused (most likely a typo), never corrected. Nothing is generated and
// there is no entropy pad: this splits an existing key.

function showImport() {
  const T = state.total;
  state.mode = "import";
  state.refresh = null;   // the previous page's, if any: its widgets are gone
  page(t("Your {total}-word phrase", { total: T }));
  paragraph(ui.screen, S.importIntro(T), { color: MUTED });

  const grid = new ui.Container({ layout: "row-wrap", gap: 10, width: "100%" });
  const cellWidth = Math.max(180, Math.floor((ui.width - 40 - 20) / 3));
  state.fields = [];
  for (let i = 0; i < T; i++) state.fields.push(makeField(grid, i, cellWidth));

  const status = new ui.Label({ width: "100%", font: 14 });
  const buttons = buttonRow(ui.screen);
  const use = new ui.Button(buttons, {
    text: ui.symbols.ok + "  " + t("Use the phrase I typed"),
    disabled: true,
    onClick: () => onUseImport(status),
  });
  backButton(buttons);

  state.next = () => use;
  state.ready = () => countWords() === T;
  let seq = 0, logged = null;
  const log = (what) => {   // once per change: the outcome only, never a word
    if (what !== logged) console.log(`dice39: import check: ${what} (${T} words)`);
    logged = what;
  };
  state.refresh = () => {
    use.disabled = true;
    const n = countWords();
    const s = ++seq;
    if (n < T) {
      logged = null;
      return status.set({ text: S.importNeedAll(T, n), color: MUTED });
    }
    status.set({ text: t("Checking..."), color: MUTED });
    importMnemonic(BIP39_WORDS, state.fields.map((f) => f.word)).then((r) => {
      r.entropyBytes.fill(0);
      if (s !== seq || !status.alive) return;
      status.set({ text: ui.symbols.ok + " " + S.importChecksumOk(T), color: GREEN });
      use.disabled = false;
      log("checksum ok");
    }, (e) => {
      if (s !== seq || !status.alive) return;
      const typo = e && e.code === "CHECKSUM";
      status.set({
        text: ui.symbols.close + " " + (typo ? S.importChecksumBad(PHRASE_SIZES[T].checksumBits) : e.message),
        color: RED,
      });
      log(typo ? "checksum mismatch" : "refused");
    });
  };
  state.refresh();
  state.fields[0].ta.focus();
}

async function onUseImport(status) {
  const words = state.fields.map((f) => f.word);
  try {
    const r = await importMnemonic(BIP39_WORDS, words);
    r.typed = words;
    r.sorted = null;
    state.result = r;
    console.log(`dice39: imported a ${words.length}-word phrase`);
    showResults();
  } catch (e) {
    if (status.alive) status.set({ text: ui.symbols.close + " " + e.message, color: RED });
  }
}

// Back to the start, after asking if words were typed
function backButton(parent) {
  new ui.Button(parent, {
    text: t("Back"),
    onClick: async () => {
      if (countWords() === 0 || (await confirm(t("Discard the words you entered?"), t("Discard")))) showStart();
    },
  });
}

function countWords() {
  let n = 0;
  while (n < state.fields.length && state.fields[n].word) n++;
  return n;
}

function makeField(parent, i, width) {
  const cell = new ui.Container(parent, { layout: "column", gap: 2, width });
  const row = new ui.Container(cell, { layout: "row", alignItems: "center", gap: 6, width: "100%" });
  new ui.Label(row, { text: `${i + 1}.`, width: 28, textAlign: "right", color: MUTED, font: 14 });
  const ta = new ui.TextArea(row, {
    oneLine: true,
    grow: 1,
    maxLength: 14,
    // dice codes only for words that come off the dice
    accept: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ " +
      (state.mode === "dice" ? "0123456789-._," : ""),
  });
  const note = new ui.Container(cell, { layout: "row", gap: 6, width: "100%", minHeight: 20, alignItems: "center" });
  const f = { i, ta, note, word: null, dice: null };
  ta.onChange = () => updateField(f);
  ta.onSubmit = () => {
    // Enter on an empty box once there are enough words: go on to what
    // follows them (the entropy pad, Generate once the pad is full, or Use)
    if (!normalize(ta.text) && state.ready && state.ready()) return state.next().focus();
    complete(f);
    const next = state.fields[i + 1];
    if (next) next.ta.focus();
    else state.next().focus();
  };
  ta.onBlur = () => complete(f);
  return f;
}

function setNote(f, text, color) {
  f.note.clear();
  if (text) new ui.Label(f.note, { text, color: color || MUTED, font: 12, width: "100%", overflow: "dots" });
}

function completions(prefix) {
  const out = [];
  for (const w of BIP39_WORDS) {
    if (w.startsWith(prefix)) {
      out.push(w);
      if (out.length > 3) break;
    }
  }
  return out;
}

// Finishes a unique prefix ("aban" -> "abandon"): BIP-39 words are unique
// in their first four letters, so this never guesses.
function complete(f) {
  const raw = normalize(f.ta.text);
  if (!raw || f.word || /\d/.test(raw)) return;
  const c = completions(raw);
  if (c.length === 1) f.ta.text = c[0];
}

function updateField(f) {
  const raw = normalize(f.ta.text);

  if (f.dice && raw === f.dice.word) {
    // the word a dice code resolved to: keep showing the lookup
    f.word = raw;
    setNote(f, ui.symbols.ok + " " + t("Table {table}  {dice}",
      { table: f.dice.code.parity === 0 ? "A" : "B", dice: pairs(f.dice.code) }), GREEN);
    return state.refresh();
  }

  f.dice = null;
  f.word = null;

  if (!raw) {
    setNote(f, "");
  } else if (WORDS.has(raw)) {
    f.word = raw;
    setNote(f, ui.symbols.ok, GREEN);
  } else if (state.mode === "import") {
    completionNote(f, raw);
  } else {
    const code = parseDiceCode(raw);
    if (code && code.parity !== null) {
      const word = diceWordFor(code);
      if (!word) {
        setNote(f, ui.symbols.refresh + " " + S.reroll, AMBER);
      } else {
        f.dice = { word, code };
        f.ta.text = word;   // fires onChange again, which shows the lookup
        return;
      }
    } else if (code) {
      offerBothTables(f, code);
    } else if (isPartialDiceCode(raw) && /\d/.test(raw)) {
      setNote(f, t("dice code: table letter (optional), then four dice"));
    } else {
      completionNote(f, raw);
    }
  }
  state.refresh();
}

function completionNote(f, raw) {
  const c = completions(raw);
  if (c.length === 1) setNote(f, t("Enter: {word}", { word: c[0] }));
  else if (c.length > 1) setNote(f, c.length > 3 ? `${c.slice(0, 3).join(", ")}...` : c.join(", "));
  else setNote(f, ui.symbols.close + " " + t("not a BIP-39 word"), RED);
}

// Four dice name one cell on each table; the coin decides which. Never
// guess the coin: offer both words.
function offerBothTables(f, code) {
  f.note.clear();
  let any = false;
  for (const parity of [0, 1]) {
    const c = { ...code, parity };
    const word = diceWordFor(c);
    if (!word) continue;
    any = true;
    new ui.Button(f.note, {
      text: `${parity === 0 ? "A" : "B"} ${word}`,
      font: 12,
      padding: [2, 8],
      onClick: () => {
        f.dice = { word, code: c };
        f.ta.text = word;
        f.ta.focus();
      },
    });
  }
  if (!any) setNote(f, ui.symbols.refresh + " " + S.reroll, AMBER);
}

// --- generate -------------------------------------------------------------

async function onGenerate() {
  const n = countWords();
  const userWords = state.fields.slice(0, n).map((f) => f.word);
  try {
    const baseline = gkcrypto.randomBytes(32);
    // dice39 hashes the CSPRNG baseline with the pad samples; GapKeep adds
    // the key timings after them
    const seed = await sha256(concatBytes(baseline, samplesToBytes(state.pad.samples),
      samplesToBytes(state.samples)));
    const r = await buildMnemonic(BIP39_WORDS, userWords, seed, state.total);
    r.typed = userWords;
    r.sorted = r.patternSuspected === "identical" ? null : sortedPairsSuspected(userWords);
    state.result = r;
    console.log(`dice39: generated a ${state.total}-word phrase, ${r.userBits} bits from dice, ` +
      `${r.deviceBits} from the device`);
    showResults();
  } catch (e) {
    await ui.alert(String(e && e.message ? e.message : e), { title: t("Could not generate") });
  }
}

// --- results --------------------------------------------------------------

function showResults() {
  const r = state.result;
  const T = r.finalWords.length;
  const n = r.typed.length;
  const spec = PHRASE_SIZES[T];
  const head = page(t("Your {total}-word phrase", { total: T }));

  const legend = new ui.Container({ layout: "row", gap: 16 });
  if (r.imported) {
    new ui.Label(legend, { text: t("yours, as typed"), color: GREEN, font: 14 });
  } else {
    new ui.Label(legend, { text: t("from you (dice), verbatim"), color: GREEN, font: 14 });
    new ui.Label(legend, { text: t("from this device"), color: AMBER, font: 14 });
  }

  const cols = ui.width >= 900 ? 4 : 3;
  const tileWidth = Math.floor((ui.width - 40 - (cols - 1) * 8) / cols);
  const grid = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  r.finalWords.forEach((w, i) => {
    const tile = new ui.Panel(grid, {
      width: tileWidth, layout: "row", gap: 8, padding: [6, 10], alignItems: "center",
      borderColor: r.sourceTags[i] === "user" ? GREEN : AMBER, borderWidth: 1, scrollable: false,
    });
    new ui.Label(tile, { text: String(i + 1).padStart(2, " "), color: MUTED, font: 14, width: 24 });
    new ui.Label(tile, { text: w, color: r.sourceTags[i] === "user" ? GREEN : AMBER, font: 18 });
  });

  // Every word typed must come back unchanged, in its place. dice39 shows
  // the comparison word by word; here only a failure is shown, and loudly.
  const verbatim = n <= T && r.typed.every((w, i) => r.finalWords[i] === w);
  console.log("dice39: verbatim check " + (verbatim ? "ok" : "FAILED"));
  if (!verbatim) {
    const box = new ui.Panel({ width: "100%", layout: "column", padding: 10, borderColor: RED, borderWidth: 2 });
    new ui.Label(box, {
      text: ui.symbols.close + "  " + t("The words you typed did not all come back unchanged. Do not use this " +
        "phrase; this is a bug, please report it."), color: RED, width: "100%",
    });
  }

  // warnings first: they are why someone might start over
  if (r.imported) {
    if (r.importPatternSuspected) warning(ui.screen, S.importPattern(T));
  } else {
    if (r.patternSuspected === "identical") warning(ui.screen, S.patternIdentical(n));
    else if (r.patternSuspected === "ordered")
      warning(ui.screen, S.patternOrdered(n, r.patternDirection === "up"));
    if (r.coinSkipSuspected && r.patternSuspected !== "identical")
      warning(ui.screen, S.coinSkip(n, r.coinSkipTable, 2 ** (n - 1), 10 * n, 11 * n));
    if (r.sorted) warning(ui.screen, S.sortedPairs(n, r.sorted === "up", Math.round((144 / 49) ** n)));
  }

  if (r.imported) {
    paragraph(ui.screen, S.summaryImport(T, spec.entropyBits));
  } else {
    paragraph(ui.screen, t("Words 1 to {n}: yours, used verbatim, {userBits} bits. " +
      "Words {from} to {total}: from this device, {deviceBits} bits. " +
      "Total {ent} bits of entropy plus a {cs}-bit checksum in the last word, " +
      "which lets about 1 mistyped phrase in {space} through.", {
      n, userBits: r.userBits, from: n + 1, total: T, deviceBits: r.deviceBits,
      ent: spec.entropyBits, cs: spec.checksumBits, space: 2 ** spec.checksumBits,
    }));
    paragraph(ui.screen, S.deviceEntropy, { color: MUTED, font: 12 });
  }

  publicKeySection();

  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: t("QR codes"), onClick: showQR });
  new ui.Button(buttons, { text: t("Split into shares (codex32)"), onClick: showSplit });
  new ui.Button(buttons, {
    text: ui.symbols.trash + "  " + t("Start over"),
    onClick: async () => {
      if (await confirm(t("This erases the phrase from the screen and from this app."), t("Erase"), t("Start over"))) {
        wipe();
        showStart();
      }
    },
  });
  first.focus();
  // the words first, though the focus is further down (after the focus has
  // scrolled the page: a page scrolled down before stays so otherwise)
  setTimeout(() => head.alive && head.scrollIntoView(), 0);
}

// --- the account's public key ----------------------------------------------
//
// BIP-84 account m/84'/0'/N' as an output descriptor or a zpub (for
// Electrum): one QR code and its text, picked with a dropdown (two codes
// side by side don't fit 640 px), and the master fingerprint, from the words
// and the passphrase (lib/pubkey.js). Shown for account 0 and no passphrase
// at first; Enter in either box derives it again.

const KEY_FORMS = [
  { name: t("Descriptor"), what: t("Output descriptor: Sparrow, Bitcoin Core, and wallets that take one"),
    get: (k) => k.descriptor },
  { name: t("zpub (Electrum)"), what: t("zpub: Electrum, and wallets that take an extended public key"),
    get: (k) => k.zpub },
];

let keySeq = 0;

function publicKeySection() {
  new ui.Label({ text: S.pubkeyHeading, font: 18 });
  paragraph(ui.screen, S.pubkeyBody, { color: MUTED });
  const row = new ui.Container({ layout: "row-wrap", alignItems: "center", gap: 10, width: "100%" });
  new ui.Label(row, { text: t("Account") });
  const account = new ui.TextArea(row, {
    oneLine: true, width: 130, maxLength: 10, accept: "0123456789", text: String(state.account),
  });
  new ui.Label(row, { text: t("Passphrase") });
  const pass = new ui.TextArea(row, {
    oneLine: true, grow: 1, maxLength: 200, text: state.passphrase, password: !state.showPassphrase,
    placeholder: t("none", { $context: "passphrase" }),
  });
  const row2 = new ui.Container({ layout: "row-wrap", alignItems: "center", gap: 16, width: "100%" });
  const update = new ui.Button(row2, { text: ui.symbols.refresh + "  " + t("Update"), padding: [6, 14] });
  new ui.Checkbox(row2, {
    text: t("Show the passphrase"), checked: state.showPassphrase,
    onChange: (ev) => { state.showPassphrase = ev.value; pass.password = !ev.value; },
  });
  const formRow = new ui.Container(row2, { layout: "row", alignItems: "center", gap: 10 });
  new ui.Label(formRow, { text: t("QR code") });
  const form = new ui.Dropdown(formRow, {
    options: KEY_FORMS.map((f) => f.name), selected: state.keyForm, width: 240,
  });
  const note = paragraph(ui.screen, "", { font: 12 });
  const out = new ui.Container({ layout: "row", gap: 16, width: "100%", alignItems: "start" });

  // what is on screen is for the values it was derived from: say so when
  // the boxes no longer match
  const stale = () => {
    out.opacity = 0.3;
    note.set({ text: t("Changed: press Enter or Update to derive the key for these."), color: AMBER });
  };
  account.onChange = stale;
  pass.onChange = stale;

  let shown = null;   // the key on screen (public data only)
  const show = (k) => {
    out.clear();
    const f = KEY_FORMS[state.keyForm];
    const text = f.get(k);
    const size = Math.min(260, Math.floor((ui.width - 40) * 0.4));
    new ui.QRCode(out, { size, data: text, ecc: "M" });
    const side = new ui.Container(out, { layout: "column", gap: 6, grow: 1 });
    new ui.Label(side, { text: t("Master fingerprint: {fingerprint}", { fingerprint: k.fingerprint }),
      font: 18, width: "100%" });
    new ui.Label(side, { text: t("Account {path}, native segwit", { path: k.path }), font: 14, color: MUTED,
      width: "100%" });
    new ui.Label(side, { text: f.what, font: 12, color: MUTED, width: "100%" });
    new ui.Label(side, { text, font: 14, width: "100%", mono: true });
    // lengths only: the key identifies the wallet
    console.log(`dice39: key QR: ${state.keyForm === 0 ? "descriptor" : "zpub"} of ${text.length} characters`);
  };
  form.onChange = (ev) => {
    state.keyForm = ev.value;
    if (shown) show(shown);   // if stale, it stays dimmed
  };

  const derive = async () => {
    const text = account.text.trim();
    const number = text === "" ? NaN : Number(text);
    if (!Number.isInteger(number) || number > MAX_ACCOUNT) {
      out.clear();
      note.set({ text: ui.symbols.close + " " + t("An account number is 0 to {max}.", { max: MAX_ACCOUNT }),
        color: RED });
      return;
    }
    state.account = number;
    state.passphrase = pass.text;
    const seq = ++keySeq;
    out.clear();
    out.opacity = 1;
    shown = null;
    note.set({ text: t("Working: the BIP-39 seed takes 2048 rounds of PBKDF2..."), color: MUTED });
    await new Promise((resolve) => setTimeout(resolve, 30));   // draw that first
    if (seq !== keySeq || !out.alive || !state.result) return;
    let k;
    try {
      k = accountKey(state.result.finalWords, state.passphrase, number);
    } catch (e) {
      note.set({ text: ui.symbols.close + " " + (e && e.message ? e.message : e), color: RED });
      return;
    }
    shown = k;
    show(k);
    note.set({
      text: state.passphrase ? S.pubkeyPassphrase([...state.passphrase].length) : S.pubkeyNoPassphrase,
      color: state.passphrase ? AMBER : MUTED,
    });
    // lengths only: the key identifies the wallet
    console.log(`dice39: account key shown: zpub of ${k.zpub.length} characters, ` +
      `descriptor of ${k.descriptor.length}, ` +
      `${state.passphrase ? "with a" : "no"} passphrase`);
  };
  account.onSubmit = derive;
  pass.onSubmit = derive;
  update.onClick = derive;
  derive();
}

function wipe() {
  if (state.result && state.result.entropyBytes) state.result.entropyBytes.fill(0);
  state.result = null;
  state.fields = [];
  state.pad = null;
  state.samples = [];
  state.account = 0;
  state.passphrase = "";
  state.showPassphrase = false;
  state.keyForm = 0;
  state.split = null;
  sys.gc();
}

// --- QR export ------------------------------------------------------------

const QR_FORMATS = [
  { log: "SeedQR", name: "SeedQR", note: t("Each word's position in the BIP-39 list as four digits (SeedSigner's SeedQR)."),
    make: (r) => ({ data: seedQrDigits(r.finalWords), ecc: "L" }) },
  { log: "Compact SeedQR", name: "Compact SeedQR", note: t("The raw entropy bytes, checksum left off (SeedSigner's Compact SeedQR)."),
    make: (r) => ({ data: r.entropyBytes, ecc: "L" }) },
  { log: "Words", name: t("Words"), note: t("The words as text, separated by spaces."),
    make: (r) => ({ data: r.finalWords.join(" "), ecc: "M" }) },
];

async function showQR() {
  if (!(await confirm(S.qrWarning, t("Show QR codes"), t("Seed on screen")))) return;
  const r = state.result;
  page(t("QR codes"));
  const row = new ui.Container({ layout: "row", gap: 16, width: "100%", alignItems: "start" });
  const size = Math.min(ui.height - 110, Math.floor(ui.width / 2));
  const qr = new ui.QRCode(row, { size });
  const side = new ui.Container(row, { layout: "column", gap: 10, grow: 1 });
  const format = new ui.Dropdown(side, { options: QR_FORMATS.map((f) => f.name), width: "100%" });
  const info = new ui.Label(side, { width: "100%", font: 14 });
  const show = (i) => {
    const f = QR_FORMATS[i];
    qr.set(f.make(r));
    info.text = f.note + "\n" + t("{size}x{size} modules, error correction {ecc}.",
      { size: qr.modules, ecc: f.make(r).ecc });
    console.log(`dice39: QR ${f.log} ${qr.modules}x${qr.modules}`);
  };
  format.onChange = (ev) => show(ev.value);
  show(0);
  new ui.Button(side, { text: t("Done"), onClick: showResults });
  format.focus();
}

// --- codex32 shares -------------------------------------------------------

const SCHEMES = [[2, 3], [2, 4], [3, 5]];

function randomIdentifier() {
  // 4 symbols from the bech32 alphabet; 256 is a multiple of 32, so & 31 is uniform
  return Array.from(gkcrypto.randomBytes(4), (b) => CODEX32.CX_CHARSET[b & 31]).join("");
}

// The last split stays (state.split) while the phrase does: coming back
// from a share's QR code shows the same shares, not a new split.
function showSplit(focusShare) {
  page(t("Split into shares"));
  warning(ui.screen, [t("Shares hold your entropy, not a BIP-32 seed."), S.codex32Warning]);

  const last = state.split;
  const row = new ui.Container({ layout: "row-wrap", gap: 12, alignItems: "center", width: "100%" });
  new ui.Label(row, { text: t("Scheme") });
  const scheme = new ui.Dropdown(row, {
    options: SCHEMES.map(([k, n]) => t("{k} of {n}", { k, n })), width: 120, selected: last ? last.scheme : 0,
  });
  new ui.Label(row, { text: t("Identifier") });
  const id = new ui.TextArea(row, {
    oneLine: true, width: 100, maxLength: 4, text: last ? last.id : randomIdentifier(),
    accept: CODEX32.CX_CHARSET,
  });
  const out = new ui.Container({ layout: "column", gap: 6, width: "100%" });
  const buttons = buttonRow(ui.screen);

  const shareButtons = [];
  const list = (sp) => {
    const [k, n] = SCHEMES[sp.scheme];
    new ui.Label(out, {
      text: t("{k} of {n} shares. Any {k} recover the phrase; checked against {checked} combinations.",
        { k, n, checked: sp.checked }),
      color: GREEN, font: 14, width: "100%",
    });
    sp.shares.forEach((share, i) => {
      const line = new ui.Container(out, { layout: "row", gap: 8, alignItems: "center", width: "100%" });
      shareButtons.push(new ui.Button(line, { text: "QR", padding: [4, 10], onClick: () => showShareQR(i) }));
      new ui.Label(line, { text: share.toUpperCase(), font: 12, grow: 1, overflow: "wrap", mono: true });
    });
  };

  new ui.Button(buttons, {
    text: t("Split"),
    onClick: () => {
      out.clear();
      shareButtons.length = 0;
      state.split = null;
      const [k, n] = SCHEMES[scheme.selected];
      try {
        if (id.text.length !== 4) throw new Error(t("the identifier must be 4 characters"));
        const split = CODEX32.cxSplit(state.result.entropyBytes, k, n, id.text);
        state.split = { scheme: scheme.selected, id: id.text, shares: split.shares, checked: split.checked };
        list(state.split);
        console.log(`dice39: split ${k} of ${n}, self-check ${split.checked} subsets`);
      } catch (e) {
        new ui.Label(out, { text: ui.symbols.close + " " + e.message, color: RED, width: "100%" });
      }
    },
  });
  new ui.Button(buttons, { text: t("Done"), onClick: showResults });
  if (last) list(last);
  if (focusShare !== undefined && shareButtons[focusShare]) shareButtons[focusShare].focus();
  else scheme.focus();
}

// Straight to the code: a share alone reveals nothing. The page says what
// it is, and the one warning.
function showShareQR(i) {
  const sp = state.split;
  const [k, n] = SCHEMES[sp.scheme];
  const share = sp.shares[i].toUpperCase();
  page(t("Share {i} of {n}, any {k} recover the phrase", { i: i + 1, n, k }));
  const size = Math.min(ui.height - 200, ui.width - 40);
  // uppercase: canonical for codex32, and fits QR's compact alphanumeric mode
  const qr = new ui.QRCode({ size, data: share, ecc: "M" });
  new ui.Label({ text: share, font: 12, width: "100%", mono: true });
  paragraph(ui.screen, ui.symbols.warning + " " + S.shareQrWarning, { color: AMBER, font: 12 });
  console.log(`dice39: share QR ${qr.modules}x${qr.modules}`);
  new ui.Button({ text: t("Done"), onClick: () => showSplit(i) }).focus();
}

// --- about ----------------------------------------------------------------

function showAbout() {
  page(t("About"));
  paragraph(ui.screen, t(
    "This is dice39 running on GapKeep. You supply most of the words with dice and a coin; this device " +
    "supplies the rest and the checksum, and checks that every word you typed was kept as it was. Or you " +
    "type a phrase you already have, to split it into codex32 shares. Either way, it shows the account's " +
    "public key for a watch-only wallet."));
  paragraph(ui.screen, t(
    "The algorithm is dice39's own JavaScript, copied byte for byte from bip39_generator.html by " +
    "tools/extract_dice39.py. Each copied file names the source file and its SHA-256, so it can be " +
    "checked against the published page."), { color: MUTED });
  paragraph(ui.screen, t(
    "Different from the web page: there is no printing (print the dice tables from the web page on any " +
    "computer), no clipboard, and no network check, because this device has no network. The entropy pad " +
    "also takes Space presses, for use without a mouse, and your key timing is mixed in too. The public key " +
    "(BIP-84, a zpub) is GapKeep's, from the signer's BIP-39 and BIP-32 code: dice39's page has none."),
    { color: MUTED });
  paragraph(ui.screen, t("dice39 is licensed under the GNU AGPL v3. GapKeep {gapkeep}, QuickJS {quickjs}, " +
    "LVGL {lvgl}.", { gapkeep: sys.version.gapkeep, quickjs: sys.version.quickjs, lvgl: sys.version.lvgl }),
  { color: MUTED, font: 12 });
  new ui.Button({ text: t("Back"), onClick: showStart }).focus();
}

// --- start-up -------------------------------------------------------------

showStart();
runDice39SelfTest().then((st) => {
  state.selftest = st;
  console.log(`dice39 selftest: ${st.passed} passed, ${st.failed.length} failed`);
  for (const f of st.failed) console.log("dice39 selftest FAIL:", f);
  if (state.page === S.tagline) showStart();   // still on the start page: show the result
});
