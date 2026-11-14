// The macros as the app edits them, and the table they make (with
// DigiMacroAsm's encoder, vendor/table.js).
//
// A row is { code, text, sealed }: text is the macro as typed, sealed a
// {secret <hex>} read from the board that GapKeep cannot open (it has not
// got the key), kept apart and written back as it came, as the page does.
//
// With the board's key (setKey(): made here, or scanned from its QR code)
// secrets are text, {secret} and what follows it, sealed afresh each time
// the table is written. Sealing takes a random nonce, so the table's bytes
// differ each time: what tells the screen from the board (snapshot()) seals
// with a fixed sequence instead, and is the same for the same macros.
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
const EMPTY_IR = /\{\s*IR\s*\}/i;

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The board's {totp}: HMAC-SHA1, six digits, every 30 s
export const totpFits = (a) => a.algorithm === "SHA1" && a.digits === 6 && a.period === 30;

export class Macros {
  constructor() {
    this.rows = [{ code: ".", text: "" }];
    this.blobs = [];            // {totp ~N}: blobs[N - 1], 80 hex digits
    this.accounts = new Map();  // {totp #N}: imported accounts, by number
    this.key = null;            // the board's key for secrets, if given
  }

  // The key secrets are sealed and opened with (16 bytes), or null. Rows
  // sealed without it are opened, those it opens.
  setKey(key) {
    if (this.key) this.key.fill(0);
    this.key = key ? Uint8Array.from(key) : null;
    if (!this.key) return 0;
    let opened = 0;
    const open = (blob) => T.openSecret(this.key, blob);
    this.rows = this.rows.map((r) => {
      if (!r.sealed) return r;
      try {
        const text = this.hide(T.decodeMacro(T.encodeMacro(this.full(r)), open));
        if (SEALED.test(text)) return r;        // not this key's: still sealed
        opened++;
        return { code: r.code, text };
      } catch (e) {
        return r;               // not this key's: it stays sealed
      }
    });
    return opened;
  }

  // The table from the board's EEPROM (bytes from 0 through the check value).
  // With a key, its secrets open (a wrong key: secret-wrong-key).
  load(ee) {
    this.blobs = [];
    const got = T.decodeTable(ee, this.key).map(({ code, text }) => {
      const m = SEALED.exec(text);
      const row = m ? { code, text: m[1], sealed: m[2] } : { code, text };
      row.text = this.hide(row.text);
      return row;
    });
    this.rows = got.length ? got : [{ code: ".", text: "" }];
    return got.length;
  }

  // The keyboard layout changes from `from` to `to` (table.js's names): the
  // keystrokes stay, and the text says what they type on the new one. A
  // board's "vários", written for US International, reads as "v'arios" on
  // US, and back. The table.js layout is left at `to`. Tokens ({totp #N},
  // {totp ~N}, an {IR} with no button) and a part still sealed stay as they
  // are, and so does any stretch the layout change does not alter (as typed,
  // not as the decoder would write it). A row that would not encode is left
  // alone. Returns how many rows changed.
  relayout(from, to) {
    const PROTECT = new RegExp(`${TOKEN.source}|${EMPTY_IR.source}`, "gi");
    const seal = this.key ? (plain) => T.sealSecret(this.key, plain) : null;
    const open = this.key ? (blob) => T.openSecret(this.key, blob) : null;
    const again = (piece) => {
      if (piece === "") return piece;
      T.setLayout(from);
      const bytes = T.encodeMacro(piece, seal);
      const before = T.decodeMacro(bytes, open);
      T.setLayout(to);
      const after = T.decodeMacro(bytes, open);
      return after === before ? piece : after;
    };
    let changed = 0;
    this.rows = this.rows.map((r) => {
      try {
        const out = [];
        let at = 0;
        for (const m of r.text.matchAll(PROTECT)) {
          out.push(again(r.text.slice(at, m.index)), m[0]);
          at = m.index + m[0].length;
        }
        out.push(again(r.text.slice(at)));
        const text = out.join("");
        if (text === r.text) return r;
        changed++;
        return { ...r, text };
      } catch (e) {
        return r;
      } finally {
        T.setLayout(to);
      }
    });
    T.setLayout(to);
    return changed;
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
    if (PLAIN_SECRET.test(row.text) && !this.key) {
      throw new MacroError(N_("{{secret}} needs the board's key: make one, or scan its QR code, in Secrets' key"));
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
        table = this.table(false);
      } catch (e) {
        error = e;
      }
    }
    // snapshot: as snapshot() says it, without encoding it all again
    const snapshot = table ? Array.from(table).join(",") : null;
    return { each, total, error, ok: !error && each.every((e) => !e.error), snapshot };
  }

  // The table's bytes, as written to the board (from address 0). Secrets are
  // sealed with fresh nonces, unless forBoard is false: then with a fixed
  // sequence, for snapshot().
  table(forBoard = true) {
    const rows = this.rows.map((r) => ({ code: r.code, text: this.full(r) }));
    if (!this.key) return T.encodeTable(rows);
    if (forBoard) return T.encodeTable(rows, { key: this.key, check: T.keyCheck(this.key) });
    let x = 0x9e3779b9;
    const fixed = (n) => Uint8Array.from({ length: n }, () => {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) % 255 + 1;       // never zero, as sealSecret wants
    });
    return T.packTable(rows.map((r) => [r.code, T.encodeMacro(r.text, (plain) => T.sealSecret(this.key, plain, fixed))]));
  }

  // To tell what is on screen from what is on the board: the bytes
  snapshot() {
    try {
      return Array.from(this.table(false)).join(",");
    } catch (e) {
      return null;
    }
  }

  // Rows with a secret this session can't open
  hasSealed() {
    return this.rows.some((r) => r.sealed);
  }

  // The first {IR} with no button: [row, the {IR}'s text], or null
  emptyIR() {
    for (let i = 0; i < this.rows.length; i++) {
      const m = EMPTY_IR.exec(this.rows[i].text);
      if (m) return [i, m[0]];
    }
    return null;
  }

  // Fills that {IR} with a button ("{IR aa cc}")
  fillIR(i, ir) {
    this.rows[i].text = this.rows[i].text.replace(EMPTY_IR, ir);
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
export const keyCheck = (key) => T.keyCheck(key);
export const irHeard = (text) => T.irHeard(text);
export const FW_TOTP = T.FW_TOTP;
