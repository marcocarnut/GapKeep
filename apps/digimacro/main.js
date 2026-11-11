// DigiMacro: configures a DigiMacro board (a morse-tapped macro keyboard on
// a Digispark) plugged into GapKeep, as its web page does: the macros, the
// power-on macro, the password, the lockout, the board's clock for {totp},
// and the hardened-mode checklist. TOTP keys come from QR codes: an
// authenticator's otpauth://totp/... or Google Authenticator's export.
//
// Experimental (docs/EXPERIMENTAL.md): GapKeep claims the board whole while
// this app is installed (gk:usb, docs/APPS.md "USB devices"), so its
// keyboard types nothing here.
//
// The board's protocol and the macro encoder are DigiMacroAsm's own code
// (vendor/, copied by tools/extract_digimacro.py); lib/board.js and
// lib/macros.js build on them. See README.md.
//
// Secrets: the password, imported TOTP keys and the {totp} keys read from
// the board are in RAM only, never on screen (a key shows as {totp #N} or
// {totp ~N}) and never in the log. Imported keys are wiped once written to
// the board, the password when the board is unplugged; everything when the
// app ends (GapKeep zeroes freed memory). The log says what happened by
// counts and lengths.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as usb from "gk:usb";
import * as clock from "gk:clock";
import * as session from "gk:session";
import { t, plural, formatDateTime, keyboard } from "gk:i18n";
import {
  Board, Refused, usbIo, wantsPassword, hardening, parseLock, lockBytes, serialText, utf8Bytes,
  ST_OPEN, ST_PASSWORD, ST_SOFTLOCK, ST_HARDLOCK, ST_KEY, FW_TOTP, PASSWORD_MAX,
  CHECK_ADDR, SERIAL_ADDR, LOCK_ADDR, LOCK_LEN, KEY_WAIT_ADDR, AUTO_ADDR, AUTO_NONE,
} from "./lib/board.js";
import { Macros, MacroError, totpFits, TABLE_TOP, LAYOUTS, layoutLabel, setLayout, getLayout, setMessages } from "./lib/macros.js";
import { encoderMessage, hardeningLine } from "./lib/messages.js";
import { parseCode, ParseError, Message } from "./lib/parse.js";

setMessages(encoderMessage);

const MUTED = "#8a9199", RED = "#ef5350", AMBER = "#ffb300", GREEN = "#66bb6a";
const wide = ui.width >= 1000;
const N_ = (s) => s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex2 = (v) => "0x" + v.toString(16).toUpperCase().padStart(2, "0");

// A message of lib/parse.js or lib/macros.js (English with {names}), in the language
function explain(e) {
  if (e instanceof Message || e instanceof ParseError || e instanceof MacroError) {
    const params = {};
    for (const [k, v] of Object.entries(e.params)) params[k] = v instanceof Message ? explain(v) : v;
    return t(e.key, params);
  }
  return e && e.message ? e.message : String(e);
}

// --- state ----------------------------------------------------------------------

const S = {
  handle: null,         // gk:usb's handle on the board
  device: null,         // its id
  board: null,          // lib/board.js
  info: null,           // what INFO said last
  stage: "none",        // "none", "gate", "board"
  password: null,       // given, and right, while the board is plugged in
  busy: false,
  macros: new Macros(),
  saved: null,          // the table's bytes as on the board (snapshot())
  savedAuto: AUTO_NONE, // the power-on macro's header as on the board
  auto: AUTO_NONE,
  serial: "",
  check: null,          // the secrets' key's check value (8 bytes)
  lock: null,           // lib/board.js's parseLock()
  imported: [],         // { n, issuer, name, algorithm, digits, period, fits }: never the key
  nextAccount: 1,
  batches: new Map(),   // an export in parts: id -> { size, seen }
  page: null,
  notice: null,         // { text, color }: what the last action did
};

// The computer's keyboard layout, which the macros are typed for: kept for
// the session; at first, GapKeep's own
const KEPT = session.get("layout");
setLayout(typeof KEPT === "string" && LAYOUTS.includes(KEPT) ? KEPT : keyboard() === "br-abnt2" ? "abnt2" : "us");

// --- the board ------------------------------------------------------------------

async function connect(device) {
  if (S.handle) return;
  try {
    S.handle = usb.open(device);
  } catch (e) {
    console.log(`digimacro: cannot open device ${device.id}: ${e.message}`);
    return;
  }
  S.device = device.id;
  S.board = new Board(usbIo(S.handle));
  console.log(`digimacro: device ${device.id} plugged in (${device.speed} speed)`);
  try {
    const info = await S.board.info();
    S.info = info;
    if (!info.magic) {
      console.log("digimacro: not a DigiMacro (INFO says otherwise)");
      notice(t("This device does not answer as a DigiMacro does."), RED);
      showWaiting();
      return;
    }
    console.log(`digimacro: connected: firmware ${info.firmware}, protocol ${info.protocol}, state ${hex2(info.state)}`);
    if (info.bare) {
      notice(t("This board has its core only, no firmware: install it with DigiMacro's own page."), AMBER);
      showWaiting();
      return;
    }
    S.stage = "gate";
    showGate();
    gate();
  } catch (e) {
    console.log(`digimacro: INFO failed: ${e.code || e.message}`);
    notice(t("The board did not answer: {why}", { why: e.code || e.message }), RED);
    showWaiting();
  }
}

