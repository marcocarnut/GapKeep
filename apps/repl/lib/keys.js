// Private keys typed or scanned as text: WIF, and extended keys (xprv and
// its SLIP-132 cousins). Pure, as the rest of lib/: tests run it under Node.
//
//   parsePrivateKey(text) -> a key for sign.js, with what to say about it:
//     { key, kind: "wif" | "xprv", network: "mainnet" | "test", script | null,
//       compressed (WIF only) }
//
// Errors are KeyError, for people. They never quote the text.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t } from "./text.js";
import { cr, zero } from "./crypto.js";
import { decodeExtendedKey, wipe, VERSIONS, Bip32Error } from "./bip32.js";
import { DecodeError } from "./psbt/bytes.js";
import { base58CheckDecode } from "./psbt/basen.js";

export class KeyError extends Error {
  constructor(message) {
    super(String(message));
    this.text = message;   // a Message (text.js) where it is one: the app translates it
    this.name = "KeyError";
  }
}

const WIF_PREFIX = { 0x80: "mainnet", 0xef: "test" };

// A WIF: base58check of the prefix, 32 bytes, and 0x01 for a compressed key.
// An uncompressed key's addresses hash the 65-byte public key: old P2PKH
// coins. It can't spend segwit: sign.js keeps it to legacy.
export function parseWif(text) {
  let raw;
  try {
    raw = base58CheckDecode(text);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    throw new KeyError(t("That is not a WIF key: mistyped? Its checksum or its characters are wrong."));
  }
  try {
    const network = WIF_PREFIX[raw[0]];
    if (!network) throw new KeyError(t("That is not a WIF key: it doesn't start as one does."));
    const compressed = raw.length === 34 && raw[33] === 1;
    if (!compressed && raw.length !== 33) throw new KeyError(t("That is not a WIF key: wrong length."));
    const privateKey = raw.slice(1, 33);
    if (!cr().isPrivateKey(privateKey)) {
      zero(privateKey);
      throw new KeyError(t("That WIF key is outside the range of private keys."));
    }
    return { key: { single: true, privateKey, publicKey: cr().publicKey(privateKey, compressed) }, kind: "wif", network, script: null, compressed };
  } finally {
    zero(raw);
  }
}

export function parseExtendedPrivateKey(text) {
  let d;
  try {
    d = decodeExtendedKey(text);
  } catch (e) {
    if (!(e instanceof Bip32Error)) throw e;
    throw new KeyError(t("That is not an extended private key: mistyped? Its checksum or its contents are wrong."));
  }
  if (!d.private) {
    wipe(d.node);
    throw new KeyError(t("That is a public key (xpub): it can't sign. This needs the private one (xprv)."));
  }
  const v = VERSIONS[d.version];
  return { key: d.node, kind: "xprv", network: v.network === "mainnet" ? "mainnet" : "test", script: v.script };
}

// By its first letters: xprv, yprv, zprv, tprv, uprv, vprv; else a WIF.
export function parsePrivateKey(input) {
  const text = String(input).replace(/\s/g, "");
  if (!text) throw new KeyError(t("Type the key first."));
  return /^[a-z]prv/i.test(text) ? parseExtendedPrivateKey(text) : parseWif(text);
}
