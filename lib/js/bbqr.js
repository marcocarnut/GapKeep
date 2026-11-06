// BBQr: a file as a series of QR codes ("Better Bitcoin QR", Coinkite,
// https://github.com/coinkite/BBQr, BBQr.md). Coldcard, Sparrow and others
// use it for PSBTs and transactions too big for one QR code.
//
// One file, pure JavaScript, no dependencies: it runs in zerogap apps
// (QuickJS), in Node and in browsers. Its home is zerogap's lib/js/; apps get
// copies made by tools/share_libs.py, other projects copy it byte for byte
// with its SHA-256. Tested by tests/bbqr/run_node.mjs.
//
// Each code is text in QR's alphanumeric mode: an 8-character header, then a
// piece of the encoded file.
//
//   B $ Z P 0 3 0 1
//   marker   encoding (H hex, 2 base32, Z deflate then base32)
//            file type (P PSBT, T transaction, J JSON, C CBOR, U UTF-8
//            text, B binary, X executable)
//            parts in all, 2 digits of base 36 (01 to ZZ = 1295)
//            this part's index, 2 digits of base 36, from 00
//
// "Z" is a raw deflate stream (no zlib header) with a 1 KiB window
// (windowBits 10), which small readers such as Coldcard rely on. This file
// has its own deflate and inflate for that: browsers' CompressionStream can't
// limit the window, and QuickJS has none.
//
// Writing:
//
//   const { version, encoding, parts } = split(bytes, "P", { maxVersion: 20 });
//   // show parts[0], parts[1], ... in turn, each as an alphanumeric QR code
//   // of that version at error correction L
//
// Reading:
//
//   const j = new Joiner();
//   onCode(text) {                       // each code the camera reads
//     if (!isBBQr(text)) return;         // something else
//     const p = j.add(text);             // throws BBQrError
//     show(`${p.have} of ${p.total}`);
//     if (p.done) use(j.result());       // { type, encoding, bytes }
//   }
//
// Untrusted input: everything read is checked (header, part lengths, base32
// and hex, the deflate stream), and decompression stops at `maxBytes`.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export class BBQrError extends Error {
  // code: "header", "series" (a code of another file), "conflict" (one part
  // read with two contents), "length", "data", "deflate", "size", "incomplete"
  constructor(code, message) {
    super(message);
    this.name = "BBQrError";
    this.code = code;
  }
}

export const HEADER_LENGTH = 8;
export const MAX_PARTS = 1295;
export const FILE_TYPES = { P: "PSBT", T: "transaction", J: "JSON", C: "CBOR", U: "text", B: "binary", X: "executable" };
const ENCODINGS = "H2Z";

// Characters a QR code of each version holds in alphanumeric mode at error
// correction L (ISO/IEC 18004, table 7); index 0 unused. Checked against
// a QR encoder by tests/bbqr/check_capacity.py.
const ALPHANUMERIC_L = [0,
  25, 47, 77, 114, 154, 195, 224, 279, 335, 395,
  468, 535, 619, 667, 758, 854, 938, 1046, 1153, 1249,
  1352, 1460, 1588, 1704, 1853, 1990, 2132, 2223, 2369, 2520,
  2677, 2840, 3009, 3183, 3351, 3537, 3729, 3927, 4087, 4296];

// Characters of encoded data one code of `version` carries, a whole number
// of bytes: even for hex, a multiple of 8 for base32.
export function partCapacity(version, encoding) {
  if (!(version >= 1 && version <= 40) || !Number.isInteger(version)) throw new RangeError("a QR version is 1 to 40");
  const chars = ALPHANUMERIC_L[version] - HEADER_LENGTH;
  return chars - (chars % (encoding === "H" ? 2 : 8));
}

// --- base 36, hex, base32 ----------------------------------------------------

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const b36 = (n) => B36[Math.floor(n / 36)] + B36[n % 36];
function fromB36(s) {
  const a = B36.indexOf(s[0]), b = B36.indexOf(s[1]);
  return a < 0 || b < 0 ? -1 : a * 36 + b;
}

const HEX = "0123456789ABCDEF";
function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}
function fromHex(s) {
  if (s.length % 2) throw new BBQrError("data", "Odd number of hex digits.");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const h = HEX.indexOf(s[2 * i].toUpperCase()), l = HEX.indexOf(s[2 * i + 1].toUpperCase());
    if (h < 0 || l < 0) throw new BBQrError("data", "Not hex.");
    out[i] = (h << 4) | l;
  }
  return out;
}

