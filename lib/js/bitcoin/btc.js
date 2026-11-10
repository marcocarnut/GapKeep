// Bitcoin for everyday calculations: a short, chainable layer over the
// libraries here, for a REPL or a quick script.
//
//   import { btc, setCrypto } from "./btc.js";
//   setCrypto(crypto);                       // gk:crypto, or a stand-in under Node
//   btc.words("abandon ... about").derive("m/84'/0'/0'/0/0").address()
//     -> "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
//
// btc.help() lists it all. Keys say what they are when printed, never their
// secrets: those come out only when asked for (.xprv(), .wif()). Errors are
// BtcError, and say what is wrong without quoting what was typed.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { cr, hash160, taggedHash, zero } from "./crypto.js";
import { entropyFromMnemonic, mnemonicFromEntropy, seedFromMnemonic, Bip39Error } from "./bip39.js";
import { fromSeed, derive as deriveNode, parsePath, formatPath, fingerprint, neuter, decodeExtendedKey,
  serializeXpub, VERSIONS, HARDENED, Bip32Error } from "./bip32.js";
import { parseWif, KeyError } from "./keys.js";
import { accountDescriptor } from "./descriptor.js";
import { toHex, fromHex, concat, DecodeError } from "./psbt/bytes.js";
import { base58CheckEncode } from "./psbt/basen.js";
import { segwitEncode } from "./psbt/bech32.js";
import { NETWORKS, addressToScript, classify, p2wpkhScript } from "./psbt/script.js";

export { setCrypto } from "./crypto.js";

export class BtcError extends Error {
  constructor(message) {
    super(String(message));
    this.name = "BtcError";
  }
}

// The libraries' errors, as BtcError: their messages never quote keys or words
function guard(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Bip39Error || e instanceof Bip32Error || e instanceof KeyError || e instanceof DecodeError
        || e instanceof RangeError) throw new BtcError(e.message);
    throw e;
  }
}

// Address types, by any of their names
const TYPES = {
  p2pkh: "p2pkh", legacy: "p2pkh",
  "p2sh-p2wpkh": "p2sh-p2wpkh", nested: "p2sh-p2wpkh", wrapped: "p2sh-p2wpkh",
  p2wpkh: "p2wpkh", segwit: "p2wpkh", native: "p2wpkh",
  p2tr: "p2tr", taproot: "p2tr",
};
const PURPOSES = { 44: "p2pkh", 49: "p2sh-p2wpkh", 84: "p2wpkh", 86: "p2tr" };
const TYPE_LIST = "p2pkh (legacy), p2sh-p2wpkh (nested), p2wpkh (segwit), p2tr (taproot)";

let network = "mainnet";

function checkNetwork(name) {
  if (!NETWORKS[name]) throw new BtcError(`no network "${String(name).slice(0, 12)}": mainnet, testnet or regtest`);
  return name;
}

const isMain = (net) => net === "mainnet";
const WIF_PREFIX = (net) => (isMain(net) ? 0x80 : 0xef);

function typeOf(name) {
  const t = TYPES[String(name).toLowerCase()];
  if (!t) throw new BtcError(`no address type "${String(name).slice(0, 16)}": ${TYPE_LIST}`);
  return t;
}

// An address of a compressed (33) or uncompressed (65 bytes) public key
function addressOf(pub, type, net) {
  const n = NETWORKS[net];
  if (pub.length !== 33 && type !== "p2pkh") throw new BtcError("an uncompressed key has only a legacy (p2pkh) address");
  switch (type) {
    case "p2pkh": return base58CheckEncode(concat([Uint8Array.of(n.p2pkh), hash160(pub)]));
    case "p2sh-p2wpkh": return base58CheckEncode(concat([Uint8Array.of(n.p2sh), hash160(p2wpkhScript(hash160(pub)))]));
    case "p2wpkh": return segwitEncode(n.hrp, 0, hash160(pub));
    case "p2tr": {
      // BIP-86: the key alone, no scripts
      const xonly = pub.subarray(1);
      return segwitEncode(n.hrp, 1, cr().taprootTweakPublicKey(xonly, taggedHash("TapTweak", xonly)).key);
    }
  }
  throw new BtcError(`no address type "${type}"`);
}

