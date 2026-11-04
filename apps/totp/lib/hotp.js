// HOTP (RFC 4226) and TOTP (RFC 6238), on an HMAC given by the caller
// through setHmac(): zg:crypto's (native) in the app, Node's in the tests.
//
// SPDX-License-Identifier: GPL-3.0-or-later

let hmacFn = null;
// fn(hash, key, message) -> Uint8Array; hash: "SHA-1", "SHA-256", "SHA-512"
export function setHmac(fn) {
  hmacFn = fn;
}

export const ALGORITHMS = ["SHA1", "SHA256", "SHA512"];
const HASH_NAMES = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

// An HMAC with a fixed key: { mac(message) -> Uint8Array, wipe() }. Keeps
// its own copy of the key, which wipe() overwrites.
export function makeHmac(algorithm, key) {
  const hash = HASH_NAMES[algorithm];
  if (!hash) throw new Error("unknown algorithm " + algorithm);
  if (!hmacFn) throw new Error("HMAC: none given (setHmac)");
  const k = key.slice();
  return {
    mac: (message) => hmacFn(hash, k, message),
    wipe: () => k.fill(0),
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
