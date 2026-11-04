// Authenticator: time-based one-time codes (TOTP, RFC 6238), as Google
// Authenticator shows them, on an air-gapped Pi Zero.
//
// Accounts come from QR codes (otpauth://totp/... or Google Authenticator's
// export, otpauth-migration://...) or are typed in. They are kept in RAM
// only, in the app's session store (zg:session): they survive leaving the
// app for another, and are gone at power-off. zerogap never writes to the
// card. The codes need the right time: the clock app sets it after each
// boot; until then (clock.status().set false) no code is shown.
//
// The log never holds a secret or a code: codes are logged as tags only
// the account's key can check, for the tests (tests/totp.txt).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as clock from "zg:clock";
import * as session from "zg:session";
import { sha256, hmac } from "zg:crypto";
import { setHmac, makeHmac, totpCounter, hotp, groupCode, ALGORITHMS } from "./lib/hotp.js";
import { parseCode, base32Decode, ParseError, MAX_PERIOD } from "./lib/parse.js";
import { runSelfTest } from "./lib/selftest.js";

setHmac(hmac);

const MUTED = "#8a9199", RED = "#ef5350", AMBER = "#ffb300", GREEN = "#66bb6a";
const wide = ui.width >= 1000;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const state = {
  accounts: [],     // { n, issuer, name, algorithm, digits, period, key, hmac, fingerprint, counter, code, ui }
  nextNumber: 1,
  batches: new Map(), // export batch id -> { size, seen: Set of indices }
  page: null,       // "list", "scan", "type"
  notice: null,     // { text, color }: what the last action did, shown on the list
  selftest: null,   // { passed, failed }
  clockSet: clock.status().set,
  unkept: false,    // the last save() failed: the accounts won't outlive the app
};

// --- accounts ----------------------------------------------------------------

const title = (a) => (a.issuer && a.name ? `${a.issuer}: ${a.name}` : a.issuer || a.name);

function newAccount(n, a, key, fingerprint) {
  return {
    n, issuer: a.issuer, name: a.name, algorithm: a.algorithm, digits: a.digits, period: a.period,
    key, hmac: makeHmac(a.algorithm, key), fingerprint, counter: null, code: null, ui: null,
  };
}

// Adds an account unless the same key is there already. Returns false then.
// A fingerprint recognises the same key scanned twice.
function addAccount(a) {
  const fingerprint = hex(sha256(`${a.algorithm}/${a.digits}/${a.period}/${hex(a.secret)}`)).slice(0, 32);
  if (state.accounts.some((b) => b.fingerprint === fingerprint && b.issuer === a.issuer && b.name === a.name)) {
    a.secret.fill(0);
    console.log("totp: that account is there already");
    return false;
  }
  const key = a.secret.slice();
  a.secret.fill(0);
  const n = state.nextNumber++;
  state.accounts.push(newAccount(n, a, key, fingerprint));
  console.log(`totp: added account ${n} (${a.algorithm}, ${a.digits} digits, ${a.period} s), ${state.accounts.length} in all`);
  return true;
}

function wipe(a) {
  a.hmac.wipe();
  a.key.fill(0);
}

function removeAccount(a) {
  wipe(a);
  state.accounts = state.accounts.filter((b) => b !== a);
  console.log(`totp: removed account ${a.n}, ${state.accounts.length} left`);
  save();
}

function forgetAll() {
  for (const a of state.accounts) wipe(a);
  state.accounts = [];
  state.batches.clear();
  state.nextNumber = 1;
  session.clear();
  console.log("totp: forgot all accounts");
}

// --- the session store: the accounts outlive the app, until power-off -------

// Over zg:session's 64 KiB (some 300 accounts) they are still shown, but
// not kept: say so.
function save() {
  try {
    keep();
    state.unkept = false;
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    state.unkept = true;
    console.log(`totp: accounts not kept: ${e.message}`);
  }
}

function keep() {
  session.set("accounts", {
    nextNumber: state.nextNumber,
    accounts: state.accounts.map((a) => ({
      n: a.n, issuer: a.issuer, name: a.name, algorithm: a.algorithm, digits: a.digits, period: a.period,
      key: a.key, fingerprint: a.fingerprint,
    })),
    batches: Array.from(state.batches, ([id, b]) => [id, b.size, Array.from(b.seen)]),
  });
}

function restore() {
  const saved = session.get("accounts");
  if (saved === undefined) {
    console.log("totp: no accounts kept from before");
    return;
  }
  state.nextNumber = saved.nextNumber;
  for (const a of saved.accounts) {
    state.accounts.push(newAccount(a.n, a, a.key.slice(), a.fingerprint));
    a.key.fill(0);
  }
  for (const [id, size, seen] of saved.batches) state.batches.set(id, { size, seen: new Set(seen) });
  console.log(`totp: restored ${plural(state.accounts.length, "account")} kept from before`);
}

