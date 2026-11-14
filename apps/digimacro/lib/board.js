// A DigiMacro board, as its configuration page (DigiMacroAsm's web/index.html)
// talks to it: one 36-byte feature report on the vendor collection, both
// ways, set to ask and got to see the answer (DigiMacroAsm README, "The
// protocol"):
//
//   [0] command   [1] address low   [2] address high   [3] count   [4..35] data
//
// What every request but INFO needs: the window, which the person opens by
// holding the pad, and the password, if the board has one. The board has one
// report for everybody, so an answer counts only if it echoes the question
// (vendor/coreupdate.js's askOwn, copied from DigiMacroAsm).
//
// Runs under GapKeep (gk:usb: usbIo()) and under Node against a fake board
// (tests/digimacro). Nothing here logs: what a report carries may be a
// password, a macro or a key.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { askOwn, coreInfo, CU_CORE_APP } from "../vendor/coreupdate.js";

export const VND_ID = 2;        // the vendor report's id
export const VND_LEN = 36;
export const DATA_AT = 4;       // command, address low, address high, count
export const CHUNK = VND_LEN - DATA_AT;

export const F_INFO = 0x40, F_READ = 0x60, F_WRITE = 0x61;
export const F_UNLOCK = 0x62, F_SETPASS = 0x63, F_CLOCK = 0x6c, F_REFUSED = 0xee;
export const F_RESTART = 0x42;          // leave the bus and come back (firmware 8 on)
export const F_LEARN = 0x69;            // type the remote's next button, as hex
export const FW_FIRST_RESTART = 8;

export const ST_OPEN = 0x01, ST_PASSWORD = 0x02, ST_UNLOCKED = 0x04;
export const ST_SOFTLOCK = 0x08, ST_HARDLOCK = 0x10, ST_KEY = 0x80, ST_NOBOOT = 0x80;

export const FW_TOTP = 18;              // the firmware with {totp} and the clock
export const FW_FIRST_FUSES = 8;        // v1 firmware that reports the fuses
export const PASSWORD_MAX = 12;         // bytes of UTF-8

// The EEPROM's settings (DigiMacroAsm README, "The EEPROM")
export const SERIAL_ADDR = 0x1e0;
export const CHECK_ADDR = 0x1e4;        // the secrets' key's check value, 8 bytes
export const LOCK_ADDR = 0x1ec, LOCK_LEN = 6, LOCK_OFF = 0xff;
export const KEY_WAIT_ADDR = 0x1f2;
export const AUTO_ADDR = 0x1f3, AUTO_NONE = 0xff;

export class Refused extends Error {
  constructor() {
    super("REFUSED");
    this.refused = true;
  }
}

// Whether the board wants the password before it will answer: it has one,
// and either it has not been given or a hard lock wants it again (as the
// page's wantsPassword).
export const wantsPassword = (s) => !!(s & ST_PASSWORD) && (!(s & ST_UNLOCKED) || !!(s & ST_HARDLOCK));

// UTF-8 bytes of a string (QuickJS has no TextEncoder)
export function utf8Bytes(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

// What INFO says (README, "The protocol"): v2 boards (protocol 3) give the
// core's version in [4] and the firmware's in [13]; v1 the firmware's in [4].
export function parseInfo(b) {
  const core = coreInfo(b);
  const bare = !!core && !(core.state & CU_CORE_APP);
  return {
    magic: String.fromCharCode(b[1], b[2]) === "DM",
    protocol: b[3],
    core,
    bare,                                       // only the core answers
    firmware: bare ? 0 : core ? core.app : b[4],
    state: b[7],
    fuses: core || b[4] >= FW_FIRST_FUSES ? [b[8], b[9], b[10], b[11]] : null,
  };
}

// The hardened-mode checklist, as the page's hardening(): each item a key
// (main.js says it in words) and whether the board passes it.
export function hardening(info) {
  if (!info.fuses) return null;
  const [, high, ext, lock] = info.fuses;
  const s = info.state;
  if (info.core) {
    return [
      { key: "hd-pass", ok: !!(s & ST_PASSWORD) },
      { key: "hd-lock", ok: (lock & 0x03) === 0 },
      { key: "hd-eesave", ok: !!(high & 0x08) },
      { key: "hd-dwen", ok: !!(high & 0x40) },
      { key: "hd-selfprg", ok: !(ext & 0x01) },
      { key: "hd-bod", ok: (high & 0x07) !== 0x07 },
    ];
  }
  return [
    { key: "hd-boot", ok: !!(s & ST_NOBOOT) },
    { key: "hd-lock", ok: (lock & 0x03) === 0 },
    { key: "hd-eesave", ok: !!(high & 0x08) },
    { key: "hd-dwen", ok: !!(high & 0x40) },
  ];
}

// The lockout's six bytes: three settings, three counters stored inverted
export function parseLock(b) {
  const on = b[0] !== 0 && b[0] !== LOCK_OFF;
  return {
    on,
    soft: on ? b[0] : 0,
    hard: b[1] === LOCK_OFF ? 0 : b[1],
    tens: b[2] >= 1 && b[2] <= 240 ? b[2] : 6,
    misses: 255 - b[3], softs: 255 - b[4], cleared: 255 - b[5],
  };
}

// The bytes saving the lockout writes: the settings, and the two running
// counts back to zero (the record of hard locks lifted stays: it is history)
export function lockBytes({ on, soft, hard, tens }) {
  return on ? Uint8Array.from([soft, hard || LOCK_OFF, tens, 0xff, 0xff])
            : Uint8Array.from([LOCK_OFF, LOCK_OFF, LOCK_OFF, 0xff, 0xff]);
}

export const serialText = (b) =>
  ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0).toString(16).toUpperCase().padStart(8, "0");

