// What a QR code (or the person) gives us, turned into accounts:
//
//   otpauth://totp/LABEL?secret=...&issuer=...&algorithm=...&digits=...&period=...
//     Google's "Key Uri Format"
//     (https://github.com/google/google-authenticator/wiki/Key-Uri-Format).
//   otpauth-migration://offline?data=<base64 protobuf>
//     Google Authenticator's "Transfer accounts" export. Google doesn't
//     document it; the field numbers below are those of the reverse-
//     engineered migration.proto in https://github.com/dim13/otpauth
//     (migration/migration.proto), which the other open decoders (Aegis's
//     GoogleAuthImporter, otpauth-migration-decoder) agree with.
//
// An account: { issuer, name, secret (Uint8Array), algorithm ("SHA1",
// "SHA256", "SHA512"), digits (6 or 8), period (s) }.
//
// Error messages are shown on screen and may be logged: they never quote
// the secret.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export class ParseError extends Error {}
const fail = (message) => {
  throw new ParseError(message);
};

export const MAX_PERIOD = 86400;

// --- Base32 (RFC 4648, section 6) ---------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Case-insensitive, spaces ignored, "=" padding optional. A length that
// no whole number of bytes encodes (1, 3 or 6 characters over a multiple
// of 8) is refused: it is usually a character missing or one too many.
// Bits left over after the last whole byte are ignored, as most
// authenticators do.
export function base32Decode(text) {
  let s = text.replace(/[\s]/g, "").toUpperCase();
  const pad = s.indexOf("=");
  if (pad >= 0) {
    if (!/^=+$/.test(s.slice(pad))) fail("Padding (=) may only come at the end of the key.");
    s = s.slice(0, pad);
  }
  if (s.length === 0) fail("The key is empty.");
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let bits = 0, value = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B32.indexOf(s[i]);
    if (v < 0) fail(`Character ${i + 1} of the key is not Base32 (only A-Z and 2-7: no 0, 1, 8 or 9).`);
    value = ((value << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >>> bits) & 0xff;
    }
  }
  if ([1, 3, 6].includes(s.length % 8)) {
    out.fill(0);
    fail(`A Base32 key can't be ${s.length} characters long: is one missing, or one too many?`);
  }
  return out;
}

// --- Base64 (RFC 4648, section 4; "-" and "_" of section 5 accepted too) -----

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Decode(text) {
  let s = text.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) fail("The export's data is not valid Base64.");
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let bits = 0, value = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i]);
    if (v < 0) fail("The export's data is not valid Base64.");
    value = ((value << 6) | v) & 0x1fff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >>> bits) & 0xff;
    }
  }
  return out;
}

// --- UTF-8 (strict: no overlong forms, surrogates or values past U+10FFFF) --

export function utf8Decode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      continue;
    }
    const n = b >= 0xf0 && b <= 0xf4 ? 3 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xc2 && b < 0xe0 ? 1 : -1;
    if (n < 0 || i + n > bytes.length) fail("A name in the code is not valid UTF-8.");
    let c = b & (0x3f >> n);
    for (let k = 0; k < n; k++) {
      const x = bytes[i++];
      if ((x & 0xc0) !== 0x80) fail("A name in the code is not valid UTF-8.");
      c = (c << 6) | (x & 0x3f);
    }
    if ((n === 2 && (c < 0x800 || (c >= 0xd800 && c < 0xe000))) || (n === 3 && (c < 0x10000 || c > 0x10ffff))) {
      fail("A name in the code is not valid UTF-8.");
    }
    s += String.fromCodePoint(c);
  }
  return s;
}

// --- URIs -------------------------------------------------------------------

function percentDecode(s, what) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    fail(`The ${what} has a broken %-escape.`);
  }
}

// Query parameters: "+" is a space there (as Android's Uri, which Google
// Authenticator uses, reads them); in the label it is a plus sign
// ("alice+work@example.com").
function parseQuery(query) {
  const params = new Map();
  for (const part of query.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    const raw = eq < 0 ? "" : part.slice(eq + 1);
    if (params.has(key)) fail(`The parameter "${key}" is given twice.`);
    params.set(key, key === "secret" || key === "data" ? raw : raw.replace(/\+/g, " "));
  }
  return params;
}

const cleanName = (s) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim();

