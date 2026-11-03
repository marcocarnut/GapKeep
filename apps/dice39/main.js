// dice39 for zerogap: physical dice and a coin to a BIP-39 seed phrase.
//
// The algorithm is dice39's own code, copied verbatim into ./vendor by
// tools/extract_dice39.py; this file is only the user interface. See
// ./vendor/*.js for the provenance header (source file and its SHA-256).

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as zgcrypto from "zg:crypto";
import "./lib/cryptoshim.js";
import { BIP39_WORDS } from "./vendor/wordlist.js";
import { buildMnemonic, PHRASE_SIZES, concatBytes, sha256 } from "./vendor/bip39core.js";
import { CODEX32 } from "./vendor/codex32.js";
import {
  parseDiceCode, isPartialDiceCode, diceWordFor, sortedPairsSuspected,
  seedQrDigits, samplesToBytes,
} from "./vendor/dice.js";
import { runDice39SelfTest } from "./lib/selftest.js";
import { entropyBitsTarget, newPad, addPadSample } from "./lib/entropypad.js";
import { S } from "./lib/strings.js";

const GREEN = "#66bb6a", AMBER = "#ffb300", RED = "#ef5350", MUTED = "#8a9199";
const WORDS = new Set(BIP39_WORDS);

const state = {
  total: 24,          // phrase length
  fields: [],         // word entry boxes
  samples: [],        // key timings, mixed into the device entropy
  pad: null,          // entropy pad: { samples, bits, last, lastTime }
  result: null,       // buildMnemonic output + extras
  selftest: null,     // { passed, failed }
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
    label.text = `${S.bitsLabel(bits, target)}   ${Math.round(bits / target * 100)}%`;
    if (bits >= target && !state.pad.announced) {
      state.pad.announced = true;   // counts only: never log what was sampled
      console.log(`dice39: entropy pad full: ${state.pad.samples.length} samples, ${state.pad.bits} bits`);
    }
    onUpdate();
  };
  pad.onPress = (ev) => { if (addPadSample(state.pad, ev, "tap")) update(); };
  pad.onDrag = (ev) => { if (addPadSample(state.pad, ev, "drag")) update(); };
  update();
  return pad;
}

// --- helpers --------------------------------------------------------------

const normalize = (w) => (w || "").trim().toLowerCase();
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
  return (await ui.alert(text, { title, buttons: ["Cancel", yes] })) === 1;
}

// --- start ----------------------------------------------------------------

function showStart() {
  state.result = null;
  page(S.tagline);

  paragraph(ui.screen, S.need);
  paragraph(ui.screen, S.procedure, { color: MUTED });
  paragraph(ui.screen, S.order, { color: MUTED });

  const row = new ui.Container({ layout: "row", alignItems: "center", gap: 12 });
  new ui.Label(row, { text: "Phrase length" });
  const len = new ui.Dropdown(row, {
    options: ["24 words (recommended)", "12 words"],
    selected: state.total === 24 ? 0 : 1,
    width: 300,
    onChange: (ev) => {
      state.total = ev.value === 0 ? 24 : 12;
    },
  });
  paragraph(ui.screen, S.lenNote, { color: MUTED, font: 12 });

  const buttons = buttonRow(ui.screen);
  const start = new ui.Button(buttons, {
    text: ui.symbols.right + "  Enter my dice words",
    onClick: () => showEntry(),
  });
  new ui.Button(buttons, { text: "About", onClick: showAbout });

  // No phrase is made before the self-test has passed: Enter stays disabled
  // until it has, and the page is redrawn when it finishes.
  const st = state.selftest;
  start.disabled = !st || st.failed.length > 0;
  if (!st) {
    paragraph(ui.screen, "Self-test running...", { color: MUTED, font: 12 });
  } else if (st.failed.length === 0) {
    paragraph(ui.screen, `${ui.symbols.ok} Self-test passed (${st.passed} checks: BIP-39 and codex32 test vectors, ` +
      "dice tables, round trips).", { color: GREEN, font: 12 });
  } else {
    paragraph(ui.screen, `${ui.symbols.close} Self-test FAILED. Do not use this device to make a seed.\n` +
      st.failed.join("\n"), { color: RED });
  }
  (st && st.failed.length === 0 ? start : len).focus();
}

// --- word entry -----------------------------------------------------------

