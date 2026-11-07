// Multisig coins, and proving that change goes back to the same wallet.
// Pure, tested under Node; it needs setCrypto() (./crypto.js).
//
//   multisigScript(m, pubkeys)  the plain m-of-n witness script
//   multisigCoin(script, f)     what a P2WSH or P2SH-P2WSH script is, with
//     f's redeemScript and witnessScript: null when it is neither, { error },
//     or { type, witnessScript, redeemScript, multisig: { m, n, pubkeys } }.
//     Only plain m-of-n is taken: compressed keys, each once, written the
//     usual way.
//   cosignerWallet(psbt, coinOf)  what all the inputs together prove:
//     { type, m, n, xpubs, derive } or { reason, noXpubs }.
//   proveOutput(wallet, script, f)  { reason } if it isn't that wallet's
//     (with `open: true` if that couldn't be told: no wallet was proved, or
//     too much to derive); { uneven: why } if it is but no wallet would ever
//     scan it; else {}.
//
// That our key is in a change script proves little: a hostile computer can
// write 2-of-3 with it and two keys of its own. Nothing is stored here, so the
// other cosigners are proved from the PSBT:
//   - a signature commits to the coin's outpoint and script, so if the
//     transaction is valid at all, its inputs' scripts are the real ones;
//   - the global xpubs (PSBT_GLOBAL_XPUB) account for the keys of an input's
//     script, all at one suffix of exactly two steps (chain, index). No one
//     can make an xpub that derives to a given key: the HMAC depends on the
//     xpub. So xpubs that do are the cosigners' accounts, or their ancestors.
//     With no steps or one, that wouldn't hold: the key itself, public, makes
//     an "xpub", and change below it is a coin no cosigner's wallet scans;
//   - keys of a change script derived from those xpubs are the same cosigners'.
// So that holds only when:
//   - every input is the same wallet: same type, m, n and xpubs. Else a coin
//     the attacker funded, added beside the real ones, would "prove" its keys;
//   - in each script, xpubs and keys match one to one. Else change with one
//     cosigner's key twice could be spent by that cosigner alone;
//   - m and n are exactly the inputs'.
// Keys of a change script at different relative paths give an address no
// wallet scans: that is the `uneven` case.
//
// Nothing here logs. Reasons name positions and numbers, never keys.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { cr, hash160 } from "./crypto.js";
import { HARDENED, deriveChild } from "./bip32.js";
import { toHex, equal, concat } from "./psbt/bytes.js";
import { classify, parseMultisig, TYPE_NAMES } from "./psbt/script.js";

const OP_CHECKMULTISIG = 0xae;
// Public derivations for one PSBT's proof: a hostile one could ask for many,
// and a handler has 10 s. Past this, change is not proved. (512 took 380 ms
// under QEMU, which says little of a Zero: this leaves 39 ms each. A 2-of-3
// spend of about 80 inputs fits.)
const MAX_DERIVATIONS = 256;

export function multisigScript(m, pubkeys) {
  const parts = [Uint8Array.of(0x50 + m)];
  for (const k of pubkeys) parts.push(Uint8Array.of(k.length), k);
  parts.push(Uint8Array.of(0x50 + pubkeys.length, OP_CHECKMULTISIG));
  return concat(parts);
}

function plainMultisig(script) {
  const ms = parseMultisig(script);
  if (!ms) return { error: "its witness script is not a plain m-of-n multisig: only those are signed" };
  if (ms.pubkeys.some((k) => k.length !== 33)) return { error: "its witness script has an uncompressed key, which segwit doesn't allow" };
  const seen = new Set(ms.pubkeys.map(toHex));
  if (seen.size !== ms.n) return { error: "its witness script has the same key twice" };
  if (!equal(multisigScript(ms.m, ms.pubkeys), script)) return { error: "its witness script is not written the usual way" };
  return ms;
}

export function multisigCoin(script, f) {
  const outer = classify(script);
  let inner = outer, redeemScript = null, type = "p2wsh";
  if (outer.type === "p2sh") {
    if (!f.redeemScript || !equal(hash160(f.redeemScript), outer.hash)) return null;
    inner = classify(f.redeemScript);
    redeemScript = f.redeemScript;
    type = "p2sh-p2wsh";
  }
  if (inner.type !== "p2wsh") return null;
  if (!f.witnessScript) return { error: `it is a ${TYPE_NAMES.p2wsh} script without its witnessScript` };
  if (!equal(cr().sha256(f.witnessScript), inner.program)) return { error: "its witnessScript is not the one the script commits to" };
  const multisig = plainMultisig(f.witnessScript);
  return multisig.error ? multisig : { type, witnessScript: f.witnessScript, redeemScript, multisig };
}

function xpubNode(raw) {
  const key = raw.subarray(45);
  if ((key[0] !== 2 && key[0] !== 3) || !cr().isPublicKey(key)) return null;
  return { depth: raw[4], parentFingerprint: raw.slice(5, 9), childNumber: 0, chainCode: raw.slice(13, 45), privateKey: null, publicKey: key.slice() };
}

