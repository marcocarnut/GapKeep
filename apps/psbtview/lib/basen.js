// Base43 and Base58, as Electrum's base_encode() and base_decode()
// (electrum/bitcoin.py), and Base58Check.
//
// Electrum puts transactions in QR codes as Base43: its alphabet is all in
// the QR code's alphanumeric mode (5.5 bits a character), so a code holds
// more than with Base64 in byte mode. Like Base58, a leading zero byte is
// the alphabet's first character, and the rest is one big number.
//
// Electrum's conversion is quadratic in the length; this one splits the
// number in halves (below), so it costs what BigInt multiplication does.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { DecodeError, equal, concat, toHex, fromHex } from "./bytes.js";
import { sha256d } from "./hashes.js";

export const BASE43_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:";
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const LEAF = 8; // digits handled with Numbers: 58^8 < 2^53

// Divide and conquer on BigInt: QuickJS multiplies and divides big numbers
// in C, some 20 times faster than digit loops in JavaScript (3800 Base43
// characters: about 1 ms against 24 in the simulator, so some 0.1 s
// against 2.5 s on a Pi Zero).
function makeCodec(alphabet) {
  const base = alphabet.length;
  const bigBase = BigInt(base);
  const inv = new Int16Array(128).fill(-1);
  for (let i = 0; i < base; i++) inv[alphabet.charCodeAt(i)] = i;
  const zero = alphabet[0];
  const powers = new Map();
  const power = (k) => {
    let p = powers.get(k);
    if (p === undefined) powers.set(k, (p = bigBase ** BigInt(k)));
    return p;
  };

  // exactly k digits of n (< base^k), least significant first, into out
  function digits(n, k, out) {
    if (k <= LEAF) {
      let v = Number(n);
      for (let i = 0; i < k; i++) {
        out.push(v % base);
        v = Math.floor(v / base);
      }
      return;
    }
    const low = k >> 1;
    const p = power(low);
    const q = n / p;
    digits(n - q * p, low, out);
    digits(q, k - low, out);
  }

  function encode(bytes) {
    let z = 0;
    while (z < bytes.length && bytes[z] === 0) z++;
    let s = zero.repeat(z);
    if (z === bytes.length) return s;
    const n = BigInt("0x" + toHex(bytes.subarray(z)));
    // enough digits: 8 bits a byte, log2(base) bits a digit
    const k = Math.ceil(((bytes.length - z) * 8) / Math.log2(base)) + 1;
    const out = [];
    digits(n, k, out);
    let top = out.length - 1;
    while (top > 0 && out[top] === 0) top--;
    for (let i = top; i >= 0; i--) s += alphabet[out[i]];
    return s;
  }

  // the value of text[a, b)
  function value(text, a, b) {
    if (b - a <= LEAF) {
      let v = 0;
      for (let j = a; j < b; j++) {
        const c = text.charCodeAt(j);
        const d = c < 128 ? inv[c] : -1;
        if (d < 0) throw new DecodeError(`Base${base}: "${text[j]}" (at ${j}) is not in the alphabet`);
        v = v * base + d;
      }
      return BigInt(v);
    }
    const m = (a + b) >> 1;
    return value(text, a, m) * power(b - m) + value(text, m, b);
  }

  function decode(text) {
    let z = 0;
    while (z < text.length && text[z] === zero) z++;
    const n = z < text.length ? value(text, z, text.length) : 0n;
    let hex = n === 0n ? "" : n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const body = fromHex(hex);
    const out = new Uint8Array(z + body.length);
    out.set(body, z);
    return out;
  }

  return { encode, decode };
}

const b43 = makeCodec(BASE43_ALPHABET);
const b58 = makeCodec(BASE58_ALPHABET);

export const base43Encode = b43.encode;
export const base43Decode = b43.decode;
export const base58Encode = b58.encode;
export const base58Decode = b58.decode;

export const isBase43 = (text) => /^[0-9A-Z$*+\-./:]*$/.test(text);

export function base58CheckEncode(payload) {
  return base58Encode(concat([payload, sha256d(payload).subarray(0, 4)]));
}

export function base58CheckDecode(text) {
  const raw = base58Decode(text);
  if (raw.length < 4) throw new DecodeError("Base58Check: too short");
  const payload = raw.subarray(0, raw.length - 4);
  if (!equal(sha256d(payload).subarray(0, 4), raw.subarray(raw.length - 4))) {
    throw new DecodeError("Base58Check: wrong checksum");
  }
  return payload;
}