function showEntry() {
  const spec = PHRASE_SIZES[state.total];
  page(`Words 1 to ${spec.maxUser} of ${state.total}`);
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
  state.padWidget = pad;
  const buttons = buttonRow(ui.screen);
  const generate = new ui.Button(buttons, {
    text: ui.symbols.ok + "  Generate",
    disabled: true,
    onClick: () => onGenerate(),
  });
  new ui.Button(buttons, {
    text: "Back",
    onClick: async () => {
      if (countWords() === 0 || (await confirm("Discard the words you entered?", "Discard"))) showStart();
    },
  });

  state.generateButton = generate;
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
    let text = `${n} word${n === 1 ? "" : "s"} entered (${spec.minUser} to ${spec.maxUser}).`;
    if (ready) text += ` Words ${n + 1} to ${state.total} will come from this device.`;
    else text += ` Enter at least ${spec.minUser - n} more.`;
    if (ready && !state.padFull()) text += " Fill the entropy bar below to enable Generate.";
    if (typed > n) text += " Words after the first empty or unfinished box are not used.";
    status.set({ text, color: ready ? GREEN : MUTED });
  };
  state.refresh();
  state.fields[0].ta.focus();
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
    accept: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -._,",
  });
  const note = new ui.Container(cell, { layout: "row", gap: 6, width: "100%", minHeight: 20, alignItems: "center" });
  const f = { i, ta, note, word: null, dice: null };
  ta.onChange = () => updateField(f);
  ta.onSubmit = () => {
    // Enter on an empty box once there are enough words: go on to the
    // entropy pad, or to Generate once the pad is full
    if (!normalize(ta.text) && state.ready && state.ready()) return nextAfterWords().focus();
    complete(f);
    const next = state.fields[i + 1];
    if (next) next.ta.focus();
    else if (state.generateButton) nextAfterWords().focus();
  };
  ta.onBlur = () => complete(f);
  return f;
}

function nextAfterWords() {
  return state.padFull() ? state.generateButton : state.padWidget;
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
    setNote(f, `${ui.symbols.ok} Table ${f.dice.code.parity === 0 ? "A" : "B"}  ${pairs(f.dice.code)}`, GREEN);
    return state.refresh();
  }

  f.dice = null;
  f.word = null;

  if (!raw) {
    setNote(f, "");
  } else if (WORDS.has(raw)) {
    f.word = raw;
    setNote(f, ui.symbols.ok, GREEN);
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
      setNote(f, "dice code: table letter (optional), then four dice");
    } else {
      const c = completions(raw);
      if (c.length === 1) setNote(f, `Enter: ${c[0]}`);
      else if (c.length > 1) setNote(f, c.length > 3 ? `${c.slice(0, 3).join(", ")}...` : c.join(", "));
      else setNote(f, ui.symbols.close + " not a BIP-39 word", RED);
    }
  }
  state.refresh();
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
    const baseline = zgcrypto.randomBytes(32);
    // dice39 hashes the CSPRNG baseline with the pad samples; zerogap adds
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
    await ui.alert(String(e && e.message ? e.message : e), { title: "Could not generate" });
  }
}

// --- results --------------------------------------------------------------