// Codes are shown only when they can be right: the clock set, the self-test
// not failed.
const codesShown = () => state.clockSet && !(state.selftest && state.selftest.failed.length);

// --- the clock: one tick a second, on the second ------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
function utcText(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

// Brings the list up to date for `ms`: a new code when an account's period
// has turned (two hash compressions), else only the countdown.
function update(ms) {
  if (state.page !== "list") return;
  page.clock.text = state.clockSet ? utcText(ms) : "Clock not set";
  if (!codesShown()) return;
  const seconds = Math.floor(ms / 1000);
  for (const a of state.accounts) {
    const counter = totpCounter(ms, a.period);
    if (counter !== a.counter) {
      a.counter = counter;
      a.code = hotp(a.hmac, counter, a.digits);
      a.ui.code.text = groupCode(a.code);
      // For tests: a tag only the account's key can check. (A plain hash
      // of a 6-digit code is reversed by trying all million of them.)
      const tag = a.hmac.mac(Uint8Array.from("zerogap log " + a.code, (c) => c.charCodeAt(0)));
      console.log(`totp: account ${a.n}, step ${counter}, code tag ${hex(tag).slice(0, 16)}`);
      tag.fill(0);
    }
    const left = a.period - (seconds % a.period);
    a.ui.bar.value = left;
    a.ui.left.set({ text: `${left} s`, color: left <= 5 ? AMBER : MUTED });
  }
}

clock.every(1, ({ time, changed }) => {
  if (changed) {
    const set = clock.status().set;
    console.log(`totp: the clock changed${set ? "" : " (not set)"}`);
    for (const a of state.accounts) a.counter = null;     // recompute every code
    if (set !== state.clockSet) {
      state.clockSet = set;
      if (state.page === "list") showList();
    }
  }
  update(time);
});

// --- pages --------------------------------------------------------------------

let page = {};      // the widgets of the page shown

function newPage(name) {
  state.page = name;
  for (const a of state.accounts) a.ui = null;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [24, 32] : [12, 16], gap: wide ? 14 : 8, alignItems: "center" });
  page = { name };
  // one column, not wider than reads well
  return new ui.Container({ layout: "column", gap: wide ? 14 : 8, width: "100%", maxWidth: 1100, grow: 1 });
}

function header(parent, text) {
  const row = new ui.Container(parent, { layout: "row", alignItems: "center", gap: 12, width: "100%" });
  new ui.Label(row, { text, font: wide ? 28 : 22, grow: 1 });
  return row;
}

function paragraph(parent, text, props = {}) {
  return new ui.Label(parent, { text, width: "100%", overflow: "wrap", font: wide ? 16 : 14, ...props });
}

function showList() {
  const col = newPage("list");
  const head = header(col, ui.symbols.refresh + " Authenticator");
  page.clock = new ui.Label(head, { text: "", font: wide ? 18 : 14, color: MUTED });

  if (!state.clockSet) {
    paragraph(col, ui.symbols.warning + " The clock is not set, so codes would be wrong and none are shown. " +
      "Set it first in the Clock app, then open the Authenticator again.", { color: AMBER, font: wide ? 18 : 16 });
  }
  if (state.selftest && state.selftest.failed.length) {
    paragraph(col, ui.symbols.warning + " The self-test failed: this system computes codes wrongly, so none are shown.",
      { color: RED, font: wide ? 18 : 16 });
  }

  const buttons = new ui.Container(col, { layout: "row-wrap", gap: 8, width: "100%" });
  const scan = new ui.Button(buttons, { text: ui.symbols.plus + " Scan QR code", onClick: showScan });
  new ui.Button(buttons, { text: ui.symbols.keyboard + " Type a key", onClick: showType });
  new ui.Button(buttons, {
    text: ui.symbols.trash + " Forget all",
    disabled: state.accounts.length === 0,
    onClick: async () => {
      const choice = await ui.alert(`Forget ${plural(state.accounts.length, "account")}? ` +
        "To get them back you will need their QR codes or keys.", { title: "Forget all", buttons: ["Cancel", "Forget all"] });
      if (choice !== 1) return;
      forgetAll();
      state.notice = { text: "All accounts forgotten.", color: MUTED };
      showList();
    },
  });
  new ui.Button(buttons, { text: ui.symbols.home + " Leave", onClick: () => sys.exit() });

  if (state.notice) paragraph(col, state.notice.text, { color: state.notice.color });
  if (state.unkept) {
    paragraph(col, ui.symbols.warning + " Too many accounts to keep: leaving this app will forget them.", { color: AMBER });
  }

  const list = new ui.Container(col, { layout: "column", gap: 8, width: "100%", grow: 1, scrollable: true });
  if (state.accounts.length === 0) {
    paragraph(list, "No accounts yet. Scan a QR code (an otpauth:// key, or Google Authenticator's " +
      "\"Transfer accounts\" export), or type a key.", { color: MUTED });
  }
  for (const a of state.accounts) accountRow(list, a);

  paragraph(col, "Accounts are kept in memory only, until you switch off (using other apps meanwhile is fine): " +
    "nothing is written to the card. Keep the QR codes (or keys) safe: they are your backup.", { color: MUTED, font: wide ? 14 : 12 });

  scan.focus();
  update(clock.now());
}

