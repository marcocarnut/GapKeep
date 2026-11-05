// The hashes the other modules need, given by the caller (zg:crypto's
// native ones in the app, node:crypto's in the tests), as apps/totp's
// setHmac does:
//
//   setHashes({ sha256, ripemd160 })   // each (Uint8Array) -> Uint8Array
//
// RIPEMD-160 is optional: without it, hash160() returns null and the checks
// that need it (a redeemScript against its P2SH output, a public key
// against its P2WPKH output, Base58Check of ... nothing) are reported as
// not done. Addresses never need it: they come from output scripts.
//
// SPDX-License-Identifier: GPL-3.0-or-later

let sha256Fn = null, ripemd160Fn = null;

export function setHashes({ sha256, ripemd160 }) {
  sha256Fn = sha256 || null;
  ripemd160Fn = ripemd160 || null;
}

export function sha256(data) {
  if (!sha256Fn) throw new Error("SHA-256: none given (setHashes)");
  return sha256Fn(data);
}

export const sha256d = (data) => sha256(sha256(data));

export const haveRipemd160 = () => ripemd160Fn !== null;

// RIPEMD-160(SHA-256(data)), or null without RIPEMD-160.
export const hash160 = (data) => (ripemd160Fn ? ripemd160Fn(sha256(data)) : null);
