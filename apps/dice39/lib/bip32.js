// BIP-32 hierarchical deterministic keys, and extended public keys in the
// SLIP-132 forms Electrum uses (xpub/ypub/zpub and tpub/upub/vpub).
//
//   node = { depth, parentFingerprint (Uint8Array(4)), childNumber (u32),
//            chainCode (Uint8Array(32)), privateKey (Uint8Array(32) | null),
//            publicKey (Uint8Array(33), compressed) }
//
//   fromSeed(seed)                16..64 bytes -> master node (private)
//   derive(node, path)            path: "m/84'/0'/0'" (' or h), or [u32]
//   parsePath(text)               -> [u32]; formatPath([u32]) -> "m/84'/0'/0'"
//   neuter(node)                  the public node (a copy)
//   fingerprint(node)             Uint8Array(4): HASH160(publicKey)[0..4]
//   serializeXpub(node, version)  version: "xpub", "ypub", "zpub", "tpub",
//                                 "upub", "vpub" -> Base58Check text
//   parseXpub(text)               -> { node (public), version, network, script }
//   wipe(node)                    overwrites its private key and chain code
//
// Needs setCrypto() (./crypto.js). Errors are Bip32Error; their messages
// never hold keys. Private keys are never serialized here.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { cr, hash160, zero } from "./crypto.js";
import { asciiBytes, toHex, fromHex, equal, DecodeError } from "./psbt/bytes.js";
import { base58CheckEncode, base58CheckDecode } from "./psbt/basen.js";

export const HARDENED = 0x80000000;

export class Bip32Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Bip32Error";
  }
}

// SLIP-132: the version bytes, and what Electrum makes of each (its xtype).
export const VERSIONS = {
  xpub: { pub: 0x0488b21e, prv: 0x0488ade4, network: "mainnet", script: "p2pkh" },
  ypub: { pub: 0x049d7cb2, prv: 0x049d7878, network: "mainnet", script: "p2sh-p2wpkh" },
  zpub: { pub: 0x04b24746, prv: 0x04b2430c, network: "mainnet", script: "p2wpkh" },
  tpub: { pub: 0x043587cf, prv: 0x04358394, network: "testnet", script: "p2pkh" },
  upub: { pub: 0x044a5262, prv: 0x044a4e28, network: "testnet", script: "p2sh-p2wpkh" },
  vpub: { pub: 0x045f1cf6, prv: 0x045f18bc, network: "testnet", script: "p2wpkh" },
};

// The version to export an account with, for Electrum: by its script type
// and network. (Electrum has no version for taproot: there are no taproot
// wallets in Electrum 4.8; BIP-86 accounts use xpub/tpub.)
export function versionFor(script, network) {
  const test = network !== "mainnet";
  switch (script) {
    case "p2wpkh": return test ? "vpub" : "zpub";
    case "p2sh-p2wpkh": return test ? "upub" : "ypub";
    default: return test ? "tpub" : "xpub";
  }
}

const SEED_KEY = asciiBytes("Bitcoin seed");

export function fromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length < 16 || seed.length > 64) {
    throw new Bip32Error("a BIP-32 seed is 16 to 64 bytes");
  }
  const I = cr().hmac("SHA-512", SEED_KEY, seed);
  try {
    const key = I.slice(0, 32);
    if (!cr().isPrivateKey(key)) {
      zero(key);
      throw new Bip32Error("this seed gives an invalid master key (BIP-32: use another seed)");
    }
    return { depth: 0, parentFingerprint: new Uint8Array(4), childNumber: 0, chainCode: I.slice(32),
      privateKey: key, publicKey: cr().publicKey(key, true) };
  } finally {
    zero(I);
  }
}