function showResults() {
  const r = state.result;
  const T = r.finalWords.length;
  const n = r.typed.length;
  const spec = PHRASE_SIZES[T];
  page(`Your ${T}-word phrase`);

  const legend = new ui.Container({ layout: "row", gap: 16 });
  new ui.Label(legend, { text: "from you (dice), verbatim", color: GREEN, font: 14 });
  new ui.Label(legend, { text: "from this device", color: AMBER, font: 14 });

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

  // warnings first: they are why someone might start over
  if (r.patternSuspected === "identical") warning(ui.screen, S.patternIdentical(n));
  else if (r.patternSuspected === "ordered")
    warning(ui.screen, S.patternOrdered(n, r.patternDirection === "up" ? "ascending" : "descending"));
  if (r.coinSkipSuspected && r.patternSuspected !== "identical")
    warning(ui.screen, S.coinSkip(n, r.coinSkipTable, group(2 ** (n - 1)), 10 * n, 11 * n));
  if (r.sorted)
    warning(ui.screen, S.sortedPairs(n, r.sorted === "up" ? "lowest-first" : "highest-first",
      group(Math.round((144 / 49) ** n))));

  paragraph(ui.screen,
    `Words 1 to ${n}: yours, used verbatim, ${r.userBits} bits. ` +
    `Words ${n + 1} to ${T}: from this device, ${r.deviceBits} bits. ` +
    `Total ${spec.entropyBits} bits of entropy plus a ${spec.checksumBits}-bit checksum in the last word, ` +
    `which lets about 1 mistyped phrase in ${2 ** spec.checksumBits} through.`);
  paragraph(ui.screen, S.deviceEntropy, { color: MUTED, font: 12 });

  // proof that nothing typed was changed
  const check = new ui.Panel({ width: "100%", layout: "column", gap: 2, padding: 10 });
  new ui.Label(check, { text: "Your typed words reappear unchanged", font: 14 });
  let allOk = true;
  r.typed.forEach((typed, i) => {
    const ok = r.finalWords[i] === typed;
    allOk = allOk && ok;
    new ui.Label(check, {
      text: `${i + 1}. you typed "${typed}"  ${ui.symbols.right}  output "${r.finalWords[i]}"  ` +
        (ok ? ui.symbols.ok : ui.symbols.close + " MISMATCH: do not use this, report a bug"),
      color: ok ? GREEN : RED, font: 12, width: "100%",
    });
  });
  console.log("dice39: verbatim check " + (allOk ? "ok" : "FAILED"));

  const buttons = buttonRow(ui.screen);
  const first = new ui.Button(buttons, { text: "QR codes", onClick: showQR });
  new ui.Button(buttons, { text: "Split into shares (codex32)", onClick: showSplit });
  new ui.Button(buttons, {
    text: ui.symbols.trash + "  Start over",
    onClick: async () => {
      if (await confirm("This erases the phrase from the screen and from this app.", "Erase", "Start over")) {
        wipe();
        showStart();
      }
    },
  });
  first.focus();
}

function wipe() {
  if (state.result && state.result.entropyBytes) state.result.entropyBytes.fill(0);
  state.result = null;
  state.fields = [];
  state.pad = null;
  state.samples = [];
  sys.gc();
}

// --- QR export ------------------------------------------------------------

const QR_FORMATS = [
  { name: "SeedQR", note: "Each word's position in the BIP-39 list as four digits (SeedSigner's SeedQR).",
    make: (r) => ({ data: seedQrDigits(r.finalWords), ecc: "L" }) },
  { name: "Compact SeedQR", note: "The raw entropy bytes, checksum left off (SeedSigner's Compact SeedQR).",
    make: (r) => ({ data: r.entropyBytes, ecc: "L" }) },
  { name: "Words", note: "The words as text, separated by spaces.",
    make: (r) => ({ data: r.finalWords.join(" "), ecc: "M" }) },
];

async function showQR() {
  if (!(await confirm(S.qrWarning, "Show QR codes", "Seed on screen"))) return;
  const r = state.result;
  page("QR codes");
  const row = new ui.Container({ layout: "row", gap: 16, width: "100%", alignItems: "start" });
  const size = Math.min(ui.height - 110, Math.floor(ui.width / 2));
  const qr = new ui.QRCode(row, { size });
  const side = new ui.Container(row, { layout: "column", gap: 10, grow: 1 });
  const format = new ui.Dropdown(side, { options: QR_FORMATS.map((f) => f.name), width: "100%" });
  const info = new ui.Label(side, { width: "100%", font: 14 });
  const show = (i) => {
    const f = QR_FORMATS[i];
    qr.set(f.make(r));
    info.text = `${f.note}\n${qr.modules}x${qr.modules} modules, error correction ${f.make(r).ecc}.`;
    console.log(`dice39: QR ${f.name} ${qr.modules}x${qr.modules}`);
  };
  format.onChange = (ev) => show(ev.value);
  show(0);
  new ui.Button(side, { text: "Done", onClick: showResults });
  format.focus();
}

// --- codex32 shares -------------------------------------------------------

const SCHEMES = [[2, 3], [2, 4], [3, 5]];

function randomIdentifier() {
  // 4 symbols from the bech32 alphabet; 256 is a multiple of 32, so & 31 is uniform
  return Array.from(zgcrypto.randomBytes(4), (b) => CODEX32.CX_CHARSET[b & 31]).join("");
}