function accountRow(parent, a) {
  const row = new ui.Panel(parent, {
    layout: "row", alignItems: "center", gap: 12, width: "100%", padding: wide ? [10, 16] : [6, 10],
    scrollable: false, focusable: true, clickable: true,
    onClick: () => details(a),
  });
  const names = new ui.Container(row, { layout: "column", gap: 2, grow: 1 });
  new ui.Label(names, { text: a.issuer || a.name, font: wide ? 22 : 18, width: "100%", overflow: "dots" });
  if (a.issuer) new ui.Label(names, { text: a.name, font: wide ? 16 : 14, color: MUTED, width: "100%", overflow: "dots" });
  const right = new ui.Container(row, { layout: "column", gap: 4, alignItems: "end" });
  const shown = codesShown();
  const code = new ui.Label(right, {
    text: shown ? "" : a.digits === 8 ? "---- ----" : "--- ---", font: wide ? 40 : 32, color: shown ? GREEN : MUTED,
  });
  const timer = new ui.Container(right, { layout: "row", gap: 8, alignItems: "center", hidden: !shown });
  const bar = new ui.Bar(timer, { min: 0, max: a.period, value: a.period, width: wide ? 160 : 100, height: 8 });
  const left = new ui.Label(timer, { text: "", font: 14, color: MUTED, width: 44, textAlign: "right" });
  a.ui = { code, bar, left };
  a.counter = null;
}

async function details(a) {
  const text = [
    a.issuer ? `Issuer: ${a.issuer}` : null,
    `Account: ${a.name || "(none)"}`,
    `${a.algorithm}, ${a.digits} digits, every ${a.period} s`,
    `Key fingerprint: ${a.fingerprint.slice(0, 16)}`,
  ].filter((x) => x !== null).join("\n");
  const choice = await ui.alert(text, { title: title(a), buttons: ["Close", ui.symbols.trash + " Remove"] });
  if (choice !== 1) return;
  const sure = await ui.alert(`Remove ${title(a)}? You will need its QR code or key to add it again.`,
    { title: "Remove", buttons: ["Cancel", "Remove"] });
  if (sure !== 1) return;
  removeAccount(a);
  state.notice = { text: `Removed ${title(a)}.`, color: MUTED };
  if (state.page === "list") showList();
}

// --- scanning -----------------------------------------------------------------

function showScan() {
  const col = newPage("scan");
  header(col, ui.symbols.plus + " Scan QR code");
  const body = new ui.Container(col, { layout: wide ? "row" : "column", gap: wide ? 20 : 8, width: "100%" });
  const scanner = new ui.Scanner(body, {
    detect: ["qr"],
    width: wide ? 480 : 280,
    height: wide ? 360 : 210,
    onDetect: ({ text }) => scanned(text),
    onError: ({ reason }) => {
      say(`The camera stopped: ${reason}.`, RED);
      console.log(`totp: camera error: ${reason}`);
    },
  });
  const side = new ui.Container(body, { layout: "column", gap: 8, grow: 1, width: wide ? "content" : "100%" });
  page.status = paragraph(side, "Show the QR code of an account (otpauth://totp/...), or Google " +
    "Authenticator's export (Transfer accounts, Export: each part in turn).", { font: wide ? 18 : 14 });
  page.done = new ui.Button(side, { text: ui.symbols.ok + " Done", onClick: showList });
  page.done.focus();
  page.scanner = scanner;
}

function say(text, color) {
  if (state.page === "scan") page.status.set({ text, color });
}