export function parseOtpauth(text) {
  const m = /^otpauth:\/\/([^/?#]*)\/?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(text.trim());
  if (!m) fail("This is not an otpauth:// address.");
  const type = m[1].toLowerCase();
  if (type === "hotp") fail("This is an HOTP (counter-based) key. Only time-based (TOTP) keys are supported.");
  if (type !== "totp") fail(`Unknown kind of key "${m[1]}": only TOTP is supported.`);
  const label = cleanName(percentDecode(m[2], "label"));
  const params = parseQuery(m[3] || "");

  if (!params.has("secret") || params.get("secret") === "") fail("The code has no secret.");
  let secret;
  try {
    secret = base32Decode(percentDecode(params.get("secret"), "secret"));
  } catch (e) {
    if (e instanceof ParseError) fail("The secret is not valid Base32. " + e.message);
    throw e;
  }

  let algorithm = "SHA1";
  if (params.has("algorithm")) {
    algorithm = params.get("algorithm").toUpperCase().replace("-", "");
    if (!["SHA1", "SHA256", "SHA512"].includes(algorithm)) {
      fail(`Unknown algorithm "${params.get("algorithm").slice(0, 16)}": SHA1, SHA256 or SHA512 expected.`);
    }
  }
  let digits = 6;
  if (params.has("digits")) {
    const d = params.get("digits");
    if (d !== "6" && d !== "8") fail(`Codes of ${d.slice(0, 8)} digits are not supported: 6 or 8.`);
    digits = Number(d);
  }
  let period = 30;
  if (params.has("period")) {
    const p = params.get("period");
    if (!/^[0-9]{1,6}$/.test(p) || Number(p) < 1 || Number(p) > MAX_PERIOD) {
      fail(`Bad period "${p.slice(0, 8)}": a whole number of seconds from 1 to ${MAX_PERIOD} expected.`);
    }
    period = Number(p);
  }

  // "Issuer:account" (spaces allowed after the colon); the issuer
  // parameter wins over the prefix
  let issuer = "", name = label;
  const colon = label.indexOf(":");
  if (colon >= 0) {
    issuer = cleanName(label.slice(0, colon));
    name = cleanName(label.slice(colon + 1));
  }
  if (params.has("issuer")) issuer = cleanName(percentDecode(params.get("issuer"), "issuer"));
  if (!issuer && !name) name = "(no name)";
  return { issuer, name, secret, algorithm, digits, period };
}

// --- Google Authenticator's export (protocol buffers) ----------------------

// The wire format: https://protobuf.dev/programming-guides/encoding/
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  get done() {
    return this.pos >= this.end;
  }
  byte() {
    if (this.pos >= this.end) fail("The export's data is cut short.");
    return this.buf[this.pos++];
  }
  // a varint as { lo, hi }: two unsigned 32-bit halves
  varint() {
    let lo = 0, hi = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const b = this.byte(), v = b & 0x7f;
      if (shift < 28) lo |= v << shift;
      else if (shift === 28) {
        lo |= v << 28;
        hi |= v >>> 4;
      } else hi |= v << (shift - 32);
      if (!(b & 0x80)) return { lo: lo >>> 0, hi: hi >>> 0 };
    }
    fail("The export's data is malformed (a number is too long).");
  }
  // a field's tag: [field number, wire type]
  tag() {
    const { lo, hi } = this.varint();
    if (hi !== 0 || lo >>> 3 === 0) fail("The export's data is malformed (a bad field).");
    return [lo >>> 3, lo & 7];
  }
  bytes() {
    const { lo, hi } = this.varint();
    if (hi !== 0 || lo > this.end - this.pos) fail("The export's data is cut short.");
    const out = this.buf.subarray(this.pos, this.pos + lo);
    this.pos += lo;
    return out;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.advance(8);
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.advance(4);
    else fail("The export's data is malformed (an unknown kind of field).");
  }
  advance(n) {
    if (n > this.end - this.pos) fail("The export's data is cut short.");
    this.pos += n;
  }
}

function expectWire(wire, want) {
  if (wire !== want) fail("The export's data is malformed (a field of the wrong kind).");
}

