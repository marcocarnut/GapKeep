// DigiMacro: configures a DigiMacro board (a morse-tapped macro keyboard on
// a Digispark) plugged into GapKeep, as its web page does: the macros, the
// power-on macro, the password, the lockout, the board's clock for {totp},
// the secrets' key, backups, and the hardened-mode checklist. TOTP keys come
// from QR codes: an authenticator's otpauth://totp/... or Google
// Authenticator's export. What the page puts in files (the secrets' key, a
// backup) goes out and comes back as QR codes, with the same text.
//
// A remote's button: {IR} with no button in a macro, then Learn: the board
// types the button it hears on its keyboard, which GapKeep reads for this
// app alone (gk:usb's interruptIn()), and it fills that {IR}.
//
// Experimental (docs/EXPERIMENTAL.md): GapKeep claims the board whole while
// this app is installed (gk:usb, docs/APPS.md "USB devices"), so its
// keyboard types nothing here.
//
// The board's protocol and the macro encoder are DigiMacroAsm's own code
// (vendor/, copied by tools/extract_digimacro.py); lib/board.js and
// lib/macros.js build on them. See README.md.
//
// Secrets: the password, imported TOTP keys, the {totp} keys read from the
// board and the secrets' key are in RAM only, never on screen as text (a
// TOTP key shows as {totp #N} or {totp ~N}; the secrets' key only as the QR
// code asked for) and never in the log. Imported keys are wiped once written to
// the board, the password when the board is unplugged; everything when the
// app ends (GapKeep zeroes freed memory). The log says what happened by
// counts and lengths.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as usb from "gk:usb";
import * as clock from "gk:clock";
import * as session from "gk:session";
import * as gkcrypto from "gk:crypto";
import { t, plural, formatDateTime, keyboard } from "gk:i18n";
import {
  Board, Refused, KeyReader, usbIo, wantsPassword, hardening, parseLock, lockBytes, serialText, utf8Bytes,
  ST_OPEN, ST_PASSWORD, ST_SOFTLOCK, ST_HARDLOCK, ST_KEY, FW_TOTP, PASSWORD_MAX, FW_FIRST_RESTART,
  CHECK_ADDR, SERIAL_ADDR, LOCK_ADDR, LOCK_LEN, KEY_WAIT_ADDR, AUTO_ADDR, AUTO_NONE,
} from "./lib/board.js";
import { Macros, MacroError, totpFits, TABLE_TOP, LAYOUTS, layoutLabel, setLayout, getLayout, setMessages, keyCheck, irHeard } from "./lib/macros.js";
import { makeBackup, readBackupHeader, openBackup, passwordFits, keyFileText, keyFromFile,
         IMAGE_LEN, PASS_ADDR, LOCK_COUNT_ADDRS } from "./lib/backup.js";
import { encoderMessage, hardeningLine } from "./lib/messages.js";
import { parseCode, ParseError, Message } from "./lib/parse.js";

setMessages(encoderMessage);

// vendor/table.js seals secrets with globalThis.crypto's random bytes, as in
// a browser: GapKeep's are gk:crypto's
if (!globalThis.crypto) globalThis.crypto = { getRandomValues: (a) => gkcrypto.getRandomValues(a) };

// lib/backup.js's cryptography
const BACKUP_CRYPTO = {
  scrypt: (password, salt, { N, r, p, length }) => gkcrypto.scrypt(password, salt, { N, r, p, length }),
  gcmEncrypt: (key, iv, ad, plain) => gkcrypto.aeadEncrypt("GCM", key, iv, ad, plain),
  gcmDecrypt: (key, iv, ad, data) => gkcrypto.aeadDecrypt("GCM", key, iv, ad, data),
  random: (n) => gkcrypto.randomBytes(n),
};
const F_FIRST_SECRET = 16;      // the firmware that opens {secret}
const KEY_LEN = 16;
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const keySet = () => !!S.check && S.check.some((b) => b !== 0xff);
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
  S.macros.setKey(null);        // the secrets' key too: it is this board's
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
  const restarted = S.restarting && Date.now() - S.restarting < 10000;
  S.restarting = 0;
  notice(restarted ? t("Restored. The board is restarting with its restored serial number: when it is back, hold the pad to go on.")
                   : t("The board was unplugged. What was not written to it is lost."), restarted ? GREEN : AMBER);
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
  // the secrets' key, given this session: kept if it is still the board's
  let key = S.macros.key && hexOf(keyCheck(S.macros.key)) === hexOf(S.check) ? Uint8Array.from(S.macros.key) : null;
  S.macros.setKey(null);
  S.macros = new Macros();
  S.macros.accounts = accounts;
  S.macros.setKey(key);
  let n;
  try {
    n = S.macros.load(ee);
  } catch (e) {
    console.log("digimacro: the key given doesn't open the board's secrets: dropped");
    S.macros.setKey(null);
    n = S.macros.load(ee);
  }
  if (key) key.fill(0);
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
  else if (S.page === "secrets") showSecrets();
  else if (S.page === "backup") showBackup();
}

