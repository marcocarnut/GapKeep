// Bytes: hex, Base64, comparison, and a reader and writer for Bitcoin's
// serialization (little-endian integers, CompactSize lengths).
//
// Pure: no zerogap imports, so Node and other apps (a signer) use it too.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What every parser here throws: the message says what is wrong, for people.
export class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecodeError";
  }
}

const HEX = "0123456789abcdef";

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

const hexValue = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);

// Either case; no spaces. Throws DecodeError.
export function fromHex(text) {
  if (text.length % 2) throw new DecodeError("hex: odd number of digits");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const h = hexValue(text.charCodeAt(2 * i)), l = hexValue(text.charCodeAt(2 * i + 1));
    if (h < 0 || l < 0) throw new DecodeError(`hex: not a hex digit at ${h < 0 ? 2 * i : 2 * i + 1}`);
    out[i] = (h << 4) | l;
  }
  return out;
}

export const isHex = (text) => text.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(text);

// Reversed hex, as txids are shown.
export const toHexReversed = (bytes) => toHex(Uint8Array.from(bytes).reverse());
export const fromHexReversed = (text) => fromHex(text).reverse();

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INV[B64.charCodeAt(i)] = i;

export function toBase64(bytes) {
  let s = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16;
    s += B64[n >> 18] + B64[(n >> 12) & 63] + "==";
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return s;
}

// Strict, as Python's b64decode(validate=True) (what Electrum uses): the
// standard alphabet, padding required, no other characters.
export function fromBase64(text) {
  if (text.length % 4) throw new DecodeError("Base64: the length is not a multiple of 4");
  let pad = 0;
  if (text.endsWith("==")) pad = 2;
  else if (text.endsWith("=")) pad = 1;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = text.charCodeAt(i + j);
      let v;
      if (c === 61 && i + 4 === text.length && j >= 4 - pad) v = 0;
      else {
        v = c < 128 ? B64_INV[c] : -1;
        if (v < 0) throw new DecodeError(`Base64: unexpected character at ${i + j}`);
      }
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// -1, 0, 1: byte-wise, a shorter prefix first (as BIP-174 sorts keys).
export function compare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const asciiBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// Reads Bitcoin's serialization. Every read past the end throws a
// DecodeError naming `what` was being read.
export class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = start;
    this.end = end;
  }
  get left() {
    return this.end - this.pos;
  }
  need(n, what) {
    if (n > this.end - this.pos) throw new DecodeError(`truncated: ${what} goes past the end of the data`);
  }
  u8(what = "a byte") {
    this.need(1, what);
    return this.b[this.pos++];
  }
  u16(what) {
    this.need(2, what);
    const p = this.pos;
    this.pos += 2;
    return this.b[p] | (this.b[p + 1] << 8);
  }
  u32(what = "a 32-bit number") {
    this.need(4, what);
    const p = this.pos;
    this.pos += 4;
    return (this.b[p] | (this.b[p + 1] << 8) | (this.b[p + 2] << 16) | (this.b[p + 3] << 24)) >>> 0;
  }
  i32(what) {
    return this.u32(what) | 0;
  }
  // A Number when below 2^53 (every amount that can exist), else a BigInt,
  // so writing it back gives the same bytes.
  u64(what = "a 64-bit number") {
    const lo = this.u32(what), hi = this.u32(what);
    if (hi < 0x200000) return hi * 4294967296 + lo;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  bytes(n, what = "data") {
    this.need(n, what);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  // CompactSize; refuses non-canonical encodings (as Bitcoin Core does).
  // Lengths above 2^53 can't be in any data that fits in memory.
  compactSize(what = "a length") {
    const first = this.u8(what);
    let n;
    if (first < 253) return first;
    if (first === 253) {
      n = this.u16(what);
      if (n < 253) throw new DecodeError(`${what}: non-canonical CompactSize`);
    } else if (first === 254) {
      n = this.u32(what);
      if (n < 0x10000) throw new DecodeError(`${what}: non-canonical CompactSize`);
    } else {
      n = this.u64(what);
      if (typeof n === "bigint" || n < 0x100000000) {
        throw new DecodeError(`${what}: ${typeof n === "bigint" ? "impossibly large" : "non-canonical CompactSize"}`);
      }
    }
    return n;
  }
  varBytes(what = "data") {
    const n = this.compactSize(`the length of ${what}`);
    return this.bytes(n, what);
  }
}

// Builds bytes, growing as needed.
export class Writer {
  constructor(size = 256) {
    this.b = new Uint8Array(size);
    this.n = 0;
  }
  room(k) {
    if (this.n + k <= this.b.length) return;
    let size = this.b.length * 2;
    while (size < this.n + k) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  u8(v) {
    this.room(1);
    this.b[this.n++] = v;
    return this;
  }
  u16(v) {
    this.room(2);
    this.b[this.n++] = v & 255;
    this.b[this.n++] = (v >>> 8) & 255;
    return this;
  }
  u32(v) {
    this.room(4);
    for (let i = 0; i < 4; i++) this.b[this.n++] = (v >>> (8 * i)) & 255;
    return this;
  }
  u64(v) {
    if (typeof v === "bigint") {
      this.u32(Number(v & 0xffffffffn));
      return this.u32(Number((v >> 32n) & 0xffffffffn));
    }
    this.u32(v % 4294967296);
    return this.u32(Math.floor(v / 4294967296));
  }
  bytes(bytes) {
    this.room(bytes.length);
    this.b.set(bytes, this.n);
    this.n += bytes.length;
    return this;
  }
  compactSize(v) {
    if (v < 253) return this.u8(v);
    if (v < 0x10000) return this.u8(253).u16(v);
    if (v < 0x100000000) return this.u8(254).u32(v);
    return this.u8(255).u64(v);
  }
  varBytes(bytes) {
    return this.compactSize(bytes.length).bytes(bytes);
  }
  done() {
    return this.b.slice(0, this.n);
  }
}

export const compactSizeLength = (v) => (v < 253 ? 1 : v < 0x10000 ? 3 : v < 0x100000000 ? 5 : 9);