export function parsePath(text) {
  if (Array.isArray(text)) {
    for (const i of text) {
      if (!Number.isInteger(i) || i < 0 || i > 0xffffffff) throw new Bip32Error("a path step is a 32-bit number");
    }
    return text.slice();
  }
  const parts = String(text).trim().split("/");
  if (parts[0] !== "m" && parts[0] !== "M") throw new Bip32Error('a path starts with "m"');
  const path = [];
  for (const p of parts.slice(1)) {
    const m = /^(\d{1,10})(['hH]?)$/.exec(p);
    if (!m) throw new Bip32Error(`"${p.slice(0, 12)}" is not a path step (a number, ' or h for hardened)`);
    const n = Number(m[1]);
    if (n >= HARDENED) throw new Bip32Error("a path step is below 2^31 (then ' for hardened)");
    path.push(m[2] ? n + HARDENED : n);
  }
  return path;
}

export function formatPath(path) {
  return "m" + path.map((p) => "/" + (p >= HARDENED ? (p - HARDENED) + "'" : p)).join("");
}

export const fingerprint = (node) => hash160(node.publicKey).subarray(0, 4);

const ser32 = (out, at, i) => {
  out[at] = i >>> 24;
  out[at + 1] = (i >>> 16) & 255;
  out[at + 2] = (i >>> 8) & 255;
  out[at + 3] = i & 255;
};

// One step (CKDpriv or CKDpub).
export function deriveChild(node, index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Bip32Error("a path step is a 32-bit number");
  if (node.depth >= 255) throw new Bip32Error("too deep (255 levels at most)");
  const hardened = index >= HARDENED;
  if (hardened && !node.privateKey) throw new Bip32Error("a hardened step needs the private key");
  const data = new Uint8Array(37);
  if (hardened) data.set(node.privateKey, 1);
  else data.set(node.publicKey, 0);
  ser32(data, 33, index);
  const I = cr().hmac("SHA-512", node.chainCode, data);
  zero(data);
  const IL = I.subarray(0, 32);
  try {
    let privateKey = null, publicKey;
    try {
      if (node.privateKey) {
        privateKey = cr().privateKeyTweakAdd(node.privateKey, IL);
        publicKey = cr().publicKey(privateKey, true);
      } else {
        publicKey = cr().publicKeyTweakAdd(node.publicKey, IL, true);
      }
    } catch (e) {
      if (e instanceof RangeError) throw new Bip32Error(`child ${index} is invalid (BIP-32: use the next one)`);
      throw e;
    }
    return { depth: node.depth + 1, parentFingerprint: fingerprint(node).slice(), childNumber: index,
      chainCode: I.slice(32), privateKey, publicKey };
  } finally {
    zero(I);
  }
}

// The node at `path` below `node` (a new node; `node` is unchanged). The
// intermediate private keys are wiped.
export function derive(node, path) {
  const steps = parsePath(path);
  let cur = node;
  for (const i of steps) {
    const next = deriveChild(cur, i);
    if (cur !== node) wipe(cur);
    cur = next;
  }
  return cur === node ? copy(node) : cur;
}

function copy(node) {
  return { ...node, parentFingerprint: node.parentFingerprint.slice(), chainCode: node.chainCode.slice(),
    privateKey: node.privateKey ? node.privateKey.slice() : null, publicKey: node.publicKey.slice() };
}

export function neuter(node) {
  return { ...copy(node), privateKey: null };
}

export function wipe(node) {
  if (!node || !node.privateKey) return;
  zero(node.privateKey);
  // a private node's chain code, with its xpub, gives every non-hardened
  // child's private key: wiped too
  zero(node.chainCode);
  node.privateKey = null;
}

function serialize(node, versionBytes, keyData) {
  const out = new Uint8Array(78);
  ser32(out, 0, versionBytes);
  out[4] = node.depth;
  out.set(node.parentFingerprint, 5);
  ser32(out, 9, node.childNumber);
  out.set(node.chainCode, 13);
  out.set(keyData, 45);
  return out;
}

export function serializeXpub(node, version = "xpub") {
  const v = VERSIONS[version];
  if (!v) throw new Bip32Error(`unknown xpub version "${String(version).slice(0, 8)}"`);
  return base58CheckEncode(serialize(node, v.pub, node.publicKey));
}

// An extended key's 78 bytes, as BIP-32 says (used by parseXpub, and by the
// tests on private keys). { node, version, private }
export function decodeExtendedKey(text) {
  let raw;
  try {
    raw = base58CheckDecode(String(text).trim());
  } catch (e) {
    if (e instanceof DecodeError) throw new Bip32Error("not an extended key (" + e.message + ")");
    throw e;
  }
  if (raw.length !== 78) throw new Bip32Error(`not an extended key (${raw.length} bytes, not 78)`);
  const vb = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  let version = null, isPrivate = false;
  for (const [name, v] of Object.entries(VERSIONS)) {
    if (v.pub === vb) version = name;
    else if (v.prv === vb) {
      version = name;
      isPrivate = true;
    }
  }
  if (!version) throw new Bip32Error("unknown extended key version " + toHex(raw.subarray(0, 4)));
  const depth = raw[4], parentFingerprint = raw.slice(5, 9);
  const childNumber = ((raw[9] << 24) | (raw[10] << 16) | (raw[11] << 8) | raw[12]) >>> 0;
  if (depth === 0 && !equal(parentFingerprint, new Uint8Array(4))) throw new Bip32Error("depth 0 with a parent fingerprint");
  if (depth === 0 && childNumber !== 0) throw new Bip32Error("depth 0 with a child number");
  const node = { depth, parentFingerprint, childNumber, chainCode: raw.slice(13, 45), privateKey: null, publicKey: null };
  const key = raw.subarray(45);
  if (isPrivate) {
    if (key[0] !== 0) throw new Bip32Error("a private extended key with a public key in it");
    const k = key.slice(1);
    if (!cr().isPrivateKey(k)) {
      zero(raw);
      throw new Bip32Error("the private key is not in 1..n-1");
    }
    node.privateKey = k;
    node.publicKey = cr().publicKey(k, true);
  } else {
    if (key[0] !== 2 && key[0] !== 3) throw new Bip32Error("a public extended key with no compressed public key in it");
    if (!cr().isPublicKey(key)) throw new Bip32Error("the public key is not on the curve");
    node.publicKey = key.slice();
  }
  zero(raw);
  return { node, version, private: isPrivate };
}

// An xpub (any SLIP-132 version above); private keys are refused.
export function parseXpub(text) {
  const { node, version, private: isPrivate } = decodeExtendedKey(text);
  if (isPrivate) {
    wipe(node);
    throw new Bip32Error("this is a private key (xprv), not an xpub");
  }
  return { node, version, network: VERSIONS[version].network, script: VERSIONS[version].script };
}

// Hex of a fingerprint, as PSBTs and Electrum show them ("73c5da0a").
export const fingerprintHex = (node) => toHex(fingerprint(node));
export const fingerprintFromHex = (hex) => fromHex(hex);