function showSplit() {
  page("Split into shares");
  warning(ui.screen, ["Shares hold your entropy, not a BIP-32 seed.", S.codex32Warning]);

  const row = new ui.Container({ layout: "row-wrap", gap: 12, alignItems: "center", width: "100%" });
  new ui.Label(row, { text: "Scheme" });
  const scheme = new ui.Dropdown(row, { options: SCHEMES.map(([k, n]) => `${k} of ${n}`), width: 120 });
  new ui.Label(row, { text: "Identifier" });
  const id = new ui.TextArea(row, {
    oneLine: true, width: 100, maxLength: 4, text: randomIdentifier(),
    accept: CODEX32.CX_CHARSET,
  });
  const out = new ui.Container({ layout: "column", gap: 6, width: "100%" });
  const buttons = buttonRow(ui.screen);
  new ui.Button(buttons, {
    text: "Split",
    onClick: () => {
      out.clear();
      const [k, n] = SCHEMES[scheme.selected];
      try {
        if (id.text.length !== 4) throw new Error("the identifier must be 4 characters");
        const split = CODEX32.cxSplit(state.result.entropyBytes, k, n, id.text);
        new ui.Label(out, {
          text: `${k} of ${n} shares. Any ${k} recover the phrase; checked against ${split.checked} combinations.`,
          color: GREEN, font: 14, width: "100%",
        });
        split.shares.forEach((share, i) => {
          const line = new ui.Container(out, { layout: "row", gap: 8, alignItems: "center", width: "100%" });
          new ui.Button(line, { text: "QR", padding: [4, 10], onClick: () => showShareQR(share, i, k, n) });
          new ui.Label(line, { text: share.toUpperCase(), font: 12, grow: 1, overflow: "wrap" });
        });
        console.log(`dice39: split ${k} of ${n}, self-check ${split.checked} subsets`);
      } catch (e) {
        new ui.Label(out, { text: ui.symbols.close + " " + e.message, color: RED, width: "100%" });
      }
    },
  });
  new ui.Button(buttons, { text: "Done", onClick: showResults });
  scheme.focus();
}

async function showShareQR(share, i, k, n) {
  const back = await ui.alert(`Share ${i + 1} of ${n} (any ${k} recover the phrase).`, {
    title: "Show this share as a QR code?",
    buttons: ["Cancel", "Show"],
  });
  if (back !== 1) return;
  page(`Share ${i + 1} of ${n}`);
  const size = Math.min(ui.height - 140, ui.width - 40);
  // uppercase: canonical for codex32, and fits QR's compact alphanumeric mode
  const qr = new ui.QRCode({ size, data: share.toUpperCase(), ecc: "M" });
  new ui.Label({ text: share.toUpperCase(), font: 12, width: "100%" });
  console.log(`dice39: share QR ${qr.modules}x${qr.modules}`);
  new ui.Button({ text: "Done", onClick: showSplit }).focus();
}

// --- about ----------------------------------------------------------------

function showAbout() {
  page("About");
  paragraph(ui.screen,
    "This is dice39 running on zerogap. You supply most of the words with dice and a coin; this device " +
    "supplies the rest and the checksum, and shows you that every word you typed was kept as it was.");
  paragraph(ui.screen,
    "The algorithm is dice39's own JavaScript, copied byte for byte from bip39_generator.html by " +
    "tools/extract_dice39.py. Each copied file names the source file and its SHA-256, so it can be " +
    "checked against the published page.", { color: MUTED });
  paragraph(ui.screen,
    "Different from the web page: there is no printing (print the dice tables from the web page on any " +
    "computer), no clipboard, and no network check, because this device has no network. The entropy pad " +
    "also takes Space presses, for use without a mouse, and your key timing is mixed in too.", { color: MUTED });
  paragraph(ui.screen, `dice39 is licensed under the GNU AGPL v3. zerogap ${sys.version.zerogap}, ` +
    `QuickJS ${sys.version.quickjs}, LVGL ${sys.version.lvgl}.`, { color: MUTED, font: 12 });
  new ui.Button({ text: "Back", onClick: showStart }).focus();
}

// --- start-up -------------------------------------------------------------

showStart();
runDice39SelfTest().then((st) => {
  state.selftest = st;
  console.log(`dice39 selftest: ${st.passed} passed, ${st.failed.length} failed`);
  for (const f of st.failed) console.log("dice39 selftest FAIL:", f);
  if (state.page === S.tagline) showStart();   // still on the start page: show the result
});
