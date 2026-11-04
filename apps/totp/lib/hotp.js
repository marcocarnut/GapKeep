// HMAC (RFC 2104), HOTP (RFC 4226) and TOTP (RFC 6238).
//
// HMAC-SHA1 and HMAC-SHA512 use lib/sha.js; HMAC-SHA256 uses a SHA-256
// given by the caller (zg:crypto's, native, in the app; Node's in tests),
// through setSha256().
//
// A key is prepared once (makeHmac): for SHA-1 and SHA-512 the padded key
// blocks are hashed then, and each code starts from those two states, so a
// code costs two compressions. On the Pi Zero that keeps a SHA-512 code
// cheap enough to compute on the second it is due.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { SHA1, SHA512 } from "./sha.js";

let sha256 = null;
export function setSha256(fn) {
  sha256 = fn;
}

export const ALGORITHMS = ["SHA1", "SHA256", "SHA512"];

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// The key XORed with ipad and opad (RFC 2104): keys longer than a block
// are hashed first, shorter ones padded with zeros.
function padKeys(key, blockSize, hash) {
  if (key.length > blockSize) key = hash(key);
  const ipad = new Uint8Array(blockSize).fill(0x36);
  const opad = new Uint8Array(blockSize).fill(0x5c);
  for (let i = 0; i < key.length; i++) {
    ipad[i] ^= key[i];
    opad[i] ^= key[i];
  }
  return [ipad, opad];
}

// An HMAC with a fixed key: { mac(message) -> Uint8Array, wipe() }.
export function makeHmac(algorithm, key) {
  if (algorithm === "SHA256") {
    if (!sha256) throw new Error("HMAC-SHA256: no SHA-256 (setSha256)");
    const [ipad, opad] = padKeys(key, 64, sha256);
    return {
      mac: (message) => {
        const inner = sha256(concat(ipad, message));
        const out = sha256(concat(opad, inner));
        inner.fill(0);
        return out;
      },
      wipe: () => {
        ipad.fill(0);
        opad.fill(0);
      },
    };
  }
  const alg = algorithm === "SHA1" ? SHA1 : algorithm === "SHA512" ? SHA512 : null;
  if (!alg) throw new Error("unknown algorithm " + algorithm);
  const [ipad, opad] = padKeys(key, alg.blockSize, alg.hash);
  const istate = alg.init(), ostate = alg.init();
  alg.compress(istate, ipad, 0);
  alg.compress(ostate, opad, 0);
  ipad.fill(0);
  opad.fill(0);
  return {
    mac: (message) => {
      const inner = alg.finish(istate.slice(), message, alg.blockSize);
      const out = alg.finish(ostate.slice(), inner, alg.blockSize);
      inner.fill(0);
      return out;
    },
    wipe: () => {
      istate.fill(0);
      ostate.fill(0);
    },
  };
}

// HOTP (RFC 4226, 5.3): HMAC of the 8-byte big-endian counter, dynamic
// truncation, the last `digits` decimal digits. Returns a string.
export function hotp(hmac, counter, digits) {
  const msg = new Uint8Array(8);
  const high = Math.floor(counter / 4294967296), low = counter >>> 0;
  msg[0] = high >>> 24; msg[1] = (high >>> 16) & 0xff; msg[2] = (high >>> 8) & 0xff; msg[3] = high & 0xff;
  msg[4] = low >>> 24; msg[5] = (low >>> 16) & 0xff; msg[6] = (low >>> 8) & 0xff; msg[7] = low & 0xff;
  const h = hmac.mac(msg);
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) * 16777216) + (h[o + 1] << 16) + (h[o + 2] << 8) + h[o + 3];
  h.fill(0);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

// TOTP (RFC 6238, 4.2): the counter is the number of whole periods since
// 1970-01-01 UTC (T0 = 0).
export function totpCounter(timeMs, period) {
  return Math.floor(Math.floor(timeMs / 1000) / period);
}

export function totp(hmac, timeMs, period, digits) {
  return hotp(hmac, totpCounter(timeMs, period), digits);
}

// "123456" -> "123 456", "12345678" -> "1234 5678"
export function groupCode(code) {
  const half = code.length === 8 ? 4 : 3;
  return code.length === 6 || code.length === 8 ? code.slice(0, half) + " " + code.slice(half) : code;
}
