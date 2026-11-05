// What the Signer's screens need from the signing library, in one place:
// the key from a recombined codex32 secret, the public key for Electrum,
// the plan, signing, the self-test.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as crypto from "zg:crypto";
import { setCrypto } from "./crypto.js";
import { ENTROPY_LENGTHS, mnemonicFromEntropy, seedFromMnemonic } from "./bip39.js";
import { fromSeed, derive, neuter, wipe, fingerprintHex, serializeXpub, versionFor } from "./bip32.js";
import { plan as planSigning, signPsbt, finalize } from "./sign.js";
import { serializePsbt } from "./psbt/psbt.js";
import { selfTest as libSelfTest } from "./selftest.js";

setCrypto(crypto);

// The public keys Electrum can make a watch-only wallet of (it has no
// taproot wallets; P2PKH can't be signed from its QR codes)
export const EXPORTS = [
  { id: "p2wpkh", purpose: 84, name: "Native segwit (BIP-84)" },
  { id: "p2sh-p2wpkh", purpose: 49, name: "Nested segwit (BIP-49)" },
];

const coin = (network) => (network === "mainnet" ? 0 : 1);
const accountPath = (purpose, network) => `m/${purpose}'/${coin(network)}'/0'`;

// The master key from a codex32 secret. meaning: "bip39" (dice39's shares:
// BIP-39 entropy, words, then the seed with the passphrase) or "bip32"
// (BIP-93: the secret is the master seed). The secret is the caller's to wipe.
// -> { master, fingerprint, description }
export function loadKey(secret, { meaning, passphrase = "" }) {
  let seed, description;
  if (meaning === "bip39") {
    if (!ENTROPY_LENGTHS.includes(secret.length)) {
      throw new RangeError(`The shares hold ${secret.length} bytes: not a seed phrase's entropy (16 to 32 bytes). ` +
        "Maybe they hold a master seed (the other choice).");
    }
    const words = secret.length * 3 / 4;
    let mnemonic = mnemonicFromEntropy(secret);
    seed = seedFromMnemonic(mnemonic, passphrase);
    mnemonic = null;
    description = `a ${words}-word seed phrase` + (passphrase ? " and a passphrase" : ", no passphrase");
  } else {
    seed = Uint8Array.from(secret);
    description = `a ${secret.length}-byte BIP-32 master seed`;
  }
  try {
    const master = fromSeed(seed);
    return { master, fingerprint: fingerprintHex(master), description };
  } finally {
    seed.fill(0);
  }
}

export function wipeKey(key) {
  if (key && key.master) wipe(key.master);
}

// The account's public key, as Electrum takes it ("Use a master key"):
// -> { text, path, fingerprint (the account key's: what Electrum calls the
// wallet's, as it can't know the master's) }
export function exportKey(key, id, network) {
  const x = EXPORTS.find((e) => e.id === id);
  const path = accountPath(x.purpose, network);
  const account = derive(key.master, path);
  try {
    const pub = neuter(account);
    return { text: serializeXpub(pub, versionFor(id, network)), path, fingerprint: fingerprintHex(pub) };
  } finally {
    wipe(account);
  }
}

export const plan = (psbt, key, options) => planSigning(psbt, key.master, options);

// -> { psbt (bytes), tx (bytes, when every input is signed) | null, count }
export function sign(psbt, key, options) {
  const r = signPsbt(psbt, key.master, options);
  const tx = r.plan.complete ? finalize(r.psbt).tx : null;
  return { psbt: serializePsbt(r.psbt), tx, count: r.signed.length };
}

// -> { passed, failed: [names] }
export function selfTest() {
  let r;
  try {
    r = libSelfTest(crypto);
  } catch (e) {
    return { passed: 0, failed: [`the self-test stopped: ${e && e.message}`] };
  }
  return { passed: r.checks.filter((c) => c.ok).length, failed: r.checks.filter((c) => !c.ok).map((c) => c.name) };
}