// OtpParameters: 1 secret (bytes), 2 name, 3 issuer (strings), 4 algorithm
// (0 unspecified, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5), 5 digits
// (0 unspecified, 1 six, 2 eight), 6 type (0 unspecified, 1 HOTP, 2 TOTP),
// 7 counter (uint64, HOTP only), 8 unique_id (string).
function parseOtpParameters(r) {
  const p = { secret: null, name: "", issuer: "", algorithm: 0, digits: 0, type: 0 };
  while (!r.done) {
    const [field, wire] = r.tag();
    switch (field) {
      case 1: expectWire(wire, 2); p.secret = r.bytes(); break;
      case 2: expectWire(wire, 2); p.name = utf8Decode(r.bytes()); break;
      case 3: expectWire(wire, 2); p.issuer = utf8Decode(r.bytes()); break;
      case 4: expectWire(wire, 0); p.algorithm = r.varint(); break;
      case 5: expectWire(wire, 0); p.digits = r.varint(); break;
      case 6: expectWire(wire, 0); p.type = r.varint(); break;
      default: r.skip(wire);    // counter, unique_id, anything newer
    }
  }
  return p;
}

const enumValue = (v) => (v && v.hi === 0 ? v.lo : v ? -1 : 0);

// The accounts of one OtpParameters, or the reason it is refused
function migrationAccount(p) {
  // the name GA shows is "issuer:name" or just "name"
  let name = cleanName(p.name), issuer = cleanName(p.issuer);
  const colon = name.indexOf(":");
  if (colon >= 0) {
    if (!issuer) issuer = cleanName(name.slice(0, colon));
    name = cleanName(name.slice(colon + 1));
  }
  const title = (issuer ? issuer + ": " : "") + (name || "(no name)");
  const type = enumValue(p.type);
  if (type === 1) return { refused: `${title}: an HOTP (counter-based) key, not supported.` };
  if (type !== 2) return { refused: `${title}: not a TOTP key.` };
  const algorithm = [null, "SHA1", "SHA256", "SHA512"][enumValue(p.algorithm) || 1];
  if (!algorithm) return { refused: `${title}: its algorithm (${enumValue(p.algorithm) === 4 ? "MD5" : "unknown"}) is not supported.` };
  const digits = [null, 6, 8][enumValue(p.digits) || 1];
  if (!digits) return { refused: `${title}: an unknown number of digits.` };
  if (!p.secret || p.secret.length === 0) return { refused: `${title}: no secret.` };
  return {
    account: { issuer, name: name || (issuer ? "" : "(no name)"), secret: p.secret.slice(), algorithm, digits, period: 30 },
  };
}

// MigrationPayload: 1 otp_parameters (repeated), 2 version, 3 batch_size,
// 4 batch_index, 5 batch_id (int32s).
export function parseMigration(text) {
  const m = /^otpauth-migration:\/\/offline\/?\?(.*)$/i.exec(text.trim());
  if (!m) fail("This is not a Google Authenticator export (otpauth-migration://offline?data=...).");
  const params = parseQuery(m[1]);
  if (!params.has("data") || !params.get("data")) fail("The export has no data.");
  const bytes = base64Decode(percentDecode(params.get("data"), "export's data"));
  const r = new Reader(bytes);
  const accounts = [], refused = [];
  const batch = { size: 1, index: 0, id: 0 };
  while (!r.done) {
    const [field, wire] = r.tag();
    if (field === 1) {
      expectWire(wire, 2);
      const sub = r.bytes();
      const a = migrationAccount(parseOtpParameters(new Reader(sub)));
      if (a.account) accounts.push(a.account);
      else refused.push(a.refused);
    } else if (field >= 3 && field <= 5) {
      expectWire(wire, 0);
      const v = r.varint().lo | 0;    // int32: the low half, signed
      if (field === 3) batch.size = v;
      else if (field === 4) batch.index = v;
      else batch.id = v;
    } else r.skip(wire);              // version, anything newer
  }
  bytes.fill(0);
  if (batch.size < 1 || batch.size > 1000 || batch.index < 0 || batch.index >= batch.size) {
    fail("The export's part number is wrong.");
  }
  if (accounts.length === 0 && refused.length === 0) fail("The export holds no accounts.");
  return { accounts, refused, batch };
}

// Anything scanned: { kind: "totp", account } or { kind: "migration", ... }
export function parseCode(text) {
  if (text === null) fail("This QR code holds binary data, not an authenticator key.");
  const t = text.trim();
  if (/^otpauth-migration:/i.test(t)) return { kind: "migration", ...parseMigration(t) };
  if (/^otpauth:/i.test(t)) return { kind: "totp", account: parseOtpauth(t) };
  fail("This QR code is not an authenticator key (otpauth://totp/...) or a Google Authenticator export.");
}