// RFC 4648 base32, without padding (BBQr never has "=").
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function toBase32(bytes) {
  let s = "", acc = 0, bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      s += B32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) s += B32[(acc << (5 - bits)) & 31];
  return s;
}
export function fromBase32(s) {
  // the lengths base32 can have without padding: 8 characters are 5 bytes
  if ([1, 3, 6].includes(s.length % 8)) throw new BBQrError("data", "Base32 of an impossible length.");
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0, bits = 0, n = 0;
  for (const c of s) {
    const v = B32.indexOf(c);
    if (v < 0) throw new BBQrError("data", "Not base32.");
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
  }
  if (acc & ((1 << bits) - 1)) throw new BBQrError("data", "Base32 with stray bits at the end.");
  return out;
}

// --- deflate (RFC 1951) with a 1 KiB window ------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

export const WINDOW = 1024;

class BitWriter {
  constructor(size) {
    this.out = new Uint8Array(Math.max(16, size));
    this.n = 0;
    this.acc = 0;
    this.bits = 0;
  }
  // `count` bits of `value`, least significant first
  put(value, count) {
    this.acc |= value << this.bits;
    this.bits += count;
    while (this.bits >= 8) {
      if (this.n === this.out.length) {
        const bigger = new Uint8Array(this.out.length * 2);
        bigger.set(this.out);
        this.out = bigger;
      }
      this.out[this.n++] = this.acc & 255;
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }
  // a Huffman code: most significant bit first
  code(value, count) {
    let r = 0;
    for (let i = 0; i < count; i++) r |= ((value >> i) & 1) << (count - 1 - i);
    this.put(r, count);
  }
  done() {
    if (this.bits > 0) this.put(0, 8 - this.bits);
    return this.out.slice(0, this.n);
  }
}

// RFC 1951's fixed Huffman codes (3.2.6)
function putLiteral(w, v) {
  if (v < 144) w.code(0x30 + v, 8);
  else if (v < 256) w.code(0x190 + v - 144, 9);
  else if (v < 280) w.code(v - 256, 7);
  else w.code(0xc0 + v - 280, 8);
}

function putMatch(w, length, distance) {
  let i = LEN_BASE.length - 1;
  while (LEN_BASE[i] > length) i--;
  putLiteral(w, 257 + i);
  if (LEN_EXTRA[i]) w.put(length - LEN_BASE[i], LEN_EXTRA[i]);
  let d = DIST_BASE.length - 1;
  while (DIST_BASE[d] > distance) d--;
  w.code(d, 5);
  if (DIST_EXTRA[d]) w.put(distance - DIST_BASE[d], DIST_EXTRA[d]);
}

// A raw deflate stream: one block of fixed Huffman codes, matches found with
// hash chains, never further back than WINDOW. Deterministic.
export function deflateRaw(data) {
  const n = data.length, w = new BitWriter(n + 16);
  w.put(1, 1); // the last block
  w.put(1, 2); // fixed Huffman codes
  const HASH = 1 << 14, head = new Int32Array(HASH).fill(-1), prev = new Int32Array(Math.max(1, n));
  const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1);
  const insert = (i) => {
    if (i + 2 < n) {
      const h = hash(i);
      prev[i] = head[h];
      head[h] = i;
    }
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      let j = head[hash(i)], chain = 128;
      const max = Math.min(258, n - i);
      while (j >= 0 && i - j <= WINDOW && chain-- > 0) {
        if (data[j + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < max && data[j + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - j;
            if (l === max) break;
          }
        }
        j = prev[j];
      }
    }
    if (bestLen >= 3) {
      putMatch(w, bestLen, bestDist);
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      putLiteral(w, data[i]);
      insert(i);
      i++;
    }
  }
  putLiteral(w, 256);
  return w.done();
}

// Canonical Huffman decoding, as zlib's puff.c does it.
function huffman(lengths) {
  const count = new Uint16Array(16), symbol = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  let left = 1;
  for (let l = 1; l < 16; l++) {
    left = (left << 1) - count[l];
    if (left < 0) throw new BBQrError("deflate", "Bad deflate data (an over-subscribed code).");
  }
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  lengths.forEach((l, s) => {
    if (l) symbol[offs[l]++] = s;
  });
  return { count, symbol };
}