function disconnected() {
  if (S.handle) {
    try {
      S.handle.close();
    } catch (e) { /* gone */ }
  }
  S.handle = S.board = S.info = null;
  S.device = null;
  S.password = null;            // the next plug-in asks again
  S.stage = "none";
  S.saved = null;
  S.macros = new Macros();
  S.macros.accounts = importedKeys;
  showWaiting();
}

usb.onAttach((d) => {
  if (!S.handle) connect(d);
});
usb.onDetach((d) => {
  if (d.id !== S.device) return;
  console.log(`digimacro: device ${d.id} unplugged`);
  notice(t("The board was unplugged. What was not written to it is lost."), AMBER);
  disconnected();
});

// The password once the window is open: true if the board took it. A wrong
// one is forgotten, so it is never tried twice and never counted twice.
async function tryUnlock() {
  const hard = !!(S.info.state & ST_HARDLOCK);
  if (await S.board.unlock(S.password)) {
    S.info = await S.board.info();
    console.log(`digimacro: unlocked${hard ? ", hard lock lifted" : ""}`);
    return true;
  }
  S.info = await S.board.info();
  if (S.info.state & ST_OPEN) {         // the window was open: the password was wrong
    S.password = null;
    console.log("digimacro: wrong password");
    notice(t("Wrong password."), RED);
  }
  return false;
}

// Waits for the hold, and the password if there is one, then reads the board.
async function gate() {
  const me = S.device;
  while (S.device === me && S.stage === "gate") {
    try {
      S.info = await S.board.info();
      drawGate();
      const s = S.info.state;
      if (s & ST_OPEN) {
        // asked, and tried once, even if the board is unlocked already
        // (replugged quickly, or by another program): the app needs it to
        // unlock again when the window lapses, and a wrong one kept would
        // only fail then
        const has = !!(s & ST_PASSWORD);
        if (!has || (S.password !== null && (await tryUnlock()))) {
          await enterBoard();
          return;
        }
        drawGate();
      }
    } catch (e) {
      if (S.device !== me) return;
      notice(explain(e), RED);
    }
    await sleep(400);
  }
}

// Everything the board holds that the app shows
async function enterBoard() {
  S.stage = "board";
  showHome();
  notice(t("Reading the board..."), MUTED);
  await readAll();
  showHome();
}

async function readAll() {
  const b = S.board;
  S.serial = serialText(await b.read(SERIAL_ADDR, 4));
  S.check = await b.read(CHECK_ADDR, 8);
  const ee = new Uint8Array(CHECK_ADDR + 8).fill(0xff);
  ee.set(await b.read(0, TABLE_TOP), 0);
  ee.set(S.check, CHECK_ADDR);
  const accounts = S.macros.accounts;
  S.macros = new Macros();
  S.macros.accounts = accounts;
  const n = S.macros.load(ee);
  ee.fill(0);
  S.auto = S.savedAuto = (await b.read(AUTO_ADDR, 1))[0];
  S.lock = parseLock(await b.read(LOCK_ADDR, LOCK_LEN));
  S.keyWait = (await b.read(KEY_WAIT_ADDR, 1))[0];
  S.saved = S.macros.snapshot() ?? "unwritable";
  S.info = await b.info();
  console.log(`digimacro: read ${n} macro(s), ${S.macros.blobs.length} {totp} key(s), serial of ${S.serial.length} digits`);
  notice(n ? plural(n, "Read {n} macro from the board.", "Read {n} macros from the board.")
           : t("The board holds no macros yet."), GREEN);
}

// What every action does first: the window, waited for if it has lapsed,
// and the password given again if the board wants it.
async function access() {
  let s = (S.info = await S.board.info()).state;
  if (!(s & ST_OPEN)) {
    notice(t("Hold the pad for four seconds: the board lets changes in only while its window is open."), AMBER);
    console.log("digimacro: waiting for the hold");
    const until = Date.now() + 60000;
    while (!(s & ST_OPEN)) {
      if (Date.now() > until) throw new Error(t("Nobody held the pad: try again."));
      await sleep(400);
      if (!S.board) throw new Error(t("The board was unplugged."));
      s = (S.info = await S.board.info()).state;
    }
    console.log("digimacro: the window is open");
  }
  if (!wantsPassword(s)) return;
  if (S.password !== null && (await tryUnlock())) return;
  throw new Error(t("The board wants its password again: it was changed elsewhere, or is wrong."));
}