// Public derivation from the global xpubs, step by step, each step once.
class Deriver {
  constructor(xpubs) {
    this.xpubs = xpubs;
    this.nodes = new Map();
    this.left = MAX_DERIVATIONS;
    this.spent = false;
  }
  node(x, suffix) {
    if (suffix.length === 0) return x.node;
    const id = `${x.id}/${suffix.join("/")}`;
    let n = this.nodes.get(id);
    if (n === undefined) {
      const parent = this.node(x, suffix.slice(0, -1));
      if (!parent) return null;
      if (this.left === 0) {
        this.spent = true;
        return null;
      }
      this.left--;
      try {
        n = deriveChild(parent, suffix[suffix.length - 1]);
      } catch {
        n = null;
      }
      this.nodes.set(id, n);
    }
    return n;
  }
  // The xpub that accounts for this key, as the PSBT names it, or null.
  // -> { id, suffix }
  account(pubkey, derivations) {
    const d = derivations.find((c) => equal(c.pubkey, pubkey));
    if (!d) return null;
    for (const x of this.xpubs) {
      if (!equal(x.fingerprint, d.fingerprint) || d.path.length < x.path.length) continue;
      if (!x.path.every((step, i) => step === d.path[i])) continue;
      const suffix = d.path.slice(x.path.length);
      if (suffix.some((step) => step >= HARDENED)) continue;
      const n = this.node(x, suffix);
      if (n && equal(n.publicKey, pubkey)) return { id: x.id, suffix };
    }
    return null;
  }
  // Every key of `ms` to an xpub of its own: [{ id, suffix }], or { reason }.
  accountAll(ms, derivations, what) {
    const found = [];
    for (const k of ms.pubkeys) {
      const a = this.account(k, derivations);
      if (!a) return { reason: this.spent ? "it has too many keys to check here" : `a key of ${what} doesn't derive from the PSBT's xpubs` };
      found.push(a);
    }
    if (new Set(found.map((a) => a.id)).size !== ms.n) return { reason: `two keys of ${what} derive from one xpub` };
    return found;
  }
}

// What is wrong with where a script's keys sit below their xpubs, or null.
function unevenPaths(found) {
  const path = found[0].suffix.join("/");
  if (found.some((a) => a.suffix.join("/") !== path)) return "its keys are at different paths, which no wallet scans";
  if (found[0].suffix.length !== 2) return "its keys are not two steps (chain, index) below the cosigners' xpubs";
  return null;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const shape = (x) => `${x.m} of ${x.n}`;

const wallets = new WeakMap();

// `coinOf(psbt, i)`: the coin input i spends, { script } or { error }.
export function cosignerWallet(psbt, coinOf) {
  let w = wallets.get(psbt);
  if (!w) {
    w = proveInputs(psbt, coinOf);
    wallets.set(psbt, w);
  }
  return w;
}

function proveInputs(psbt, coinOf) {
  const xpubs = [];
  for (const x of psbt.global.fields.xpubs) {
    const node = xpubNode(x.xpub);
    if (node) xpubs.push({ id: toHex(x.xpub.subarray(4)), node, fingerprint: x.fingerprint, path: x.path });
  }
  if (!xpubs.length) return { reason: "this PSBT doesn't carry the cosigners' xpubs", noXpubs: true };
  const derive = new Deriver(xpubs);
  let wallet = null;
  for (let i = 0; i < psbt.inputs.length; i++) {
    const what = `input ${i + 1}`, f = psbt.inputs[i].fields;
    const coin = coinOf(psbt, i);
    if (coin.error) return { reason: `${what}: ${coin.error}` };
    const c = multisigCoin(coin.script, f);
    if (!c) return { reason: `${what} is not multisig` };
    if (c.error) return { reason: `${what}: ${c.error}` };
    const found = derive.accountAll(c.multisig, f.bip32, what);
    if (found.reason) return found;
    const uneven = unevenPaths(found);
    if (uneven) return { reason: `${what}: ${uneven}` };
    const ids = found.map((a) => a.id);
    if (!wallet) wallet = { type: c.type, m: c.multisig.m, n: c.multisig.n, xpubs: ids, derive };
    else if (c.type !== wallet.type || c.multisig.m !== wallet.m || c.multisig.n !== wallet.n || !sameSet(ids, wallet.xpubs)) {
      return { reason: `${what} is not the same wallet as input 1` };
    }
  }
  return wallet || { reason: "it has no inputs" };
}

export function proveOutput(wallet, script, f) {
  if (wallet.reason) return { ...wallet, open: true };
  const c = multisigCoin(script, f);
  if (!c) return { reason: "it is not multisig" };
  if (c.error) return { reason: c.error };
  if (c.type !== wallet.type) return { reason: `it is ${c.type.toUpperCase()}, and the inputs ${wallet.type.toUpperCase()}` };
  if (c.multisig.m !== wallet.m || c.multisig.n !== wallet.n) {
    return { reason: `it is ${shape(c.multisig)}, and the inputs ${shape(wallet)}` };
  }
  const found = wallet.derive.accountAll(c.multisig, f.bip32, "this output");
  if (found.reason) return { ...found, open: wallet.derive.spent };
  if (!sameSet(found.map((a) => a.id), wallet.xpubs)) return { reason: "its keys are not the inputs' cosigners" };
  const uneven = unevenPaths(found);
  return uneven ? { uneven } : {};
}
