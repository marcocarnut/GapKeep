// What the Signer's screens need from the signing library, in one place:
// keys (from codex32 shares, seed words, an xprv, a WIF), the public key for
// Electrum, the plan, signing, the self-test.
//
// A loaded key is { node (for sign.js), kind: "seed" | "xprv" | "wif",
// fingerprint, description, master: can it export an account, network }.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as crypto from "zg:crypto";
import { setCrypto } from "./crypto.js";
import { ENTROPY_LENGTHS, mnemonicFromEntropy, entropyFromMnemonic, seedFromMnemonic } from "./bip39.js";
import { fromSeed, derive, neuter, wipe, fingerprintHex, serializeXpub, versionFor } from "./bip32.js";
import { parsePrivateKey } from "./keys.js";
import { accountDescriptor } from "./descriptor.js";
import { planKeys, signKeys, finalize } from "./sign.js";
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

const fromSeedBytes = (seed, description) => {
  try {
    const node = fromSeed(seed);
    return { node, kind: "seed", fingerprint: fingerprintHex(node), description, master: true, network: null };
  } finally {
    seed.fill(0);
  }
};

const words = (n) => `a ${n}-word seed phrase`;
const withPassphrase = (passphrase) => (passphrase ? " and a passphrase" : ", no passphrase");

// A key from a codex32 secret. meaning: "bip39" (dice39's shares: BIP-39
// entropy, words, then the seed with the passphrase) or "bip32" (BIP-93: the
// secret is the master seed). The secret is the caller's to wipe.
export function loadKey(secret, { meaning, passphrase = "" }) {
  if (meaning !== "bip39") return fromSeedBytes(Uint8Array.from(secret), `a ${secret.length}-byte BIP-32 master seed`);
  if (!ENTROPY_LENGTHS.includes(secret.length)) {
    throw new RangeError(`The shares hold ${secret.length} bytes: not a seed phrase's entropy (16 to 32 bytes). ` +
      "Maybe they hold a master seed (the other choice).");
  }
  let mnemonic = mnemonicFromEntropy(secret);
  const seed = seedFromMnemonic(mnemonic, passphrase);
  mnemonic = null;
  return fromSeedBytes(seed, words(secret.length * 3 / 4) + withPassphrase(passphrase));
}

// A key from BIP-39 words. Throws Bip39Error (bad word, bad checksum).
export function loadWords(text, passphrase = "") {
  const entropy = entropyFromMnemonic(text);
  const n = entropy.length * 3 / 4;
  entropy.fill(0);
  return fromSeedBytes(seedFromMnemonic(text, passphrase), words(n) + withPassphrase(passphrase));
}

// A key from an xprv (and SLIP-132's yprv, zprv...) or a WIF. Throws KeyError.
export function loadPrivate(text) {
  const { key, kind, network } = parsePrivateKey(text);
  if (kind === "wif") {
    return { node: key, kind, fingerprint: fingerprintHex(key), description: "a single private key (WIF)", master: false, network };
  }
  const master = key.depth === 0;
  return { node: key, kind, fingerprint: fingerprintHex(key), master, network,
    description: master ? "a master private key (xprv)" : `an extended private key at depth ${key.depth}` };
}

export function wipeKey(key) {
  if (!key || !key.node) return;
  wipe(key.node);
  key.node = null;
}

// The account's public key: as Electrum takes it ("Use a master key"), and as
// a descriptor, for wallets that want the key's origin.
// -> { text, descriptor, path, fingerprint (the account key's: what Electrum
// calls the wallet's, as it can't know the master's), master (fingerprint) }
export function exportKey(key, id, network) {
  const x = EXPORTS.find((e) => e.id === id);
  const path = accountPath(x.purpose, network);
  const account = derive(key.node, path);
  try {
    const pub = neuter(account);
    const xpub = serializeXpub(pub, network === "mainnet" ? "xpub" : "tpub");
    return { text: serializeXpub(pub, versionFor(id, network)), path, fingerprint: fingerprintHex(pub), master: key.fingerprint,
      descriptor: accountDescriptor({ script: id, fingerprint: key.fingerprint, network, account: 0, xpub }) };
  } finally {
    wipe(account);
  }
}

const nodes = (keys) => keys.map((k) => k.node);

export const plan = (psbt, keys, options) => planKeys(psbt, nodes(keys), options);

// -> { psbt (bytes), tx (bytes, when every input is signed) | null, count }
export function sign(psbt, keys, options) {
  const r = signKeys(psbt, nodes(keys), options);
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