// SLIP-132 versions by network: xpub's family for mainnet, tpub's for the rest
function versionName(name, net) {
  const v = name === undefined ? (isMain(net) ? "xpub" : "tpub") : String(name).replace(/prv$/, "pub");
  const info = VERSIONS[v];
  if (!info) throw new BtcError(`no version "${String(name).slice(0, 8)}": xpub, ypub, zpub, Zpub (tpub, upub, vpub, Vpub on test networks)`);
  if (isMain(info.network) !== isMain(net)) throw new BtcError(`a ${net} key is not shown as ${v}`);
  return v;
}

function serializeXprv(node, version) {
  const out = new Uint8Array(78);
  const put32 = (at, x) => { out[at] = x >>> 24; out[at + 1] = (x >>> 16) & 255; out[at + 2] = (x >>> 8) & 255; out[at + 3] = x & 255; };
  put32(0, VERSIONS[version].prv);
  out[4] = node.depth;
  out.set(node.parentFingerprint, 5);
  put32(9, node.childNumber);
  out.set(node.chainCode, 13);
  out.set(node.privateKey, 46);
  try {
    return base58CheckEncode(out);
  } finally {
    zero(out);
  }
}

// A key: an HD node (BIP-32), or a single key (a WIF, a public key)
export class Key {
  #node;      // { depth, parentFingerprint, childNumber, chainCode | null, privateKey | null, publicKey }
  #path;      // [u32] from the master, or null if not known
  #type;      // the address type its version says (zpub: p2wpkh), or null
  #master;    // the master fingerprint (Uint8Array(4)), if known

  constructor(node, { path = null, type = null, master = null, net = network } = {}) {
    this.#node = node;
    this.#path = path;
    this.#type = type;
    this.#master = master;
    this.network = net;
    Object.freeze(this);
  }