// One action at a time, the window and password first, and what happens said
async function run(what, fn) {
  if (S.busy || !S.board) return;
  S.busy = true;
  drawBusy();
  try {
    await access();
    await fn();
  } catch (e) {
    console.log(`digimacro: ${what} failed: ${e.refused ? "refused" : e.code || (e.mismatch ? "mismatch" : "error")}`);
    notice(e.refused ? t("The board said no: hold the pad again, and check the password.")
         : e.mismatch ? t("Written, but the board reads back something else at {at}: write again.", { at: e.mismatch.at })
         : explain(e), RED);
  } finally {
    S.busy = false;
    redraw();
  }
}

// --- pages -----------------------------------------------------------------------

let page = {};

function newPage(name) {
  if (S.page !== name) S.notice = null;      // what was said on another page
  S.page = name;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [24, 32] : [12, 16], gap: wide ? 12 : 8 });
  page = { name };
  const head = new ui.Container({ layout: "row", width: "100%", alignItems: "center", gap: 12 });
  new ui.Label(head, { text: t("DigiMacro"), font: wide ? 32 : 24, grow: 1 });
  page.who = new ui.Label(head, { text: whoText(), color: MUTED, font: 14 });
  page.notice = new ui.Label({ text: "", width: "100%", hidden: true });
  drawNotice();
}

function whoText() {
  if (!S.info || S.stage === "none") return "";
  const parts = [t("firmware {fw}", { fw: S.info.firmware })];
  if (S.serial) parts.push(t("serial {serial}", { serial: S.serial }));
  return parts.join(" · ");
}

function notice(text, color) {
  S.notice = { text, color };
  drawNotice();
}

function drawNotice() {
  if (!page.notice) return;
  const n = S.notice;
  page.notice.set({ text: n ? n.text : "", color: n ? n.color : MUTED, hidden: !n || !n.text });
}

function drawBusy() {
  for (const b of page.actions || []) b.disabled = true;
}

function redraw() {
  if (S.page === "macros") showMacros(page.focusRow);
  else if (S.page === "home") showHome();
  else if (S.page === "security") showSecurity();
  else if (S.page === "clock") showClock();
  else if (S.page === "accounts") showAccounts();
}

function backButton(parent) {
  return new ui.Button(parent, { text: t("Back"), onClick: () => showHome() });
}

ui.onKey((ev) => {
  if (ev.key === "Escape" && S.stage === "board" && S.page !== "home" && S.page !== "scan") {
    showHome();
    return true;
  }
  if (ev.key === "Escape" && S.page === "scan") {
    showAccounts();
    return true;
  }
  return false;
});

// No board yet
function showWaiting() {
  newPage("waiting");
  new ui.Label({ text: t("Plug in your DigiMacro."), font: 22 });
  new ui.Label({
    width: "100%", color: MUTED,
    text: t("Use a USB hub if the keyboard needs the only port. While this app is installed, GapKeep keeps the board to itself: its keys type nothing here."),
  });
  page.actions = [];
  const keys = new ui.Button({ text: t("Authenticator keys ({n} imported)", { n: S.imported.length }), onClick: () => showAccounts() });
  keys.focus();
}

// Plugged in, not in yet: the hold and the password
function showGate() {
  newPage("gate");
  page.msg = new ui.Label({ text: "", font: 20, width: "100%" });
  page.lock = new ui.Label({ text: "", width: "100%", color: RED, hidden: true });
  page.passRow = new ui.Container({ layout: "row", gap: 8, alignItems: "center", hidden: true });
  new ui.Label(page.passRow, { text: t("Password:") });
  page.pass = new ui.TextArea(page.passRow, {
    oneLine: true, password: true, width: 280, placeholder: t("the board's password"),
    onSubmit: ({ value }) => givePassword(value),
  });
  new ui.Button(page.passRow, { text: t("Unlock"), onClick: () => givePassword(page.pass.text) });
  drawGate();
}

function givePassword(v) {
  if (!v) {
    notice(t("Type the password first."), RED);
    return;
  }
  if (utf8Bytes(v).length > PASSWORD_MAX) {
    notice(t("A password is at most 12 bytes: an accented letter takes two."), RED);
    return;
  }
  S.password = v;
  page.pass.text = "";
  notice(S.info && S.info.state & ST_OPEN ? t("Unlocking...") : t("Now hold the pad for four seconds."), AMBER);
  drawGate();
}