let FIXED = null;
function fixedCodes() {
  if (!FIXED) {
    const l = new Array(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    FIXED = [huffman(l), huffman(new Array(30).fill(5))];
  }
  return FIXED;
}

const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// A raw deflate stream (any window up to 32 KiB, any block type) back to its
// bytes; BBQrError past `maxBytes` of output or on anything malformed.
export function inflateRaw(src, maxBytes = 1 << 22) {
  let pos = 0, acc = 0, have = 0;
  let out = new Uint8Array(Math.min(maxBytes, Math.max(64, src.length * 4))), n = 0;
  const bad = (why) => new BBQrError("deflate", `Bad deflate data (${why}).`);
  const bits = (k) => {
    while (have < k) {
      if (pos >= src.length) throw bad("it ends early");
      acc |= src[pos++] << have;
      have += 8;
    }
    const v = acc & ((1 << k) - 1);
    acc >>>= k;
    have -= k;
    return v;
  };
  const room = (k) => {
    if (n + k > maxBytes) throw new BBQrError("size", `It unpacks to more than ${maxBytes} bytes.`);
    if (n + k > out.length) {
      const bigger = new Uint8Array(Math.min(maxBytes, Math.max(out.length * 2, n + k)));
      bigger.set(out.subarray(0, n));
      out = bigger;
    }
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw bad("a code that isn't in its table");
  };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      acc = 0;
      have = 0; // the rest of this byte
      if (pos + 4 > src.length) throw bad("it ends early");
      const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
      pos += 4;
      if (len !== (~nlen & 0xffff)) throw bad("a stored block's length");
      if (pos + len > src.length) throw bad("it ends early");
      room(len);
      out.set(src.subarray(pos, pos + len), n);
      n += len;
      pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      [lit, dist] = fixedCodes();
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw bad("too many codes");
      const cl = new Array(19).fill(0);
      for (let i = 0; i < ncode; i++) cl[ORDER[i]] = bits(3);
      const lencode = huffman(cl);
      const lengths = [];
      while (lengths.length < nlen + ndist) {
        const sym = decode(lencode);
        if (sym < 16) {
          lengths.push(sym);
          continue;
        }
        let v = 0, r;
        if (sym === 16) {
          if (!lengths.length) throw bad("a repeat with nothing before it");
          v = lengths[lengths.length - 1];
          r = 3 + bits(2);
        } else if (sym === 17) {
          r = 3 + bits(3);
        } else {
          r = 11 + bits(7);
        }
        if (lengths.length + r > nlen + ndist) throw bad("too many code lengths");
        while (r--) lengths.push(v);
      }
      if (!lengths[256]) throw bad("no end-of-block code");
      lit = huffman(lengths.slice(0, nlen));
      dist = huffman(lengths.slice(nlen));
    } else {
      throw bad("block type 3");
    }
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        room(1);
        out[n++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw bad("a length code out of range");
        const length = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) throw bad("a distance code out of range");
        const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (distance > n) throw bad("a distance before the start");
        room(length);
        for (let k = 0; k < length; k++, n++) out[n] = out[n - distance];
      }
    }
  } while (!last);
  return out.slice(0, n);
}

// --- writing -------------------------------------------------------------------

// data (Uint8Array) and its file type (a key of FILE_TYPES) to the text of
// each code. Options:
//   encoding    "Z" (default: compressed, or "2" when that's no smaller),
//               "2" or "H"
//   minVersion, maxVersion   the QR versions to choose from (5 and 40)
//   maxParts    at most this many codes (1295)
// The smallest version from minVersion up that needs no more than maxParts
// codes is chosen; the parts are as even as alignment allows, so the last
// isn't a tiny one. -> { version, encoding, parts: [string] }
export function split(data, type, options = {}) {
  const { minVersion = 5, maxVersion = 40, maxParts = MAX_PARTS } = options;
  let encoding = options.encoding || "Z";
  if (!(data instanceof Uint8Array)) throw new TypeError("split() takes a Uint8Array");
  if (typeof type !== "string" || !/^[A-Z]$/.test(type)) throw new RangeError("a file type is one capital letter (P, T, J, C, U, B, X)");
  if (!ENCODINGS.includes(encoding) || encoding.length !== 1) throw new RangeError('an encoding is "H", "2" or "Z"');
  if (!(maxParts >= 1 && maxParts <= MAX_PARTS)) throw new RangeError(`maxParts is 1 to ${MAX_PARTS}`);
  let text;
  if (encoding === "Z") {
    const z = deflateRaw(data);
    if (z.length < data.length) text = toBase32(z);
    else encoding = "2";
  }
  if (encoding === "2") text = toBase32(data);
  if (encoding === "H") text = toHex(data);
  const align = encoding === "H" ? 2 : 8;
  for (let version = minVersion; version <= maxVersion; version++) {
    const cap = partCapacity(version, encoding);
    const count = Math.max(1, Math.ceil(text.length / cap));
    if (count > maxParts) continue;
    // even parts: all but the last the same length, a multiple of `align`
    const each = Math.max(align, Math.min(cap, Math.ceil(Math.ceil(text.length / count) / align) * align));
    const total = Math.max(1, Math.ceil(text.length / each));
    const parts = [];
    for (let i = 0; i < total; i++) {
      parts.push(`B$${encoding}${type}${b36(total)}${b36(i)}` + text.slice(i * each, (i + 1) * each));
    }
    return { version, encoding, parts };
  }
  throw new BBQrError("size", `Too big for ${maxParts} QR codes of version ${maxVersion}.`);
}