  get isPrivate() { return this.#node.privateKey !== null; }
  get isHD() { return this.#node.chainCode !== null; }
  get depth() { return this.#node.depth; }
  get path() { return this.#path ? formatPath(this.#path) : null; }
  get publicKey() { return toHex(this.#node.publicKey); }

  // A child, or a descendant: "0/5", "0'/1" from this key; "m/84'/0'/0'/0/0"
  // from the master (this key, if it is one, or an ancestor on its path)
  derive(path) {
    if (!this.isHD) throw new BtcError("a single key (WIF or public key) has no children");
    let steps;
    const text = String(path).trim();
    if (/^[mM](\/|$)/.test(text)) {
      const full = guard(() => parsePath(text));
      const mine = this.#path;
      if (!mine) throw new BtcError(`this key's path is not known (depth ${this.depth}): give a path relative to it, as "0/5"`);
      if (full.length < mine.length || mine.some((s, i) => full[i] !== s)) {
        throw new BtcError(`that path is not below this key (${formatPath(mine)}): give one that is, or a relative one`);
      }
      steps = full.slice(mine.length);
    } else {
      steps = guard(() => parsePath("m/" + text.replace(/^\//, "")));
    }
    if (!this.isPrivate && steps.some((s) => s >= HARDENED)) {
      throw new BtcError("a public key can't derive a hardened child (' or h): that needs the private key");
    }
    const node = guard(() => deriveNode(this.#node, steps));
    return new Key(node, { path: this.#path ? this.#path.concat(steps) : null, type: this.#type,
      master: this.#master, net: this.network });
  }

  // The address: of the type given, else the path's purpose's (44, 49, 84,
  // 86), else what the xpub's version says (ypub, zpub)
  address(type) {
    return addressOf(this.#node.publicKey, this.addressType(type), this.network);
  }

  addressType(type) {
    if (type !== undefined) return typeOf(type);
    const purpose = this.#path && this.#path.length ? this.#path[0] - HARDENED : -1;
    if (PURPOSES[purpose]) return PURPOSES[purpose];
    if (this.#type) return this.#type;
    if (this.#node.publicKey.length === 65) return "p2pkh";
    throw new BtcError(`this key doesn't say its address type: give one, .address("p2wpkh"); types: ${TYPE_LIST}`);
  }

  // Its fingerprint (HASH160 of the public key, 4 bytes), and the master's
  fingerprint() { return toHex(fingerprint(this.#node)); }
  masterFingerprint() { return this.#master ? toHex(this.#master) : null; }

  xpub(version) {
    if (!this.isHD) throw new BtcError("a single key has no xpub");
    return serializeXpub(this.#node, versionName(version, this.network));
  }

  xprv(version) {
    if (!this.isHD) throw new BtcError("a single key has no xprv: .wif() is its private key");
    if (!this.isPrivate) throw new BtcError("this is a public key: it has no xprv");
    return serializeXprv(this.#node, versionName(version, this.network));
  }

  wif() {
    if (!this.isPrivate) throw new BtcError("this is a public key: it has no WIF");
    const compressed = this.#node.publicKey.length === 33;
    const raw = concat([Uint8Array.of(WIF_PREFIX(this.network)), this.#node.privateKey, compressed ? Uint8Array.of(1) : new Uint8Array(0)]);
    try {
      return base58CheckEncode(raw);
    } finally {
      zero(raw);
    }
  }

  // The same key without its private part
  neuter() {
    const node = this.isHD ? neuter(this.#node) : { ...this.#node, privateKey: null, publicKey: this.#node.publicKey.slice() };
    return new Key(node, { path: this.#path, type: this.#type, master: this.#master, net: this.network });
  }

  // An account's output descriptor, as wallets import it: for a key at
  // m/44'|49'|84'|86'/coin'/account' of a known master
  descriptor() {
    const p = this.#path;
    const purpose = p && p.length === 3 ? p[0] - HARDENED : -1;
    if (!PURPOSES[purpose] || !this.#master || p.some((s) => s < HARDENED)) {
      throw new BtcError("a descriptor is of an account: derive one from the master first, as \"m/84'/0'/0'\"");
    }
    return guard(() => accountDescriptor({ script: PURPOSES[purpose], fingerprint: toHex(this.#master),
      network: isMain(this.network) ? "mainnet" : "testnet", account: p[2] - HARDENED,
      xpub: serializeXpub(neuter(this.#node), isMain(this.network) ? "xpub" : "tpub") }));
  }

  // Overwrites the private key in memory; the key is public from then on
  wipe() {
    if (this.#node.privateKey) zero(this.#node.privateKey);
    if (this.#node.chainCode && this.#node.privateKey) zero(this.#node.chainCode);
    this.#node.privateKey = null;
  }

  // What it is, for printing: no secret in it
  toString() {
    const what = [this.isPrivate ? "private" : "public", this.network];
    if (this.isHD) what.push(this.path ? this.path : `depth ${this.depth}`);
    what.push("fingerprint " + this.fingerprint());
    return `Key (${what.join(", ")})`;
  }

  toJSON() { return this.toString(); }
}

// Amounts: BTC (a number or a text, up to 8 decimals) to satoshis, and back
function sats(amount) {
  const text = typeof amount === "number" ? amount.toFixed(8) : String(amount).trim();
  const m = /^(-?)(\d{0,8})(?:\.(\d{0,8}))?$/.exec(text);
  if (!m || (m[2] === "" && !m[3])) throw new BtcError("an amount in BTC is a number with up to 8 decimals");
  const v = Number(m[2] || "0") * 1e8 + Number((m[3] || "").padEnd(8, "0"));
  if (v > 21e14) throw new BtcError("more than 21 million BTC");
  return m[1] ? -v : v;
}

function toBtc(amount) {
  const v = typeof amount === "bigint" ? Number(amount) : amount;
  if (!Number.isSafeInteger(v)) throw new BtcError("an amount in satoshis is a whole number");
  const a = Math.abs(v);
  return (v < 0 ? "-" : "") + Math.floor(a / 1e8) + "." + String(a % 1e8).padStart(8, "0");
}

function master(seed, net) {
  const node = guard(() => fromSeed(seed));
  return new Key(node, { path: [], master: fingerprint(node).slice(), net });
}

function bytesOf(hex, what) {
  if (hex instanceof Uint8Array) return hex;
  try {
    return fromHex(String(hex).trim());
  } catch {
    throw new BtcError(`${what} is hex: two digits a byte`);
  }
}

// at most 56 columns: a small screen's width in mono
const HELP = `btc: Bitcoin for calculations. A key prints what it
is, never its secrets.

Keys
  btc.words(words, passphrase?)   of a BIP-39 phrase
  btc.seed(hex)                   of a BIP-32 seed
  btc.xpub(text), btc.xprv(text)  zpub, tpub... too
  btc.wif(text)                   a private key in WIF
  btc.pubkey(hex)                 a public key
A key
  .derive("m/84'/0'/0'/0/0")  from the master; or "0/5",
                              from this key
  .address(type?)  p2pkh, p2sh-p2wpkh, p2wpkh or p2tr;
                   by default the path's (44', 49', 84',
                   86')
  .xpub(version?), .xprv(version?)  xpub, zpub...
  .wif(), .publicKey, .fingerprint()
  .masterFingerprint(), .path, .network, .isPrivate
  .descriptor()   of an account, as m/84'/0'/0'
  .neuter(): its public key; .wipe(): forget the private
Other
  btc.entropy(words), btc.mnemonic(hex)
  btc.address(text)   its type and script
  btc.sats(0.001), btc.btc(100000)  BTC <-> sats
  btc.network = "testnet"   or mainnet, regtest`;

export const btc = Object.freeze({
  get network() { return network; },
  set network(name) { network = checkNetwork(name); },

  words(words, passphrase = "") {
    if (typeof words !== "string" || typeof passphrase !== "string") throw new BtcError("btc.words(words, passphrase?): texts");
    guard(() => zero(entropyFromMnemonic(words)));   // the checksum, the words
    const seed = seedFromMnemonic(words, passphrase);
    try {
      return master(seed, network);
    } finally {
      zero(seed);
    }
  },

  seed(hex) {
    return master(bytesOf(hex, "a seed"), network);
  },

  xpub(text) {
    const d = guard(() => decodeExtendedKey(text));
    if (d.private) throw new BtcError("this is a private key (xprv): use btc.xprv()");
    return extended(d);
  },

  xprv(text) {
    const d = guard(() => decodeExtendedKey(text));
    if (!d.private) throw new BtcError("this is a public key (xpub): use btc.xpub()");
    return extended(d);
  },

  wif(text) {
    const { key, network: net, compressed } = guard(() => parseWif(String(text).trim()));
    const node = { depth: 0, parentFingerprint: null, childNumber: 0, chainCode: null, privateKey: key.privateKey,
      publicKey: key.publicKey };
    return new Key(node, { type: compressed ? null : "p2pkh", net: net === "mainnet" ? "mainnet" : (isMain(network) ? "testnet" : network) });
  },

  pubkey(hex) {
    const pub = bytesOf(hex, "a public key");
    if (!cr().isPublicKey(pub)) throw new BtcError("not a public key (33 or 65 bytes, on the curve)");
    return new Key({ depth: 0, parentFingerprint: null, childNumber: 0, chainCode: null, privateKey: null,
      publicKey: pub.slice() }, { net: network });
  },

  entropy(words) {
    const e = guard(() => entropyFromMnemonic(words));
    try {
      return toHex(e);
    } finally {
      zero(e);
    }
  },

  mnemonic(hex) {
    return guard(() => mnemonicFromEntropy(bytesOf(hex, "entropy")));
  },

  address(text) {
    const a = String(text).trim();
    for (const net of Object.keys(NETWORKS)) {
      let script;
      try {
        script = addressToScript(a, net);
      } catch (e) {
        if (e instanceof DecodeError) continue;
        throw e;
      }
      return { type: classify(script).type, network: net, script: toHex(script) };
    }
    throw new BtcError("not an address of mainnet, testnet or regtest (mistyped?)");
  },

  sats,
  btc: toBtc,
  // the list, as a value that prints as itself (a REPL shows it as text)
  help: () => Object.freeze({ toString: () => HELP, toJSON: () => HELP }),
  Key,
  BtcError,
});

// An extended key's network and type, from its version
function extended(d) {
  const v = VERSIONS[d.version];
  const net = isMain(v.network) ? "mainnet" : (isMain(network) ? "testnet" : network);
  const type = v.script === "p2pkh" || v.script === "p2wsh" ? null : v.script;
  return new Key(d.node, { path: d.node.depth === 0 ? [] : null, type,
    master: d.node.depth === 0 ? fingerprint(d.node).slice() : null, net });
}
