// The cryptography the signing modules use, given by the caller: in the app
// gk:crypto itself, under Node a stand-in with the same functions
// (tests/signer/), as the PSBT library's setHashes:
//
//   import * as crypto from "gk:crypto";
//   setCrypto(crypto);
//
// What is used, with gk:crypto's signatures (docs/API.md, "gk:crypto"):
// sha256, sha512, ripemd160, hmac, pbkdf2, isPrivateKey, isPublicKey,
// publicKey, privateKeyTweakAdd, publicKeyTweakAdd, ecdsaSign, ecdsaVerify,
// xOnlyPublicKey, schnorrSign, schnorrVerify, taprootTweakPublicKey,
// taprootTweakPrivateKey. setCrypto() also gives SHA-256 and RIPEMD-160 to
// the PSBT library (./psbt/hashes.js).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { setHashes } from "./psbt/hashes.js";
import { asciiBytes } from "./psbt/bytes.js";

export const NEEDED = ["sha256", "sha512", "ripemd160", "hmac", "pbkdf2", "isPrivateKey", "isPublicKey", "publicKey",
  "privateKeyTweakAdd", "publicKeyTweakAdd", "ecdsaSign", "ecdsaVerify", "xOnlyPublicKey", "schnorrSign",
  "schnorrVerify", "taprootTweakPublicKey", "taprootTweakPrivateKey"];

let C = null;

export function setCrypto(c) {
  const missing = NEEDED.filter((name) => typeof c?.[name] !== "function");
  if (missing.length) throw new TypeError("setCrypto: missing " + missing.join(", "));
  C = c;
  setHashes({ sha256: c.sha256, ripemd160: c.ripemd160 });
}

// The functions given to setCrypto(); throws if none were.
export function cr() {
  if (!C) throw new Error("bitcoin: no cryptography given (setCrypto)");
  return C;
}

export const hash160 = (data) => cr().ripemd160(cr().sha256(data));

// BIP-340's tagged hash: SHA-256(SHA-256(tag) || SHA-256(tag) || data).
const tagHashes = new Map();
export function taggedHash(tag, data) {
  let t = tagHashes.get(tag);
  if (!t) {
    const h = cr().sha256(asciiBytes(tag));
    t = new Uint8Array(64);
    t.set(h, 0);
    t.set(h, 32);
    tagHashes.set(tag, t);
  }
  const buf = new Uint8Array(64 + data.length);
  buf.set(t, 0);
  buf.set(data, 64);
  return cr().sha256(buf);
}

// Overwrites secret bytes (keys, chain codes, seeds) once done with them.
export function zero(bytes) {
  if (bytes && typeof bytes.fill === "function") bytes.fill(0);
}
