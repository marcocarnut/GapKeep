// The macros as the app edits them, and the table they make (with
// DigiMacroAsm's encoder, vendor/table.js).
//
// A row is { code, text, sealed }: text is the macro as typed, sealed a
// {secret <hex>} read from the board that GapKeep cannot open (it has no
// key), kept apart and written back as it came, as the page does.
//
// TOTP keys never show as text. In a row's text:
//   {totp #N}  account N imported in this session (lib/parse.js): its key
//              is in RAM only, and goes into the table as the board's
//              {totp}: the HMAC-SHA1 midstates (table.js's totpBlob)
//   {totp ~N}  a {totp} read from the board (or written by this session):
//              its 40 bytes, as table.js reads them back, {totp @<80 hex>},
//              which are as good as the key
// Both are expanded only when the table is encoded.
//
// Runs under GapKeep and under Node (tests/digimacro). Messages: N_()
// marks English for t() in main.js, which translates; they never quote a key.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as T from "../vendor/table.js";

const N_ = (s) => s;

export class MacroError extends Error {
  constructor(key, params = {}) {
    super(key.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)));
    this.key = key;
    this.params = params;
  }
}

const TOKEN = /\{\s*totp\s+([#~])(\d+)\s*\}/gi;
const BLOB = /\{\s*totp\s+@([0-9a-fA-F]{80})\s*\}/g;
const SEALED = /^([^]*)(\{secret!? [0-9a-f]+\})$/;
const PLAIN_SECRET = /\{\s*secret/i;

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The board's {totp}: HMAC-SHA1, six digits, every 30 s
export const totpFits = (a) => a.algorithm === "SHA1" && a.digits === 6 && a.period === 30;

export class Macros {
  constructor() {
    this.rows = [{ code: ".", text: "" }];
    this.blobs = [];            // {totp ~N}: blobs[N - 1], 80 hex digits
    this.accounts = new Map();  // {totp #N}: imported accounts, by number
  }

  // The table from the board's EEPROM (bytes from 0 through the check value)
  load(ee) {
    this.blobs = [];
    const got = T.decodeTable(ee).map(({ code, text }) => {
      const m = SEALED.exec(text);
      const row = m ? { code, text: m[1], sealed: m[2] } : { code, text };
      row.text = this.hide(row.text);
      return row;
    });
    this.rows = got.length ? got : [{ code: ".", text: "" }];
    return got.length;
  }

  // {totp @hex} as {totp ~N}
  hide(text) {
    return text.replace(BLOB, (m, h) => {
      const hex = h.toLowerCase();
      let i = this.blobs.indexOf(hex);
      if (i < 0) i = this.blobs.push(hex) - 1;
      return `{totp ~${i + 1}}`;
    });
  }

  // The text as table.js reads it: the tokens expanded, the sealed part back
  full(row) {
    if (PLAIN_SECRET.test(row.text)) {
      throw new MacroError(N_("{{secret}} needs the board's key, which GapKeep has not got: write it with DigiMacro's own page"));
    }
    const text = row.text.replace(TOKEN, (m, kind, digits) => {
      const n = Number(digits);
      if (kind === "~") {
        if (!(n >= 1 && n <= this.blobs.length)) throw new MacroError(N_("{{totp ~{n}}}: no such key read from the board"), { n });
        return `{totp @${this.blobs[n - 1]}}`;
      }
      const a = this.accounts.get(n);
      if (!a) throw new MacroError(N_("{{totp #{n}}}: there is no imported account {n}"), { n });
      if (!totpFits(a)) throw new MacroError(N_("{{totp #{n}}}: the board's codes are SHA-1, 6 digits, every 30 s; this account's are not"), { n });
      const blob = T.totpBlob(a.secret);
      const hex = hexOf(blob);
      blob.fill(0);
      return `{totp @${hex}}`;
    });
    return text + (row.sealed || "");
  }

  // Each row encoded (bytes or error), the total, and whether it all fits
  state() {
    const each = this.rows.map((r) => {
      try {
        return { bytes: T.encodeMacro(this.full(r)), error: null };
      } catch (e) {
        return { bytes: null, error: e };
      }
    });
    let error = null, total = 1;               // the terminator
    const seen = new Set();
    this.rows.forEach((r, i) => {
      try {
        const h = T.header(r.code);
        if (seen.has(h) && !each[i].error) each[i].error = new MacroError(N_("\"{what}\" is used twice"), { what: r.code });
        seen.add(h);
      } catch (e) {
        if (!each[i].error) each[i].error = e;
      }
      if (each[i].bytes) total += each[i].bytes.length + 2;
    });
    if (total > T.TABLE_TOP) error = new MacroError(N_("{n} bytes of table, and only {fits} fit"), { n: total, fits: T.TABLE_TOP });
    // the table as a whole (jumps to nowhere, loops), once every row encodes
    let table = null;
    if (!error && each.every((e) => !e.error)) {
      try {
        table = this.table();
      } catch (e) {
        error = e;
      }
    }
    // snapshot: as snapshot() says it, without encoding it all again
    const snapshot = table ? Array.from(table).join(",") : null;
    return { each, total, error, ok: !error && each.every((e) => !e.error), snapshot };
  }

  // The table's bytes, as written to the board (from address 0)
  table() {
    return T.encodeTable(this.rows.map((r) => ({ code: r.code, text: this.full(r) })));
  }

  // To tell what is on screen from what is on the board: the bytes
  snapshot() {
    try {
      return Array.from(this.table()).join(",");
    } catch (e) {
      return null;
    }
  }

  // After a write: the imported accounts written are on the board now, so
  // they become {totp ~N} like any other read from it, and their keys are
  // wiped. Returns how many. (Those not used stay, for another macro.)
  settle() {
    const used = new Set();
    for (const r of this.rows) {
      r.text = this.hide(r.text.replace(TOKEN, (m, kind, digits) => {
        if (kind !== "#") return m;
        used.add(Number(digits));
        return this.full({ text: m });
      }));
    }
    for (const n of used) {
      this.accounts.get(n).secret.fill(0);
      this.accounts.delete(n);
    }
    return used.size;
  }

  forgetAccounts() {
    for (const a of this.accounts.values()) a.secret.fill(0);
    this.accounts.clear();
  }

  // The codes a power-on macro may name, with their header bytes
  codes() {
    const out = [];
    for (const r of this.rows) {
      try {
        out.push({ code: r.code, header: T.header(r.code) });
      } catch (e) { /* not a code yet */ }
    }
    return out;
  }

  hasSecret() {
    return this.rows.some((r) => r.sealed || PLAIN_SECRET.test(r.text));
  }

  // The next free code, for a new row (the page's order)
  nextCode() {
    const used = new Set(this.rows.map((r) => r.code));
    return [".", "-", "..", ".-", "-.", "--", "...", "..-", ".-.", ".--", "-..", "-.-", "--.", "---"]
      .find((c) => !used.has(c)) || "";
  }

  // {totp #N} added at the end of row i
  addTotp(i, n) {
    this.rows[i].text += `{totp #${n}}`;
  }
}

export const tappable = (code) => T.tappable(code);
export const TABLE_TOP = T.TABLE_TOP;
export const AUTO_NONE = T.AUTO_NONE;
export const LAYOUTS = Object.keys(T.LAYOUTS);
export const layoutLabel = (name) => T.LAYOUTS[name].label;
export const setLayout = T.setLayout;
export const getLayout = T.getLayout;
export const setMessages = T.setMessages;
export const CHECK_ADDR = T.CHECK_ADDR;
export const FW_TOTP = T.FW_TOTP;