function scanned(content) {
  let r;
  try {
    r = parseCode(content);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    say(ui.symbols.warning + " " + e.message, RED);
    console.log(`totp: refused a code: ${e.message}`);
    return;
  }
  if (r.kind === "totp") {
    const added = addAccount(r.account);
    save();
    state.notice = added ? { text: `Added ${title(r.account)}.`, color: GREEN }
                         : { text: `${title(r.account)} is already in the list.`, color: MUTED };
    showList();
    return;
  }

  // an export, maybe one part of several
  let added = 0, again = 0;
  for (const a of r.accounts) (addAccount(a) ? added++ : again++);
  const { size, index, id } = r.batch;
  const batch = state.batches.get(id) || { size, seen: new Set() };
  batch.seen.add(index);
  state.batches.set(id, batch);
  save();
  const missing = [];
  for (let i = 0; i < size; i++) if (!batch.seen.has(i)) missing.push(i + 1);
  let text = (size > 1 ? `Part ${index + 1} of ${size}: ` : "") +
    `${plural(added, "account")} added` + (again ? `, ${again} already in the list` : "") + ".";
  if (r.refused.length) text += ` Not added: ${r.refused.join(" ")}`;
  console.log(`totp: export part ${index + 1} of ${size}: ${added} added, ${again} already there, ${r.refused.length} refused`);
  if (missing.length) {
    say(text + ` Now show part${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`, r.refused.length ? AMBER : GREEN);
  } else {
    state.notice = { text, color: r.refused.length ? AMBER : GREEN };
    showList();
  }
}

// --- typing a key ---------------------------------------------------------------

function showType() {
  const col = newPage("type");
  header(col, ui.symbols.keyboard + " Type a key");
  const form = new ui.Container(col, { layout: "column", gap: 6, width: "100%", grow: 1, scrollable: true });
  const field = (label, props) => {
    const row = new ui.Container(form, { layout: "row", alignItems: "center", gap: 10, width: "100%" });
    new ui.Label(row, { text: label, width: wide ? 200 : 130, font: wide ? 18 : 14 });
    return props.options ? new ui.Dropdown(row, { grow: 1, ...props }) : new ui.TextArea(row, { oneLine: true, grow: 1, ...props });
  };
  const issuer = field("Issuer", { placeholder: "optional, e.g. Example Inc", maxLength: 64 });
  const name = field("Account", { placeholder: "e.g. alice@example.com", maxLength: 64 });
  const key = field("Key (Base32)", {
    placeholder: "e.g. JBSW Y3DP EHPK 3PXP",
    accept: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz234567= ",
    maxLength: 256,
  });
  const algorithm = field("Algorithm", { options: ["SHA1 (usual)", "SHA256", "SHA512"] });
  const digits = field("Digits", { options: ["6 (usual)", "8"] });
  const period = field("Period (s)", { text: "30", accept: "0123456789", maxLength: 5 });
  const error = paragraph(form, "Most services use SHA1, 6 digits and 30 s: change those only if the service says so.",
    { color: MUTED });
  const buttons = new ui.Container(form, { layout: "row", gap: 8 });
  const add = () => {
    const fail = (text) => {
      error.set({ text: ui.symbols.warning + " " + text, color: RED });
      console.log(`totp: typed key refused: ${text}`);
    };
    const account = { issuer: issuer.text.trim(), name: name.text.trim() };
    if (!account.issuer && !account.name) return fail("Give the account a name (or an issuer).");
    if (/:/.test(account.issuer)) return fail("The issuer can't contain a colon.");
    const compact = key.text.replace(/\s/g, "").replace(/=+$/, "");
    if (compact.length === 0) return fail("Type the key.");
    if (compact.length < 16) {
      return fail(`The key is ${compact.length} characters long: keys have at least 16 (80 bits). Is part of it missing?`);
    }
    try {
      account.secret = base32Decode(key.text);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return fail(e.message);
    }
    account.algorithm = ALGORITHMS[algorithm.selected];
    account.digits = digits.selected === 1 ? 8 : 6;
    const p = Number(period.text);
    if (!(p >= 1 && p <= MAX_PERIOD)) {
      account.secret.fill(0);
      return fail(`The period must be from 1 to ${MAX_PERIOD} seconds.`);
    }
    account.period = p;
    const added = addAccount(account);
    save();
    state.notice = added ? { text: `Added ${title(account)}.`, color: GREEN }
                         : { text: `${title(account)} is already in the list.`, color: MUTED };
    showList();
  };
  for (const f of [issuer, name, key, period]) f.on("submit", add);
  new ui.Button(buttons, { text: ui.symbols.plus + " Add", onClick: add });
  new ui.Button(buttons, { text: ui.symbols.close + " Cancel", onClick: showList });
  issuer.focus();
}

// Escape leaves the scanner and the form
ui.onKey((ev) => {
  if (ev.key === "Escape" && (state.page === "scan" || state.page === "type")) {
    showList();
    return true;
  }
  return false;
});

// --- start ---------------------------------------------------------------------

restore();
showList();
console.log(`totp ready (clock ${state.clockSet ? "set" : "not set"})`);

runSelfTest().then((st) => {
  state.selftest = st;
  console.log(`totp selftest: ${st.passed} passed, ${st.failed.length} failed`);
  for (const f of st.failed) console.log("totp selftest FAIL:", f);
  if (st.failed.length && state.page === "list") showList();
});
