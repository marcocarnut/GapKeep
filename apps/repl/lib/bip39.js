// BIP-39 mnemonics (English word list) and their seeds.
//
//   mnemonicFromEntropy(entropy)          16/20/24/28/32 bytes -> "word word ..."
//   entropyFromMnemonic(mnemonic)         back, checking the checksum (Bip39Error)
//   seedFromMnemonic(mnemonic, passphrase = "")   -> Uint8Array(64)
//
// The seed is PBKDF2-HMAC-SHA512 of the mnemonic, salted with "mnemonic" and
// the passphrase, 2048 rounds, both NFKD-normalised first (BIP-39). It does
// not check the mnemonic: any text has a seed (as BIP-39 says); check it
// with entropyFromMnemonic first when it was typed.
//
// Needs setCrypto() (./crypto.js). Messages never quote the words.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { BIP39_WORDS } from "../vendor/wordlist.js";
import { cr, zero } from "./crypto.js";

export const ENTROPY_LENGTHS = [16, 20, 24, 28, 32];

// code: "count" (count: the number of words), "word" (word: its position,
// from 1), "checksum", "entropy": for an app to word it in another language.
export class Bip39Error extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
    this.name = "Bip39Error";
  }
}

let index = null;
function wordIndex() {
  if (!index) {
    if (BIP39_WORDS.length !== 2048) throw new Error("BIP-39 word list: not 2048 words");
    index = new Map(BIP39_WORDS.map((w, i) => [w, i]));
  }
  return index;
}

export function mnemonicFromEntropy(entropy) {
  if (!(entropy instanceof Uint8Array) || !ENTROPY_LENGTHS.includes(entropy.length)) {
    throw new Bip39Error("BIP-39 entropy must be 16, 20, 24, 28 or 32 bytes", { code: "entropy" });
  }
  const checksum = cr().sha256(entropy)[0];
  const bits = entropy.length * 8, total = bits + bits / 32;
  const bit = (i) => (i < bits ? (entropy[i >> 3] >> (7 - (i & 7))) & 1 : (checksum >> (7 - (i - bits))) & 1);
  const words = [];
  for (let i = 0; i < total; i += 11) {
    let v = 0;
    for (let j = 0; j < 11; j++) v = (v << 1) | bit(i + j);
    words.push(BIP39_WORDS[v]);
  }
  return words.join(" ");
}

// Words separated by any whitespace, either case. Throws Bip39Error naming
// the position (from 1) of a word not in the list, never the word.
export function entropyFromMnemonic(mnemonic) {
  const words = String(mnemonic).normalize("NFKD").trim().toLowerCase().split(/\s+/).filter((w) => w);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Bip39Error(`a BIP-39 mnemonic has 12, 15, 18, 21 or 24 words, not ${words.length}`,
      { code: "count", count: words.length });
  }
  const map = wordIndex();
  const total = words.length * 11, bits = (total * 32) / 33;
  const entropy = new Uint8Array(bits / 8);
  let checksum = 0;
  for (let w = 0; w < words.length; w++) {
    const v = map.get(words[w]);
    if (v === undefined) throw new Bip39Error(`word ${w + 1} is not in the BIP-39 word list`, { code: "word", word: w + 1 });
    for (let j = 0; j < 11; j++) {
      const i = w * 11 + j, b = (v >> (10 - j)) & 1;
      if (i < bits) entropy[i >> 3] |= b << (7 - (i & 7));
      else checksum = (checksum << 1) | b;
    }
  }
  const cs = total - bits;
  const want = cr().sha256(entropy)[0] >> (8 - cs);
  if (want !== checksum) {
    zero(entropy);
    throw new Bip39Error("the mnemonic's checksum is wrong (a word is mistyped, or the order is wrong)", { code: "checksum" });
  }
  return entropy;
}

export function seedFromMnemonic(mnemonic, passphrase = "") {
  if (typeof mnemonic !== "string" || typeof passphrase !== "string") throw new TypeError("BIP-39: strings expected");
  return cr().pbkdf2("SHA-512", mnemonic.normalize("NFKD"), "mnemonic" + passphrase.normalize("NFKD"), 2048, 64);
}