// The transport over gk:usb: SET_REPORT and GET_REPORT of the vendor
// report. Whether the board puts the report id in front of an answer is
// looked at, as the page does: no command is 2, so a leading 2 is the id.
export function usbIo(handle) {
  let idInPayload = null;
  return {
    send: (out) => handle.setFeatureReport(VND_ID, out),
    receive: async () => {
      const b = await handle.getFeatureReport(VND_ID, VND_LEN + 1);
      if (idInPayload === null) idInPayload = b[0] === VND_ID;
      const a = idInPayload ? b.slice(1) : b;
      if (a.length < VND_LEN) {
        const full = new Uint8Array(VND_LEN);
        full.set(a);
        a.fill(0);
        return full;
      }
      return a;
    },
  };
}

export class Board {
  constructor(io) {
    this.io = io;
  }

  // One question, its own answer. Refused: the board said no (0xEE).
  async ask(cmd, addr = 0, count = 0, data = null) {
    const b = await askOwn(this.io, cmd, addr, count, data);
    if (b[0] === F_REFUSED) throw new Refused();
    return b;
  }

  async info() {
    return parseInfo(await this.ask(F_INFO));
  }

  async state() {
    return (await this.ask(F_INFO))[7];
  }

  // In chunks, as the page reads: a report carries 32 bytes
  async read(addr, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += CHUNK) {
      const n = Math.min(CHUNK, len - i);
      const b = await this.ask(F_READ, addr + i, n);
      out.set(b.slice(DATA_AT, DATA_AT + n), i);
      b.fill(0);
    }
    return out;
  }

  // Written 32 bytes at a time, then read back: written when the EEPROM
  // holds it, not when the board says so. Throws a Mismatch with where.
  async write(addr, bytes) {
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const part = bytes.slice(i, i + CHUNK);
      await this.ask(F_WRITE, addr + i, part.length, part);
      part.fill(0);
    }
    const back = await this.read(addr, bytes.length);
    const bad = bytes.findIndex((v, i) => back[i] !== v);
    const result = bad < 0 ? null : { at: addr + bad, wrote: bytes[bad], read: back[bad] };
    back.fill(0);
    if (result) {
      const e = new Error("MISMATCH");
      e.mismatch = result;
      throw e;
    }
  }

  // The password, asked once and never again on its own: a wrong one counts
  // toward the lockout. True if the board took it; false if it said no (a
  // wrong password, or the window shut: the caller asks INFO which).
  async unlock(password) {
    const bytes = utf8Bytes(password).slice(0, PASSWORD_MAX);
    const b = await askOwn(this.io, F_UNLOCK, 0, bytes.length, bytes, true);
    bytes.fill(0);
    if (b) {
      const ok = b[0] !== F_REFUSED;
      b.fill(0);
      return ok;
    }
    return !!((await this.state()) & ST_UNLOCKED);   // another program's answer took its place
  }

  // A new password (UTF-8, 1 to 12 bytes), or none
  async setPassword(password) {
    const bytes = password === null ? new Uint8Array(0) : utf8Bytes(password);
    if (bytes.length > PASSWORD_MAX) throw new RangeError("PASSWORD_TOO_LONG");
    await this.ask(F_SETPASS, 0, bytes.length, bytes.length ? bytes : null);
    bytes.fill(0);
  }

  // LEARN: the board types the next button a remote sends it (within ten
  // seconds), as "aa cc" in hex, on its keyboard. No hold, no password: it
  // reads nothing. Refused by a board without the remote.
  async learn() {
    await this.ask(F_LEARN);
  }

  // RESTART: the board leaves the bus and comes back, as if replugged (its
  // serial number read again). Its answer may never come.
  async restart() {
    try {
      await this.ask(F_RESTART);
    } catch (e) {
      if (e instanceof Refused) throw e;
    }
  }

  // Firmware 18's clock: seconds since 1970, UTC, four bytes little-endian
  async setClock(seconds) {
    const s = Math.floor(seconds);
    await this.ask(F_CLOCK, 0, 4, Uint8Array.from([s & 255, (s >>> 8) & 255, (s >>> 16) & 255, (s >>> 24) & 255]));
  }
}

// What the board types, from its keyboard's reports (interrupt endpoint
// 0x81: the report id 1, the modifiers, a reserved byte and three keys):
// the keys pressed, as characters, for LEARN's hex digits and the space.
// By usage, so whatever the computer's layout, as the page reads them by
// position (table.js's irKeyChar). Other keys and other reports (the mouse,
// id 3) are none of LEARN's.
export const HID_REPORT_KBD = 1;
const LEARN_CHARS = { 0x04: "a", 0x05: "b", 0x06: "c", 0x07: "d", 0x08: "e", 0x09: "f", 0x27: "0", 0x2c: " " };
for (let u = 0x1e; u <= 0x26; u++) LEARN_CHARS[u] = String(u - 0x1d);

export class KeyReader {
  constructor() {
    this.down = new Set();
  }

  // The characters pressed in this report (keys not down in the last one)
  feed(report) {
    if (report.length < 4 || report[0] !== HID_REPORT_KBD) return "";
    const now = new Set(Array.from(report.slice(3)).filter((k) => k !== 0));
    let out = "";
    for (const k of now) {
      if (!this.down.has(k) && k in LEARN_CHARS) out += LEARN_CHARS[k];
    }
    this.down = now;
    return out;
  }
}