function drawGate() {
  if (S.page !== "gate" || !S.info) return;
  const s = S.info.state, has = !!(s & ST_PASSWORD), open = !!(s & ST_OPEN);
  page.msg.text = !open ? (has ? t("Hold the pad for four seconds, and type the board's password.") : t("Hold the pad for four seconds."))
                : has && S.password === null ? t("Type the board's password, and press Enter.")
                : t("Reading the board...");
  page.lock.set({
    hidden: !(s & (ST_SOFTLOCK | ST_HARDLOCK)),
    text: s & ST_HARDLOCK ? t("The board is locked hard and ignores every tap: hold the pad and give the password to lift it.")
        : t("The board is pausing after too many wrong codes, and ignores taps until the pause is over."),
  });
  const show = has && S.password === null;
  if (page.passRow.hidden !== !show) {
    page.passRow.hidden = !show;
    if (show) page.pass.focus();
  }
}

// In: the menu
function showHome() {
  if (S.stage !== "board") {
    if (S.stage === "gate") showGate();
    else showWaiting();
    return;
  }
  newPage("home");
  const s = S.info.state;
  const status = [
    s & ST_PASSWORD ? t("A password is set.") : t("No password."),
    S.lock && S.lock.on ? t("The lockout is on.") : t("No lockout."),
    S.check && S.check.some((b) => b !== 0xff) ? (s & ST_KEY ? t("A key for secrets is set, and held now.") : t("A key for secrets is set."))
                                               : t("No key for secrets."),
  ];
  new ui.Label({ text: status.join(" "), width: "100%", color: MUTED });
  const pending = S.macros.snapshot() !== S.saved;
  const items = [
    [pending ? t("Macros (not written yet)") : t("Macros"), () => showMacros()],
    [t("Authenticator keys ({n} imported)", { n: S.imported.length }), () => showAccounts()],
    [t("Password and lockout"), () => showSecurity()],
    [t("The board's clock"), () => showClock()],
    [t("Hardened mode"), () => showHardening()],
  ];
  page.actions = [];
  let first = null;
  for (const [text, fn] of items) {
    const b = new ui.Button({ text, width: wide ? 520 : "100%", onClick: fn });
    first = first || b;
  }
  first.focus();
}

// --- macros -----------------------------------------------------------------------

function showMacros(focusRow = null) {
  newPage("macros");
  page.focusRow = focusRow;
  const m = S.macros;
  const top = new ui.Container({ layout: "row-wrap", width: "100%", gap: 10, alignItems: "center" });
  new ui.Label(top, { text: t("The computer's keyboard:") });
  const layouts = LAYOUTS;
  new ui.Dropdown(top, {
    options: layouts.map(layoutLabel), selected: layouts.indexOf(getLayout()),
    onChange: ({ value }) => {
      setLayout(layouts[value]);
      session.set("layout", layouts[value]);
      showMacros();
    },
  });
  page.budget = new ui.Label(top, { text: "" });
  page.tableError = new ui.Label({ text: "", color: RED, width: "100%", hidden: true });

  page.rows = [];
  m.rows.forEach((r, i) => {
    const row = new ui.Container({ layout: "row", width: "100%", gap: 8, alignItems: "center" });
    const code = new ui.TextArea(row, {
      oneLine: true, text: r.code, width: wide ? 140 : 90, maxLength: 8, accept: ".-irIR0123456789",
      onChange: ({ value }) => {
        r.code = value;
        soon();
      },
    });
    const text = new ui.TextArea(row, {
      oneLine: true, text: r.text, grow: 1, placeholder: t("what this code types"),
      onChange: ({ value }) => {
        r.text = value;
        soon();
      },
    });
    new ui.Button(row, {
      text: ui.symbols.close, onClick: () => {
        m.rows.splice(i, 1);
        if (!m.rows.length) m.rows.push({ code: ".", text: "" });
        showMacros(Math.min(i, m.rows.length - 1));
      },
    });
    const sealed = r.sealed ? new ui.Label({ text: t("…and a sealed {{secret}}: GapKeep can't open it, and writes it back as it is."), color: MUTED, font: 14 }) : null;
    const err = new ui.Label({ text: "", color: RED, font: 14, width: "100%", hidden: true });
    page.rows.push({ code, text, err, sealed });
  });
  // the keys, by their tokens: what each is, never the key
  const legend = [];
  const allText = m.rows.map((r) => r.text).join("\n");
  const uses = (token) => new RegExp("\\{\\s*totp\\s+" + token + "\\s*\\}", "i").test(allText);
  m.blobs.forEach((_, i) => {
    if (uses("~" + (i + 1))) legend.push(t("{{totp ~{n}}}: a TOTP key the board holds", { n: i + 1 }));
  });
  for (const a of S.imported) {
    if (m.accounts.has(a.n) && uses("#" + a.n)) legend.push(t("{{totp #{n}}}: {title}, imported", { n: a.n, title: accountTitle(a) }));
  }
  if (legend.length) new ui.Label({ text: legend.join("\n"), color: MUTED, font: 14, width: "100%" });

  const bar = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  const add = new ui.Button(bar, {
    text: t("Add a macro"), onClick: () => {
      m.rows.push({ code: m.nextCode(), text: "" });
      showMacros(m.rows.length - 1);
    },
  });
  page.write = new ui.Button(bar, { text: t("Write to the board"), onClick: () => writeTable() });
  page.reload = new ui.Button(bar, { text: t("Read again from the board"), onClick: () => reloadTable() });
  backButton(bar);

  // the power-on macro
  const auto = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%", alignItems: "center" });
  new ui.Label(auto, { text: t("When plugged in, type:") });
  const codes = m.codes();
  page.autoCodes = [AUTO_NONE, ...codes.map((c) => c.header)];
  const sel = Math.max(0, page.autoCodes.indexOf(S.auto));
  page.auto = new ui.Dropdown(auto, {
    options: [t("nothing"), ...codes.map((c) => c.code)], selected: sel,
    onChange: ({ value }) => {
      S.auto = page.autoCodes[value];
      drawRowState();
    },
  });
  page.autoSave = new ui.Button(auto, { text: t("Save"), onClick: () => saveAuto() });
  new ui.Label({
    width: "100%", color: MUTED, font: 14,
    text: t("Keys: {{Enter}}, {{Tab}}, {{Ctrl+c}}, {{pause 1.5}}, {{x3}}... as on DigiMacro's page; \\n is Enter. A TOTP key goes in from Authenticator keys."),
  });
  page.actions = [page.write, page.reload, page.autoSave, add];
  drawRowState();
  const f = focusRow !== null && page.rows[focusRow] ? page.rows[focusRow].text : page.rows.length ? page.rows[0].text : add;
  f.focus();
}