function backButton(parent) {
  return new ui.Button(parent, { text: t("Back"), onClick: () => showHome() });
}

ui.onKey((ev) => {
  if (ev.key !== "Escape") return false;
  if (page.back) {                      // a page with a page to go back to
    page.back();
    return true;
  }
  if (S.stage === "board" && S.page !== "home") {
    showHome();
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
    [t("Secrets' key"), () => showSecrets()],
    [t("Backup and restore"), () => showBackup()],
  ];
  page.actions = [];
  // the menu, and beside it what DigiMacro is, with its page as a QR code
  const row = new ui.Container({ layout: "row", width: "100%", gap: wide ? 24 : 12, alignItems: "start" });
  const menu = new ui.Container(row, { layout: "column", gap: wide ? 12 : 8, grow: 1 });
  let first = null;
  for (const [text, fn] of items) {
    const b = new ui.Button(menu, { text, width: "100%", onClick: fn });
    first = first || b;
  }
  const about = new ui.Panel(row, { layout: "column", gap: 6, width: wide ? 400 : 230, alignItems: "center" });
  const small = wide ? 16 : 12;
  new ui.Label(about, { text: t("DigiMacro is a programmable USB keyboard and mouse: learn all about it at the address in the QR code:"),
                        width: "100%", font: small });
  new ui.QRCode(about, { data: DIGIMACRO_URL, size: wide ? 220 : 130 });
  new ui.Label(about, { text: DIGIMACRO_URL, width: "100%", font: small, color: MUTED });
  new ui.Label(about, { text: t("This app configures it, and is especially useful with GapKeep: the secrets you put in your macros stay out of reach of the online world."),
                        width: "100%", font: small });
  first.focus();
}

const DIGIMACRO_URL = "https://github.com/marcocarnut/DigiMacro";

// --- macros -----------------------------------------------------------------------

function showMacros(focusRow = null) {
  newPage("macros");
  page.focusRow = focusRow;
  const m = S.macros;
  const top = new ui.Container({ layout: "row-wrap", width: "100%", gap: 10, alignItems: "center" });
  new ui.Label(top, { text: t("The computer's keyboard:") });
  const layouts = LAYOUTS;
  new ui.Dropdown(top, {
    // as wide as "US International" and "Brasil (ABNT2)" need
    options: layouts.map(layoutLabel), selected: layouts.indexOf(getLayout()), width: wide ? 300 : 230,
    onChange: ({ value }) => {
      // the same keystrokes, read on the new layout: "v'arios" on US is
      // "vários" on US International
      m.relayout(getLayout(), layouts[value]);
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
  page.learn = new ui.Button(bar, { text: t("Learn a remote's button"), onClick: () => learnIR() });
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
    text: t("Keys: {{Enter}}, {{Tab}}, {{Ctrl+c}}, {{pause 1.5}}, {{x3}}... as on DigiMacro's page; \\n is Enter. A TOTP key goes in from Authenticator keys. A remote's button: type {{IR}} where it goes, then Learn a remote's button."),
  });
  page.actions = [page.write, page.reload, page.autoSave, page.learn, add];
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
  if (m.hasSecret() && S.info.firmware < F_FIRST_SECRET) {
    notice(t("This board's firmware ({fw}) can't keep {{secret}}: it needs firmware {need}.", { fw: S.info.firmware, need: F_FIRST_SECRET }), RED);
    return;
  }
  if (/\{totp/i.test(m.rows.map((r) => r.text).join("")) && S.info.firmware < FW_TOTP) {
    notice(t("This board's firmware ({fw}) can't type {{totp}}: it needs firmware {need}.", { fw: S.info.firmware, need: FW_TOTP }), RED);
    return;
  }
  run("write", async () => {
    notice(t("Writing..."), MUTED);
    await S.board.write(0, bytes);
    // what sealed the secrets is what the board checks keys against
    if (m.key && m.hasSecret()) await writeCheck(keyCheck(m.key));
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

// The secrets' key's check value, written and read back
async function writeCheck(check) {
  if (S.check && hexOf(check) === hexOf(S.check)) return;
  await S.board.write(CHECK_ADDR, check);
  S.check = await S.board.read(CHECK_ADDR, 8);
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

// --- a remote's button ----------------------------------------------------------------

// LEARN: the first {IR} with no button gets the one the board hears. The
// board types it ("aa cc", hex) on its keyboard, which is this app's while
// it reads it (gk:usb interruptIn()); no clipboard needed, nothing typed
// anywhere else. No hold, no password: LEARN reads nothing.
const LEARN_MS = 10000;

async function learnIR() {
  if (S.busy || !S.board) return;
  const m = S.macros;
  const at = m.emptyIR();
  if (!at) {
    notice(t("Type {{IR}} in a macro, where the remote's button goes, and then learn it."), AMBER);
    return;
  }
  const [row] = at;
  const ep = S.handle.device.endpoints.find((e) => e.type === "interrupt" && e.direction === "in");
  if (!ep) {
    notice(t("This board has no keyboard endpoint to read."), RED);
    return;
  }
  S.busy = true;
  drawBusy();
  const h = S.handle;
  const reader = new KeyReader();
  let typed = "", heard = null;
  try {
    // reading first, so that nothing the board types is missed
    let next = h.interruptIn(ep.address);
    next.catch(() => {});
    await S.board.learn();
    console.log(`digimacro: listening for a remote's button (macro ${row + 1})`);
    notice(t("Point the remote at the board and press the button, within ten seconds."), AMBER);
    const until = Date.now() + LEARN_MS;
    while (!heard) {
      const left = until - Date.now();
      if (left <= 0) break;
      let timer;
      const report = await Promise.race([next, new Promise((res) => { timer = setTimeout(() => res(null), left); })]);
      clearTimeout(timer);
      if (!report) break;
      typed += reader.feed(report);
      report.fill(0);
      heard = irHeard(typed);
      if (!heard) {
        next = h.interruptIn(ep.address);
        next.catch(() => {});
      }
    }
  } catch (e) {
    console.log(`digimacro: learn failed: ${e instanceof Refused ? "refused" : e.code || "error"}`);
    notice(e instanceof Refused ? t("The board did not take it: its firmware has no remote.") : explain(e), RED);
    return;
  } finally {
    try { h.stopInterruptIn(); } catch (e) { /* unplugged */ }
    S.busy = false;
    if (S.page === "macros") showMacros(row);
  }
  if (!heard) {
    console.log(`digimacro: no remote's button heard (${typed.length} character(s) typed)`);
    notice(t("Nothing heard. The board may have no IR receiver (on P2), the remote may be too far, or not one the board knows (NEC)."), RED);
    return;
  }
  m.fillIR(row, heard);
  console.log(`digimacro: a remote's button learned into macro ${row + 1}`);
  notice(t("Heard {ir}: it is in macro \"{code}\". Write the macros to the board to keep it.", { ir: heard, code: m.rows[row].code }), GREEN);
  if (S.page === "macros") showMacros(row);
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

// The camera, for a QR code: onText(text) with each one read; back() for
// Done and Escape
function showScan(onText = scanned, back = showAccounts, what = null) {
  newPage("scan");
  page.back = back;
  page.msg = new ui.Label({ text: what || t("Show the QR code to the camera."), width: "100%" });
  const side = Math.min(ui.width - 64, wide ? 640 : 400);
  page.scanner = new ui.Scanner({
    detect: ["qr"], width: side, height: Math.round(side * 0.75),
    onDetect: ({ text }) => onText(text),
    onError: ({ reason }) => notice(t("The camera: {reason}", { reason }), RED),
  });
  const done = new ui.Button({ text: t("Done"), onClick: () => back() });
  done.focus();
}

// A QR code to read with a phone or a computer's camera: as large as the
// screen allows, what it is beside it. data is wiped from the page when it
// goes (the widget's own copy goes with the screen).
function showQR(title, data, lines, back) {
  newPage("qr");
  page.back = back;
  const row = new ui.Container({ layout: "row", gap: wide ? 16 : 10, width: "100%", alignItems: "start" });
  const side = Math.min(ui.height - (wide ? 140 : 80), ui.width * 0.6);
  try {
    new ui.QRCode(row, { data, ecc: "L", size: Math.floor(side) });
  } catch (e) {
    new ui.Label(row, { text: t("It does not fit in a QR code: {why}", { why: e.message }), color: RED });
  }
  const text = new ui.Container(row, { layout: "column", gap: 8, grow: 1 });
  new ui.Label(text, { text: title, font: 22, width: "100%" });
  for (const [line, color] of lines) new ui.Label(text, { text: line, color: color || MUTED, width: "100%", font: wide ? 16 : 14 });
  new ui.Button(text, { text: t("Done"), onClick: () => back() }).focus();
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

// --- the secrets' key -----------------------------------------------------------------
//
// {secret} in a macro keeps the rest of it encrypted on the board: it plays
// only while a program on the computer (DigiMacro's tools/hostauth) has
// sent the board the key lately. The key is sixteen random bytes made here
// (gk:crypto's generator), never written to the board: only its check
// value is. DigiMacro's page downloads it as a file, a line for the
// computer's host.key; here it is shown as a QR code holding that file's
// text, for a phone or the computer's camera to take there. Scanned back,
// it opens the board's secrets in this app, until the board is unplugged.

const keyComment = () => t("DigiMacro key for board {serial}: add this line to ~/.config/digimacro/host.key, or on Windows to %APPDATA%\\digimacro\\host.key", { serial: S.serial });

function showSecrets() {
  newPage("secrets");
  const m = S.macros, has = keySet(), loaded = !!m.key, secrets = m.hasSecret();
  new ui.Label({ text: t("Secrets' key"), font: 22 });
  new ui.Label({
    width: "100%", color: MUTED,
    text: t("What follows {{secret}} in a macro is kept encrypted on the board, and the key is not kept there at all: the macro plays it only while a small program on the computer (DigiMacro's tools/hostauth) has sent the key lately. Plugged in anywhere else, or stolen, the board holds only scrambled bytes. {{secret!}} stops the macro as if the code were not there."),
  });
  const lines = [!has ? (secrets ? t("Some macros have secrets, but this board has no key for them: make one, and they are encrypted when the macros are written.") : t("This board has no key for secrets."))
                      : S.info.state & ST_KEY ? t("This board has a key for secrets, and a computer sent it lately: secrets play for now.")
                      : t("This board has a key for secrets. No computer has sent it lately.")];
  if (loaded) lines.push(t("The key is here, in this app: secrets show as text, and are encrypted again when written."));
  else if (m.hasSealed()) lines.push(t("Scan the key's QR code to see or change the secrets."));
  new ui.Label({ text: lines.join(" "), width: "100%", ...(!has && secrets ? { color: RED } : {}) });
  const bar = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  const make = new ui.Button(bar, { text: has ? t("Make a new key") : t("Make a key"), onClick: () => newKey() });
  const actions = [make];
  if (has && !loaded) actions.push(new ui.Button(bar, { text: t("Scan the key's QR code"), onClick: () => showScan(loadKey, showSecrets, t("Show the camera the key's QR code (the one this app showed when it made the key).")) }));
  if (loaded) actions.push(new ui.Button(bar, { text: t("Show the key's QR code again"), onClick: () => showKey(false) }));
  if (has) actions.push(new ui.Button(bar, { text: t("Remove the key"), onClick: () => removeKey() }));
  backButton(bar);
  page.actions = actions;
  make.focus();
}

// A new key, written as its check value. Secrets already on the board were
// sealed with the old one, and are sealed again with the new: which needs
// the old one, and nothing on screen not yet written, as the table goes
// with them (DigiMacro's page does the same).
async function newKey() {
  const m = S.macros;
  if (m.hasSealed()) {
    notice(t("Some secrets were encrypted with the board's key, and this app has not got it. Scan the key's QR code first, so they can be encrypted again with the new one, or remove them."), RED);
    return;
  }
  const secrets = m.hasSecret();
  if (secrets && m.snapshot() !== S.saved) {
    notice(t("Write the macros first: a new key encrypts the secrets again, and writes them with it."), RED);
    return;
  }
  if (keySet()) {
    const i = await ui.alert(t("Make a new key? Every computer with the old one will need the new one."), { buttons: [t("Make a new key"), t("Cancel")] });
    if (i !== 0) return;
  }
  run("new key", async () => {
    const was = m.key ? Uint8Array.from(m.key) : null;
    const key = gkcrypto.randomBytes(KEY_LEN);
    try {
      if (!(S.keyWait >= 1 && S.keyWait <= 240)) {
        await S.board.write(KEY_WAIT_ADDR, Uint8Array.from([6]));      // a minute, as the page's default
        S.keyWait = 6;
      }
      m.setKey(key);
      if (secrets) {
        const bytes = m.table();
        await S.board.write(0, bytes);
        bytes.fill(0);
      }
      await writeCheck(keyCheck(key));
    } catch (e) {
      m.setKey(was);
      throw e;
    } finally {
      key.fill(0);
      if (was) was.fill(0);
    }
    if (secrets) S.saved = m.snapshot();
    S.info = await S.board.info();
    console.log(`digimacro: a new key for secrets${secrets ? ", the secrets sealed again with it" : ""}`);
    showKey(true);
  });
}

function showKey(made) {
  const key = S.macros.key;
  if (!key) return;
  const text = keyFileText(S.serial, key, keyComment());
  showQR(t("The key for board {serial}", { serial: S.serial }), text, [
    [made ? t("A new key is in use. Take this QR code to each computer the secrets should play for, and add its text to ~/.config/digimacro/host.key there (on Windows, %APPDATA%\\digimacro\\host.key); any that had the old key needs this one.")
          : t("Add its text to ~/.config/digimacro/host.key on each computer the secrets should play for (on Windows, %APPDATA%\\digimacro\\host.key)."), null],
    [t("Keep it: without it, the secrets can't be read or changed again. Anyone who photographs it can play them, with the board."), AMBER],
  ], showSecrets);
}

function loadKey(text) {
  const got = keyFromFile(text, S.serial);
  if (got.error) {
    notice(got.error === "key-v2-host" ? t("That is a v2 host key, which firmware 16 no longer uses. Make a key instead.")
                                       : t("That QR code has no key for board {serial}.", { serial: S.serial }), RED);
    return;
  }
  const key = got.key;
  if (hexOf(keyCheck(key)) !== hexOf(S.check)) {
    key.fill(0);
    notice(t("That key is not this board's: it opens none of its secrets."), RED);
    return;
  }
  const unchanged = S.macros.snapshot() === S.saved;
  const n = S.macros.setKey(key);
  key.fill(0);
  if (unchanged) S.saved = S.macros.snapshot();     // opened, it is still what the board holds
  console.log(`digimacro: the key for secrets given; ${n} secret(s) opened`);
  notice(t("The key fits: the secrets are open in this app."), GREEN);
  showSecrets();
}

// Removing it leaves any secret on the board for good: not while there are any
function removeKey() {
  if (S.macros.hasSecret()) {
    notice(t("Some macros have secrets, which nothing could read again without the key. Take them out first."), RED);
    return;
  }
  run("remove key", async () => {
    await writeCheck(new Uint8Array(8).fill(0xff));
    S.macros.setKey(null);
    S.info = await S.board.info();
    console.log("digimacro: the key for secrets removed");
    notice(t("The key is gone from the board."), GREEN);
  });
}

// --- backup ---------------------------------------------------------------------------
//
// The whole EEPROM, as DigiMacro's page saves it to a file (lib/backup.js):
// here as a QR code of the same text. A board with a password has it
// encrypted with that password; without one it is in the clear. A restore
// writes everything, serial number included, so a board erased to update
// its firmware comes back as itself; the password goes last.

let restore = null;             // { text, head } of a backup scanned, until written or dropped

function showBackup() {
  newPage("backup");
  const has = !!(S.info.state & ST_PASSWORD);
  new ui.Label({ text: t("Backup"), font: 22 });
  new ui.Label({
    width: "100%", color: MUTED,
    text: t("Everything on the board (macros, power-on macro, lockout, key check, password, serial number) as one QR code: photograph it, or read it with a phone, and keep it. Its text, saved as a file, is also what DigiMacro's page restores."),
  });
  new ui.Label({ width: "100%", color: has ? MUTED : AMBER,
                 text: has ? t("It is encrypted with the board's password.") : t("This board has no password, so the backup holds every macro in the clear.") });
  const bar = new ui.Container({ layout: "row-wrap", gap: 8, width: "100%" });
  const save = new ui.Button(bar, { text: t("Save a backup as a QR code"), onClick: () => saveBackup() });
  new ui.Label({ text: t("Restore"), font: 22 });
  const actions = [save];
  if (!restore) {
    new ui.Label({ width: "100%", color: MUTED, text: t("Show the camera a backup's QR code: one this app showed, or one made from a file DigiMacro's page saved.") });
    actions.push(new ui.Button({ text: t("Scan a backup"), onClick: () => showScan(scannedBackup, showBackup, t("Show the camera the backup's QR code.")) }));
  } else {
    const h = restore.head;
    new ui.Label({ width: "100%", text: h.encrypted ? t("A backup of board {serial}, firmware {firmware}, saved on {saved}. It is encrypted: type the password it was saved with.", h)
                                                    : t("A backup of board {serial}, firmware {firmware}, saved on {saved}. It is not encrypted.", h) });
    new ui.Label({ width: "100%", color: AMBER, text: t("This replaces everything on this board with board {serial}'s backup: macros, power-on macro, lockout, key check, password and serial number. A restore installs whatever the backup holds, so only restore backups you made.", h) });
    const row = new ui.Container({ layout: "row-wrap", gap: 8, alignItems: "center", width: "100%" });
    if (h.encrypted) {
      page.bkPass = new ui.TextArea(row, { oneLine: true, password: true, width: 280, placeholder: t("the password it was saved with"),
                                           onSubmit: () => restoreBackup() });
    }
    actions.push(new ui.Button(row, { text: t("Restore it"), onClick: () => restoreBackup() }));
    new ui.Button(row, { text: t("Drop it"), onClick: () => { restore = null; showBackup(); } });
  }
  backButton();
  page.actions = actions;
  (page.bkPass || save).focus();
}

async function saveBackup() {
  const has = !!(S.info.state & ST_PASSWORD);
  if (has && S.password === null) {       // never in the clear for a board with one
    notice(t("Give the board's password first."), RED);
    return;
  }
  const warn = !has ? t("This board has no password, so the backup would hold every macro in the clear. Save it anyway?")
             : utf8Bytes(S.password).length < 8 ? t("The password is shorter than eight characters. A copied backup can be guessed at offline, far faster than the board allows, and a short password will not hold for long. Save it anyway?")
             : null;
  if (warn && (await ui.alert(warn, { buttons: [t("Save it"), t("Cancel")] })) !== 0) return;
  run("backup", async () => {
    notice(t("Reading the board..."), MUTED);
    const image = await S.board.read(0, IMAGE_LEN);
    if (has) notice(t("Working out the encryption from the password: a few seconds, on purpose..."), MUTED);
    const saved = clock.status().set ? new Date().toISOString().slice(0, 10) : "unknown";
    let text;
    try {
      text = await makeBackup(image, has ? S.password : null, { serial: S.serial, firmware: S.info.firmware, saved }, BACKUP_CRYPTO);
    } finally {
      image.fill(0);
    }
    console.log(`digimacro: a backup made, ${text.length} characters, ${has ? "encrypted" : "in the clear"}`);
    showQR(t("Backup of board {serial}", { serial: S.serial }), text, [
      [has ? t("Encrypted with the board's password.") : t("In the clear: keep it where you would keep the macros themselves."), has ? null : AMBER],
      [t("Saved as a file, its text is digimacro-{serial}-{saved}.backup for DigiMacro's page.", { serial: S.serial, saved }), null],
    ], showBackup);
  });
}

function scannedBackup(text) {
  let head;
  try {
    head = readBackupHeader(text);
  } catch (e) {
    notice(backupError(e), RED);
    return;
  }
  restore = { text, head };
  console.log(`digimacro: a backup scanned (${head.encrypted ? "encrypted" : "in the clear"}, ${text.length} characters)`);
  notice("", MUTED);
  showBackup();
}

function backupError(e) {
  switch (e.message) {
    case "backup-not-one": return t("That is not a DigiMacro backup.");
    case "backup-other-map": return t("That backup was made by a different version of DigiMacro, and this app can't read it.");
    case "backup-wrong-password": return t("That is not the password this backup was saved with.");
    case "backup-bad-password": return t("That backup holds a password other than the one it was opened with: restored, it would lock the board for good.");
    default: return explain(e);
  }
}

async function restoreBackup() {
  if (!restore || S.busy) return;
  const { text, head } = restore;
  const pw = head.encrypted ? (page.bkPass ? page.bkPass.text : "") : null;
  if (head.encrypted && !pw) {
    notice(t("Type the password the backup was saved with."), RED);
    return;
  }
  // opened before anything else: a wrong password costs nobody a hold
  let image;
  S.busy = true;
  drawBusy();
  try {
    notice(head.encrypted ? t("Working out the encryption from the password: a few seconds, on purpose...") : t("Reading the backup..."), MUTED);
    image = await openBackup(text, pw, BACKUP_CRYPTO);
    if (!passwordFits(image, pw)) throw new Error("backup-bad-password");
  } catch (e) {
    if (image) image.fill(0);
    console.log(`digimacro: a backup not opened: ${e.message.startsWith("backup-") ? e.message : "error"}`);
    notice(backupError(e), RED);
    return;
  } finally {
    S.busy = false;
    redraw();
  }
  const i = await ui.alert(t("Replace everything on this board with board {serial}'s backup?", head), { buttons: [t("Restore it"), t("Cancel")] });
  if (i !== 0) {
    image.fill(0);
    return;
  }
  for (const a of LOCK_COUNT_ADDRS) image[a] = 0xff;     // the lockout's counts start again
  run("restore", async () => {
    try {
      const secrets = (() => {
        const m = new Macros();
        try {
          m.load(image.slice(0, CHECK_ADDR + 8));
        } catch (e) { /* sealed, read without the key */ }
        return m.hasSecret();
      })();
      if (secrets && S.info.firmware < F_FIRST_SECRET) {
        throw new Error(t("This board's firmware ({fw}) can't keep {{secret}}: it needs firmware {need}.", { fw: S.info.firmware, need: F_FIRST_SECRET }));
      }
      notice(t("Writing..."), MUTED);
      await S.board.write(0, image.slice(0, PASS_ADDR));          // read back by write()
      await S.board.write(PASS_ADDR, image.slice(PASS_ADDR));     // last: it may lock the board
      S.password = image[PASS_ADDR] === 0xff ? null : pw;
      S.info = await S.board.info();
      if (S.password !== null && wantsPassword(S.info.state)) await tryUnlock();
    } finally {
      image.fill(0);
    }
    restore = null;
    console.log("digimacro: a backup restored, and read back");
    S.macros.setKey(null);
    if (S.info.firmware < FW_FIRST_RESTART) {
      await readAll();
      notice(t("Restored, and read back. Unplug the board and plug it back in, so that the restored serial number takes effect."), GREEN);
      return;
    }
    notice(t("Restored, and read back. The board is restarting, to come back with its restored serial number..."), GREEN);
    S.restarting = Date.now();
    await S.board.restart();
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