// --- reading -------------------------------------------------------------------

export const isBBQr = (text) => typeof text === "string" && text.startsWith("B$");

// A code's header and data, or BBQrError("header").
export function parsePart(text) {
  if (!isBBQr(text) || text.length < HEADER_LENGTH) throw new BBQrError("header", "Not a BBQr code.");
  const encoding = text[2], type = text[3];
  const total = fromB36(text.slice(4, 6)), index = fromB36(text.slice(6, 8));
  if (!ENCODINGS.includes(encoding)) throw new BBQrError("header", `A BBQr encoding this reader doesn't know ("${encoding}").`);
  if (!/^[A-Z]$/.test(type)) throw new BBQrError("header", "A BBQr code with a bad file type.");
  if (total < 1 || index < 0 || index >= total) throw new BBQrError("header", "A BBQr code with a bad part number.");
  return { encoding, type, total, index, prefix: text.slice(0, 6), data: text.slice(HEADER_LENGTH) };
}

// Collects the codes of one file, in any order, each as often as it comes.
export class Joiner {
  // maxBytes: the most a file may unpack to (4 MiB)
  constructor({ maxBytes = 1 << 22 } = {}) {
    this.maxBytes = maxBytes;
    this.reset();
  }

  reset() {
    this.prefix = null;
    this.encoding = null;
    this.type = null;
    this.total = 0;
    this.parts = [];
    this.have = 0;
  }

  // One code's text. -> { have, total, done, added, type, encoding }; added
  // is false for a code already read. BBQrError: "header"; "series" for a
  // code of another file (reset() to start over with it); "conflict";
  // "length" for parts whose lengths can't be one file's.
  add(text) {
    const p = parsePart(text);
    if (this.prefix === null) {
      this.prefix = p.prefix;
      this.encoding = p.encoding;
      this.type = p.type;
      this.total = p.total;
      this.parts = new Array(p.total).fill(null);
    } else if (p.prefix !== this.prefix) {
      throw new BBQrError("series", "That code belongs to another file than the codes before it.");
    }
    const align = p.encoding === "H" ? 2 : 8;
    if (p.index < p.total - 1 && (p.data.length === 0 || p.data.length % align)) {
      throw new BBQrError("length", "A BBQr part of the wrong length.");
    }
    const had = this.parts[p.index];
    if (had !== null) {
      if (had !== p.data) throw new BBQrError("conflict", `Part ${p.index + 1} was read twice, with different contents.`);
    } else {
      this.checkLengths(p.index, p.data);
      this.parts[p.index] = p.data;
      this.have++;
    }
    return { have: this.have, total: this.total, done: this.have === this.total, added: had === null,
      type: this.type, encoding: this.encoding };
  }

  // every part but the last the same length; the last no longer
  checkLengths(index, data) {
    const last = this.total - 1;
    for (let i = 0; i < this.total; i++) {
      const other = this.parts[i];
      if (other === null || i === index) continue;
      const ok = index === last ? data.length <= other.length
        : i === last ? other.length <= data.length
          : other.length === data.length;
      if (!ok) throw new BBQrError("length", "These BBQr parts' lengths don't fit together.");
    }
  }

  // The file, once every part is in: { type, encoding, bytes }.
  result() {
    if (this.prefix === null || this.have < this.total) {
      throw new BBQrError("incomplete", `${this.have} of ${this.total || "?"} parts read.`);
    }
    const text = this.parts.join("");
    let bytes;
    if (this.encoding === "H") bytes = fromHex(text);
    else bytes = fromBase32(text);
    if (this.encoding === "Z") bytes = inflateRaw(bytes, this.maxBytes);
    else if (bytes.length > this.maxBytes) throw new BBQrError("size", `More than ${this.maxBytes} bytes.`);
    return { type: this.type, encoding: this.encoding, bytes };
  }
}