// Errors under their rows, the budget, and what can be saved: the whole
// table encoded, so once typing pauses (a full table takes a while on a
// Pi Zero), not on every keystroke
let pending = null;
function soon() {
  if (pending !== null) clearTimeout(pending);
  if (page.write) page.write.disabled = true;     // until the table is checked
  pending = setTimeout(() => {
    pending = null;
    drawRowState();
  }, 250);
}

function drawRowState() {
  if (S.page !== "macros") return;
  const st = S.macros.state();
  st.each.forEach((e, i) => {
    const w = page.rows[i];
    if (!w) return;
    w.err.set({ text: e.error ? explain(e.error) : "", hidden: !e.error });
  });
  page.budget.set({ text: t("{n} of {max} bytes", { n: st.total, max: TABLE_TOP }), color: st.error ? RED : MUTED });
  page.tableError.set({ text: st.error ? explain(st.error) : "", hidden: !st.error });
  const changed = st.ok && st.snapshot !== S.saved;
  page.write.disabled = S.busy || !changed;
  const autoPending = S.auto !== S.savedAuto;
  const tableFirst = autoPending && S.auto !== AUTO_NONE && changed;
  page.autoSave.disabled = S.busy || !autoPending || tableFirst;
}

function writeTable() {
  const m = S.macros;
  let bytes;
  try {
    bytes = m.table();
  } catch (e) {
    notice(explain(e), RED);
    return;
  }
  if (/\{totp/i.test(m.rows.map((r) => r.text).join("")) && S.info.firmware < FW_TOTP) {
    notice(t("This board's firmware ({fw}) can't type {{totp}}: it needs firmware {need}.", { fw: S.info.firmware, need: FW_TOTP }), RED);
    return;
  }
  run("write", async () => {
    notice(t("Writing..."), MUTED);
    await S.board.write(0, bytes);
    const keys = m.settle();
    S.saved = m.snapshot();
    // a power-on macro whose code went away would wait for the next macro
    // given that code: it goes with its macro
    if (S.savedAuto !== AUTO_NONE && !m.codes().some((c) => c.header === S.savedAuto)) {
      await S.board.write(AUTO_ADDR, Uint8Array.from([AUTO_NONE]));
      S.savedAuto = S.auto = AUTO_NONE;
    }
    console.log(`digimacro: wrote the table, ${bytes.length} bytes, read back the same${keys ? `; ${keys} imported key(s) wiped from memory` : ""}`);
    bytes.fill(0);
    notice(t("Written: {n} bytes, read back and checked.", { n: bytes.length }), GREEN);
  });
}

function reloadTable() {
  run("read", async () => {
    await readAll();
  });
}

function saveAuto() {
  const want = S.auto;
  run("power-on macro", async () => {
    await S.board.write(AUTO_ADDR, Uint8Array.from([want]));
    S.savedAuto = want;
    console.log(`digimacro: power-on macro ${want === AUTO_NONE ? "none" : "saved"}`);
    notice(want === AUTO_NONE ? t("No macro types itself at power-on.") : t("Saved: that macro types itself when the board is plugged in."), GREEN);
  });
}

// --- authenticator keys -------------------------------------------------------------

const importedKeys = S.macros.accounts;       // number -> { secret, algorithm, digits, period }: the keys

function accountTitle(a) {
  return a.issuer && a.name ? `${a.issuer}: ${a.name}` : a.issuer || a.name;
}

function showAccounts() {
  newPage("accounts");
  new ui.Label({
    width: "100%", color: MUTED,
    text: t("Show the camera an authenticator's QR code (otpauth://totp/...) or Google Authenticator's export (Transfer accounts, Export). The keys stay in memory until they are written to the board, never on screen."),
  });
  const bar = new ui.Container({ layout: "row-wrap", gap: 8 });
  const scan = new ui.Button(bar, { text: t("Scan a QR code"), onClick: () => showScan() });
  if (S.imported.length) new ui.Button(bar, { text: t("Forget the imported keys"), onClick: () => forgetImported() });
  new ui.Button(bar, { text: t("Back"), onClick: () => showHome() });
  const codes = S.stage === "board" ? S.macros.codes() : [];
  for (const a of S.imported) {
    const live = S.macros.accounts.has(a.n);
    const box = new ui.Panel({ width: "100%", layout: "column", gap: 6 });
    new ui.Label(box, { text: `#${a.n}  ${accountTitle(a)}`, font: 18 });
    new ui.Label(box, {
      color: MUTED, width: "100%",
      text: t("{algorithm}, {digits} digits, every {period} s", { algorithm: a.algorithm, digits: a.digits, period: a.period }),
    });
    if (!a.fits) {
      new ui.Label(box, { color: AMBER, width: "100%", text: t("The board's codes are SHA-1, 6 digits, every 30 s: it can't type these.") });
    }
    if (!live) {
      new ui.Label(box, { text: t("Written to the board; its key is gone from memory."), color: MUTED });
    } else if (a.fits && codes.length) {
      const row = new ui.Container(box, { layout: "row", gap: 8, alignItems: "center" });
      new ui.Label(row, { text: t("Add to macro:") });
      const dd = new ui.Dropdown(row, { options: codes.map((c) => c.code) });
      new ui.Button(row, {
        text: t("Add {{totp #{n}}}", { n: a.n }), onClick: () => {
          const i = S.macros.rows.findIndex((r) => r.code === codes[dd.selected].code);
          S.macros.addTotp(i, a.n);
          console.log(`digimacro: account ${a.n} added to a macro`);
          notice(t("Added to macro \"{code}\": write the macros to the board to keep it.", { code: codes[dd.selected].code }), GREEN);
          showAccounts();
        },
      });
    } else if (a.fits) {
      new ui.Label(box, { text: t("Connect the board to put it in a macro."), color: MUTED });
    }
  }
  page.actions = [];
  scan.focus();
}

function forgetImported() {
  S.macros.forgetAccounts();
  S.imported = [];
  S.batches.clear();
  console.log("digimacro: forgot the imported keys");
  notice(t("The imported keys are forgotten."), GREEN);
  showAccounts();
}

function showScan() {
  newPage("scan");
  page.msg = new ui.Label({ text: t("Show the QR code to the camera."), width: "100%" });
  const side = Math.min(ui.width - 64, wide ? 640 : 400);
  page.scanner = new ui.Scanner({
    detect: ["qr"], width: side, height: Math.round(side * 0.75),
    onDetect: ({ text }) => scanned(text),
    onError: ({ reason }) => notice(t("The camera: {reason}", { reason }), RED),
  });
  const back = new ui.Button({ text: t("Done"), onClick: () => showAccounts() });
  back.focus();
}

function scanned(text) {
  let got;
  try {
    got = parseCode(text);
  } catch (e) {
    console.log(`digimacro: a QR code refused: ${e.message}`);
    notice(explain(e), RED);
    return;
  }
  const accounts = got.kind === "totp" ? [got.account] : got.accounts;
  let added = 0, fit = 0;
  for (const a of accounts) {
    const dup = S.imported.find((b) => S.macros.accounts.has(b.n) && b.issuer === a.issuer && b.name === a.name
      && b.algorithm === a.algorithm && b.digits === a.digits && b.period === a.period
      && sameKey(S.macros.accounts.get(b.n).secret, a.secret));
    if (dup) {
      a.secret.fill(0);
      continue;
    }
    const n = S.nextAccount++;
    const fits = totpFits(a);
    S.macros.accounts.set(n, { secret: a.secret, algorithm: a.algorithm, digits: a.digits, period: a.period });
    S.imported.push({ n, issuer: a.issuer, name: a.name, algorithm: a.algorithm, digits: a.digits, period: a.period, fits });
    added++;
    if (fits) fit++;
  }
  const refused = got.kind === "migration" ? got.refused.length : 0;
  console.log(`digimacro: imported ${added} account(s), ${fit} the board can type, ${refused} refused, ${accounts.length - added} there already`);
  let msg = plural(added, "{n} account imported.", "{n} accounts imported.");
  if (got.kind === "migration") {
    const b = got.batch;
    if (b.size > 1) {
      const seen = S.batches.get(b.id) || { size: b.size, seen: new Set() };
      seen.seen.add(b.index);
      S.batches.set(b.id, seen);
      const left = [];
      for (let i = 0; i < b.size; i++) if (!seen.seen.has(i)) left.push(i + 1);
      msg += " " + (left.length ? t("Part {part} of {size}: now show part {next}.", { part: b.index + 1, size: b.size, next: left[0] })
                                : t("All {size} parts read.", { size: b.size }));
    }
    for (const r of got.refused) msg += "\n" + explain(r);
  }
  notice(msg, added ? GREEN : AMBER);
}

function sameKey(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- password and lockout --------------------------------------------------------------

function showSecurity() {
  newPage("security");
  const s = S.info.state, has = !!(s & ST_PASSWORD);
  new ui.Label({ text: t("Password"), font: 22 });
  new ui.Label({
    width: "100%", color: MUTED,
    text: has ? t("This board has a password. Change it here, or remove it to make the board open to anyone who can hold the pad.")
              : t("This board has no password, which is the usual thing and perfectly fine: holding the pad is what keeps a web page out. Set one if the table is worth protecting from somebody holding the board."),
  });
  const row = new ui.Container({ layout: "row-wrap", gap: 8, alignItems: "center", width: "100%" });
  page.newPass = new ui.TextArea(row, { oneLine: true, password: true, width: 280, placeholder: t("a new password, up to 12 bytes"),
                                        onSubmit: () => setPassword() });
  const set = new ui.Button(row, { text: has ? t("Change the password") : t("Set a password"), onClick: () => setPassword() });
  const clear = has ? new ui.Button(row, { text: t("Remove the password"), onClick: () => clearPassword() }) : null;

  new ui.Label({ text: t("Lockout"), font: 22 });
  const L = S.lock || { on: false, soft: 3, hard: 0, tens: 6 };
  new ui.Label({
    width: "100%", color: has ? MUTED : AMBER,
    text: has ? t("After this many wrong codes the board pauses; after this many pauses it locks hard, until the password is given.")
              : t("The lockout needs a password, since giving it is the only way to lift a hard lock. Set one first."),
  });
  page.lockOn = new ui.Checkbox({ text: t("Pause after wrong codes"), checked: L.on, disabled: !has });
  const nums = new ui.Container({ layout: "row-wrap", gap: 8, alignItems: "center", width: "100%" });
  const num = (label, value) => {
    new ui.Label(nums, { text: label });
    return new ui.TextArea(nums, { oneLine: true, text: String(value), width: 90, accept: "0123456789", maxLength: 4, disabled: !has });
  };
  page.soft = num(t("wrong codes:"), L.on ? L.soft : 3);
  page.secs = num(t("pause, s:"), L.tens * 10);
  page.hard = num(t("hard lock after pauses (0: never):"), L.hard);
  const save = new ui.Button({ text: t("Save the lockout"), disabled: !has, onClick: () => saveLock() });
  if (S.lock) {
    new ui.Label({
      color: MUTED, width: "100%",
      text: t("Wrong codes now: {misses}. Pauses: {softs}. Hard locks lifted with the password, ever: {cleared}.", S.lock),
    });
  }
  new ui.Label({ text: t("Secrets"), font: 22 });
  new ui.Label({
    width: "100%", color: MUTED,
    text: t("A {{secret}} in a macro is sealed with a key the board's computer keeps. GapKeep keeps macros with sealed secrets as they are, but can't make, load or use that key: use DigiMacro's own page for secrets."),
  });
  backButton();
  page.actions = [set, save].concat(clear ? [clear] : []);
  page.newPass.focus();
}

function setPassword() {
  const given = page.newPass.text;
  if (!given) {
    notice(t("Type the new password first."), RED);
    return;
  }
  if (utf8Bytes(given).length > PASSWORD_MAX) {
    notice(t("A password is at most 12 bytes: an accented letter takes two."), RED);
    return;
  }
  page.newPass.text = "";
  run("password", async () => {
    await S.board.setPassword(given);
    S.password = given;
    S.info = await S.board.info();
    console.log("digimacro: password set");
    notice(t("The password is set. Keep it somewhere safe: only a programmer can get past it."), GREEN);
  });
}

async function clearPassword() {
  const i = await ui.alert(t("Remove the board's password? Anyone holding the pad will be able to change the macros."), {
    buttons: [t("Remove it"), t("Cancel")],
  });
  if (i !== 0) return;
  run("password", async () => {
    await S.board.setPassword(null);
    S.password = null;
    S.info = await S.board.info();
    console.log("digimacro: password removed");
    notice(t("The password is removed."), GREEN);
  });
}

function saveLock() {
  const on = page.lockOn.checked;
  const soft = Number(page.soft.text), secs = Number(page.secs.text), hard = Number(page.hard.text);
  if (on && !(soft >= 1 && soft <= 254 && hard >= 0 && hard <= 254 && secs >= 10 && secs <= 2400 && secs % 10 === 0)) {
    notice(t("Wrong codes from 1 to 254, a pause of 10 to 2400 s in tens, hard lock after 0 to 254 pauses."), RED);
    return;
  }
  run("lockout", async () => {
    await S.board.write(LOCK_ADDR, lockBytes({ on, soft, hard, tens: secs / 10 }));
    S.lock = parseLock(await S.board.read(LOCK_ADDR, LOCK_LEN));
    S.info = await S.board.info();
    console.log(`digimacro: lockout ${on ? "on" : "off"}`);
    notice(on ? t("The lockout is saved, its counts back to zero.") : t("The lockout is off."), GREEN);
  });
}

// --- the board's clock ----------------------------------------------------------------

const utcText = (ms) => formatDateTime(ms / 1000, { utc: true });

function showClock() {
  newPage("clock");
  new ui.Label({ text: t("The board's clock"), font: 22 });
  new ui.Label({
    width: "100%", color: MUTED,
    text: t("A {{totp}} macro types the code for the board's time. The board keeps time only while it has power: unplugged, it forgets it, and a {{totp}} types 000000 until a computer sets it again. So set it here only if the board stays powered (a powered hub, a switch) on its way to the computer that uses it."),
  });
  page.now = new ui.Label({ text: "", font: 20, mono: true });
  const fwOk = S.info.firmware >= FW_TOTP;
  if (!fwOk) new ui.Label({ text: t("This board's firmware ({fw}) has no clock: {{totp}} needs firmware {need}.", { fw: S.info.firmware, need: FW_TOTP }), color: AMBER, width: "100%" });
  const set = new ui.Button({ text: t("Set the board's clock to GapKeep's"), disabled: !fwOk, onClick: () => setClock() });
  backButton();
  page.actions = [set];
  drawClock(Date.now());
  set.focus();
}

function drawClock(ms) {
  if (S.page !== "clock") return;
  page.now.text = clock.status().set ? t("GapKeep: {time}", { time: utcText(ms) }) : t("GapKeep's clock is not set.");
}

clock.every(1, ({ time }) => drawClock(time));

async function setClock() {
  if (!clock.status().set) {
    console.log("digimacro: the board's clock not set: GapKeep's is not set");
    notice(t("GapKeep's clock is not set: set it in the Clock app first, then come back."), RED);
    return;
  }
  const i = await ui.alert(t("Set the board's clock to {time}? Check that this is right first: the codes depend on it.", { time: utcText(Date.now()) }), {
    title: t("The board's clock"), buttons: [t("It is right: set it"), t("Cancel")],
  });
  if (i !== 0) return;
  run("clock", async () => {
    if (!clock.status().set) throw new Error(t("GapKeep's clock is not set."));
    const now = Date.now();
    await S.board.setClock(now / 1000);
    console.log(`digimacro: the board's clock set to ${Math.floor(now / 1000)}`);
    notice(t("The board's clock is set to {time}.", { time: utcText(now) }), GREEN);
  });
}

// --- hardened mode -----------------------------------------------------------------------

function showHardening() {
  newPage("hardening");
  new ui.Label({ text: t("Hardened mode"), font: 22 });
  const hd = hardening(S.info);
  if (!hd) {
    new ui.Label({ text: t("This board's firmware does not report its fuses."), color: MUTED });
  } else {
    const all = hd.every((c) => c.ok);
    new ui.Label({
      width: "100%", color: MUTED,
      text: S.info.core
        ? t("A board keeps its secrets only as well as it is hardened: the password guards the table from the page, and the lock bits and fuses below guard it from a programmer. DigiMacro's HARDENED_MODE.md explains each.")
        : t("This board was built without a bootloader, for hardened mode. DigiMacro's HARDENED_MODE.md explains each line."),
    });
    if (S.info.core && S.info.state & ST_PASSWORD && !all) {
      new ui.Label({ width: "100%", color: AMBER, text: t("This board has a password, so it holds something worth guarding: until every line below is ticked, anyone with a programmer can read it out, password and all.") });
    }
    for (const c of hd) {
      new ui.Label({ width: "100%", color: c.ok ? GREEN : RED, text: (c.ok ? ui.symbols.ok : ui.symbols.close) + "  " + hardeningLine(c.key) });
    }
    const [low, high, ext, lock] = S.info.fuses;
    new ui.Label({ mono: true, font: 14, color: MUTED, text: t("Fuses: low {low}, high {high}, extended {ext}, lock {lock}", { low: hex2(low), high: hex2(high), ext: hex2(ext), lock: hex2(lock) }) });
    console.log(`digimacro: hardened-mode checklist: ${hd.filter((c) => c.ok).length} of ${hd.length}`);
  }
  backButton().focus();
  page.actions = [];
}

// --- start --------------------------------------------------------------------------------

showWaiting();
console.log("digimacro ready");
const first = usb.list()[0];
if (first) connect(first);
