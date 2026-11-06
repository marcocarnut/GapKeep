// Signing PSBTs with one BIP-32 wallet, and checking what they claim first.
//
//   plan(psbt, key, options)      what signPsbt would do, without signing:
//     -> { fingerprint, inputs: [InputPlan], outputs: [OutputPlan], signable, complete }
//   signPsbt(psbt, key, options)  signs what plan() says can be signed:
//     -> { psbt (a new, re-parsed PSBT), signed: [{ input, path, pubkey }],
//          skipped: [{ input, reason }], plan }
//   planKeys(psbt, keys, options)  plan() for several keys together:
//     -> { inputs, outputs, signable, complete, keys: [{ fingerprint, signs }] }
//   signKeys(psbt, keys, options)  each key in turn:
//     -> { psbt, signed, plan (planKeys of the result) }
//   verifyChange(psbt, key, options) -> plan(...).outputs
//   finalize(psbt) -> { tx (Uint8Array), txid, vsize }   when every input is signed
//
//   InputPlan  = { index, sign, final (already finalized), signed (holds a good signature), badSignature,
//                  mine (false: this key has nothing to do with it), type,
//                  path ("m/84'/0'/0'/0/3") | null, pubkey (hex) | null, sighash (number),
//                  reason (for people, when not signing) | null, oddities: [string] }
//   OutputPlan = { index, ours, type, path | null, role: "change" | "receive" | null,
//                  problem: string | null, oddities: [string] }
//
// `psbt` from parsePsbt() (./psbt/psbt.js). `key` is one of:
//   - a private BIP-32 node (./bip32.js) at depth 0: a master key;
//   - a private BIP-32 node deeper down, as an account's xprv. It doesn't know
//     the master's fingerprint, so it recognises its keys by its own
//     fingerprint (Electrum's watch-only wallets) or by the path and the
//     public key the PSBT names: deriving must give that very key;
//   - a single key, { single: true, privateKey, publicKey } (keys.js: WIF).
//     It has no paths: an input or output is its own if the script pays to
//     that key.
// options:
//   accounts  account paths whose own fingerprint may stand for the master's:
//             Electrum's watch-only wallets made from an account xpub (zpub...)
//             put that account's fingerprint and the path below it (m/0/5) in
//             their PSBTs. Default: STANDARD_ACCOUNTS (account 0 of BIP-44,
//             49, 84 and 86 on mainnet and test networks).
//   network   "mainnet", "testnet" or "regtest": flags coin types that differ.
//   maxIndex  an address index above this is flagged (default 1000000).
//   aux       taproot's auxiliary randomness: a Uint8Array(32), or a function
//             (inputIndex) -> Uint8Array(32). Default: fresh random bytes from
//             the crypto given (zg:crypto); tests pass zeros to compare.
//
// An input is signed only when all of these hold:
//   - it spends a P2WPKH, P2SH-P2WPKH, P2TR (key path, no script tree) or
//     P2PKH coin, and is not final yet;
//   - the coin is described: a witness UTXO or the previous transaction
//     (whose txid must be the one spent; both, when given, must agree);
//     P2PKH needs the previous transaction (its amount is not otherwise
//     signed); taproot needs every input's coin (its signature covers all
//     amounts);
//   - its sighash type is ALL (or taproot's DEFAULT): anything else is refused;
//   - one of its BIP-32 (taproot: BIP-32 taproot) derivations has this
//     wallet's fingerprint (or one of `accounts`), the key derived at that
//     path is the key the PSBT names, and that key is the one the coin's
//     script pays to (taproot: BIP-86's tweak of it is the output key).
//     For a single key: the coin's script pays to it;
//   - it holds no good signature yet.
// Each signature is verified before it is added. Signatures already in the
// PSBT (from a merged copy) are verified too, and must be SIGHASH_ALL: a bad
// one is reported (`badSignature`), and the input doesn't count as signed.
//
// An output is "ours" only when deriving its stated path gives the key it
// names, and that key's script (P2WPKH, P2SH-P2WPKH, P2PKH, or BIP-86 P2TR)
// is the output's script. Fingerprints alone prove nothing: anyone can
// write ours into a PSBT.
//
// Nothing here logs; reasons and errors name paths and positions, never keys.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { cr, hash160, taggedHash, zero } from "./crypto.js";
import { HARDENED, deriveChild, fingerprint, parsePath, formatPath, wipe } from "./bip32.js";
import { SIGHASH, legacySighash, segwitV0Sighash, taprootSighash, p2wpkhScriptCode } from "./sighash.js";
import { toHex, toHexReversed, equal, concat } from "./psbt/bytes.js";
import { parsePsbt, serializePsbt, setEntry, IN } from "./psbt/psbt.js";
import { txid as txidOf, serializeTx, vsize as vsizeOf } from "./psbt/tx.js";
import { classify, p2wpkhScript, p2shScript, p2pkhScript, TYPE_NAMES } from "./psbt/script.js";

export class SignError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignError";
  }
}

export const STANDARD_ACCOUNTS = ["m/84'/0'/0'", "m/49'/0'/0'", "m/86'/0'/0'", "m/44'/0'/0'",
  "m/84'/1'/0'", "m/49'/1'/0'", "m/86'/1'/0'", "m/44'/1'/0'"];

export const MAX_INDEX = 1000000;
const MAX_DEPTH = 16;

// BIP-44/49/84/86: the purpose each script type's accounts use.
const PURPOSE = { p2pkh: 44, "p2sh-p2wpkh": 49, p2wpkh: 84, p2tr: 86 };

const typeName = (t) => (t === "p2sh-p2wpkh" ? "P2SH-P2WPKH" : TYPE_NAMES[t] || t);
const sighashName = (t) => ({ 0: "DEFAULT", 1: "ALL", 2: "NONE", 3: "SINGLE", 0x81: "ALL|ANYONECANPAY",
  0x82: "NONE|ANYONECANPAY", 0x83: "SINGLE|ANYONECANPAY" })[t] || "0x" + t.toString(16);

// The keys of one call: derived once, cached by path, wiped at the end.
class Keys {
  constructor(root, accounts) {
    if (!root || !root.privateKey) throw new SignError("signing needs a private key");
    this.root = root;
    this.single = root.single === true;
    this.depth = this.single ? null : root.depth;
    this.fp = hash160(root.publicKey).subarray(0, 4);
    this.accounts = (accounts || STANDARD_ACCOUNTS).map((a) => parsePath(a));
    this.byFingerprint = null; // account fingerprint (hex) -> account path
    this.cache = new Map();
  }
  // `path` is relative to the root
  node(path) {
    if (path.length === 0) return this.root;
    // a hostile PSBT could ask for very deep keys, one slow step each
    if (path.length > MAX_DEPTH) throw new SignError(`longer than ${MAX_DEPTH} steps`);
    const id = path.join("/");
    let n = this.cache.get(id);
    if (!n) {
      n = deriveChild(this.node(path.slice(0, -1)), path[path.length - 1]);
      this.cache.set(id, n);
    }
    return n;
  }
  // Where a derivation from the PSBT would be under this key, or null when
  // it is not. -> { rel (below the root), full (from the master, null when
  // not known), guess (only the public key can tell: a mismatch means
  // "someone else's", not a lie) }
  resolve(fp, path) {
    if (this.single) return null;
    if (this.depth === 0) {
      if (equal(fp, this.fp)) return { rel: path, full: path, guess: false };
      if (!this.byFingerprint) {
        this.byFingerprint = new Map();
        for (const a of this.accounts) {
          const id = toHex(fingerprint(this.node(a)));
          if (!this.byFingerprint.has(id)) this.byFingerprint.set(id, a);
        }
      }
      const account = this.byFingerprint.get(toHex(fp));
      if (!account) return null;
      const full = account.concat(path);
      return { rel: full, full, guess: false };
    }
    if (equal(fp, this.fp)) return { rel: path, full: null, guess: false };
    if (path.length > this.depth && path[this.depth - 1] === this.root.childNumber) {
      return { rel: path.slice(this.depth), full: path, guess: true };
    }
    return null;
  }
  wipe() {
    for (const n of this.cache.values()) wipe(n);
    this.cache.clear();
  }
}

// How a key below the root is shown when the path above it is not known
const pathText = (loc) => (loc.full ? formatPath(loc.full) : "key" + formatPath(loc.rel).slice(1));

// The coin an input spends: { value, script } or { error }.
function spentOutput(psbt, i) {
  const f = psbt.inputs[i].fields, txin = psbt.tx.inputs[i];
  let out = null;
  if (f.nonWitnessUtxo) {
    if (toHexReversed(txin.txid) !== txidOf(f.nonWitnessUtxo)) {
      return { error: "its previous transaction is not the one it spends (wrong txid)" };
    }
    const o = f.nonWitnessUtxo.outputs[txin.vout];
    if (!o) return { error: `its previous transaction has no output ${txin.vout}` };
    out = { value: o.value, script: o.script, full: true };
  }
  if (f.witnessUtxo) {
    if (out && (out.value !== f.witnessUtxo.value || !equal(out.script, f.witnessUtxo.script))) {
      return { error: "its previous transaction and its witness UTXO disagree about the coin" };
    }
    if (!out) out = { value: f.witnessUtxo.value, script: f.witnessUtxo.script, full: false };
  }
  if (!out) return { error: "the coin it spends is not described (no UTXO in the PSBT), so its amount is unknown" };
  if (typeof out.value !== "number" || out.value > 2100000000000000) return { error: "its amount is impossible" };
  return out;
}

// What kind of coin: { type, hash?, program?, redeemScript? } or { error }.
function coinType(script, f) {
  const c = classify(script);
  if (c.type === "p2sh") {
    if (!f.redeemScript) return { error: "it spends a P2SH coin without its redeemScript" };
    if (!equal(hash160(f.redeemScript), c.hash)) return { error: "its redeemScript is not the one the coin's script commits to" };
    const inner = classify(f.redeemScript);
    if (inner.type === "p2wpkh") return { type: "p2sh-p2wpkh", hash: inner.hash, redeemScript: f.redeemScript };
    return { error: "it spends a P2SH coin that is not P2SH-P2WPKH (multisig and other scripts are not supported)" };
  }
  if (c.type === "p2wpkh" || c.type === "p2pkh") return { type: c.type, hash: c.hash };
  if (c.type === "p2tr") return { type: "p2tr", program: c.program };
  return { error: `it spends a ${TYPE_NAMES[c.type] || c.type} coin: only single-key P2WPKH, P2SH-P2WPKH, P2TR and P2PKH are signed` };
}

const bip86Tweak = (xonly) => taggedHash("TapTweak", xonly);
const p2trOutputKey = (xonly) => cr().taprootTweakPublicKey(xonly, bip86Tweak(xonly)).key;

// Does `node`'s key (claimed at `path`) control this coin? null if so, else why not.
function keyControls(node, d, coin, f, where) {
  if (coin.type === "p2tr") {
    const xonly = node.publicKey.subarray(1);
    if (!equal(d.xonly, xonly)) return `the key at ${where} is not the one the PSBT names`;
    if (f.tapInternalKey && !equal(f.tapInternalKey, xonly)) return `the coin's internal key is not the key at ${where}`;
    if (!equal(p2trOutputKey(xonly), coin.program)) return `the coin's taproot output key is not BIP-86's for the key at ${where}`;
    return null;
  }
  if (d.pubkey.length !== 33 || !equal(d.pubkey, node.publicKey)) return `the key at ${where} is not the one the PSBT names`;
  const h = hash160(node.publicKey);
  if (!equal(coin.hash, h)) return `the coin's script doesn't pay to the key at ${where}`;
  return null;
}

// A signature the PSBT already holds for this single-key coin (from a merged
// copy): "none", "good", or "bad" (doesn't verify, or isn't SIGHASH_ALL).
function heldSignature(psbt, i, ct, coin, prevouts) {
  const f = psbt.inputs[i].fields, tx = psbt.tx;
  if (ct.type === "p2tr") {
    const sig = f.tapKeySig;
    if (!sig) return "none";
    if (prevouts.some((p) => p.error)) return "bad";
    if (!(sig.length === 64 || (sig.length === 65 && sig[64] === SIGHASH.ALL))) return "bad";
    const type = sig.length === 65 ? SIGHASH.ALL : SIGHASH.DEFAULT;
    const coins = prevouts.map((c) => ({ value: c.value, script: c.script }));
    return cr().schnorrVerify(sig.subarray(0, 64), taprootSighash(tx, i, coins, type), ct.program) ? "good" : "bad";
  }
  const held = f.partialSigs.filter((s) => s.pubkey.length === 33 && equal(hash160(s.pubkey), ct.hash));
  if (!held.length) return "none";
  const hash = ct.type === "p2pkh" ? legacySighash(tx, i, coin.script, SIGHASH.ALL)
    : segwitV0Sighash(tx, i, p2wpkhScriptCode(ct.hash), coin.value, SIGHASH.ALL);
  for (const s of held) {
    if (s.signature.length < 9 || s.signature[s.signature.length - 1] !== SIGHASH.ALL) continue;
    if (cr().ecdsaVerify(s.signature.subarray(0, s.signature.length - 1), hash, s.pubkey)) return "good";
  }
  return "bad";
}

// What each input holds when no key is loaded: "final", or as heldSignature.
// (A merged PSBT can be complete with no key in this device.)
function heldByNobody(psbt) {
  const prevouts = psbt.inputs.map((_, i) => spentOutput(psbt, i));
  return psbt.inputs.map((m, i) => {
    const f = m.fields;
    if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) return "final";
    if (prevouts[i].error) return "none";
    const ct = coinType(prevouts[i].script, f);
    return ct.error ? "none" : heldSignature(psbt, i, ct, prevouts[i], prevouts);
  });
}

function pathOddities(path, type, network, maxIndex) {
  const odd = [];
  const p = formatPath(path);
  if (path.length !== 5) {
    odd.push(`${p} is not the usual m/purpose'/coin'/account'/change/index`);
    if (path.length >= 1 && path[path.length - 1] > maxIndex && path[path.length - 1] < HARDENED) {
      odd.push(`index ${path[path.length - 1]} is unusually high`);
    }
    return odd;
  }
  const [purpose, coin, account, branch, index] = path;
  if (purpose < HARDENED || coin < HARDENED || account < HARDENED) odd.push(`${p}: the first three steps are usually hardened`);
  const want = PURPOSE[type];
  if (want !== undefined && purpose !== want + HARDENED) {
    odd.push(`${p}: purpose ${purpose >= HARDENED ? purpose - HARDENED + "'" : purpose} is not the usual ${want}' for ${typeName(type)}`);
  }
  if (network && (coin === HARDENED || coin === HARDENED + 1) && (coin === HARDENED) !== (network === "mainnet")) {
    odd.push(`${p}: coin type ${coin - HARDENED}' is for ${coin === HARDENED ? "mainnet" : "test networks"}, not ${network}`);
  }
  if (branch !== 0 && branch !== 1) {
    odd.push(`${p}: branch ${branch >= HARDENED ? branch - HARDENED + "'" : branch} is neither receive (0) nor change (1)`);
  }
  if (index >= HARDENED) odd.push(`${p}: a hardened address index`);
  else if (index > maxIndex) odd.push(`${p}: index ${index} is unusually high`);
  return odd;
}

const accountOf = (path) => formatPath(path.length >= 3 ? path.slice(0, path.length - 2) : path.slice(0, 1));

function planInput(psbt, i, keys, prevouts) {
  const f = psbt.inputs[i].fields;
  const r = { index: i, sign: false, final: false, signed: false, badSignature: false, mine: false, type: null, path: null,
    pubkey: null, sighash: null, reason: null, oddities: [] };
  const no = (reason) => {
    r.reason = reason;
    return r;
  };
  if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) {
    r.final = true;
    return no("it is already signed (final)");
  }
  const coin = prevouts[i];
  if (coin.error) return no(coin.error);
  const ct = coinType(coin.script, f);
  if (ct.error) return no(ct.error);
  r.type = ct.type;
  const taproot = ct.type === "p2tr";

  if (ct.type === "p2pkh" && !coin.full) {
    return no("a P2PKH coin is signed only with its previous transaction in the PSBT (Electrum's QR codes leave it out: " +
      "export the PSBT as a file instead)");
  }
  r.sighash = f.sighashType ?? (taproot ? SIGHASH.DEFAULT : SIGHASH.ALL);
  if (!(r.sighash === SIGHASH.ALL || (taproot && r.sighash === SIGHASH.DEFAULT))) {
    return no(`it asks for sighash ${sighashName(r.sighash)}: only ALL${taproot ? " (or DEFAULT)" : ""} is signed`);
  }
  if (taproot) {
    if (f.tapMerkleRoot) return no("its taproot coin has a script tree: only BIP-86 key-path spends are signed");
    const missing = prevouts.findIndex((p) => p.error);
    if (missing >= 0) return no(`input ${missing + 1}'s coin is not known, and a taproot signature covers every input's amount`);
  }

  const held = heldSignature(psbt, i, ct, coin, prevouts);
  if (held === "good") {
    r.signed = true;
    return no("it is signed already");
  }
  r.badSignature = held === "bad";

  if (keys.single) {
    const node = keys.root;
    const xonly = node.publicKey.subarray(1);
    if (!(taproot ? equal(p2trOutputKey(xonly), ct.program) : equal(hash160(node.publicKey), ct.hash))) {
      return no("this key doesn't control it");
    }
    r.sign = r.mine = true;
    r.keyPath = [];
    r.fullPath = null;
    r.pubkey = toHex(taproot ? xonly : node.publicKey);
    return r;
  }

  const derivations = taproot ? f.tapBip32.filter((d) => d.leafHashes.length === 0) : f.bip32;
  if (derivations.length === 0) return no("the PSBT names no key (BIP-32 derivation) for it");
  let firstProblem = null, anyOurs = false;
  for (const d of derivations) {
    const loc = keys.resolve(d.fingerprint, d.path);
    if (!loc) continue;
    const where = pathText(loc);
    let node;
    try {
      node = keys.node(loc.rel);
    } catch (e) {
      if (loc.guess) continue;
      anyOurs = true;
      firstProblem = firstProblem || `the key at ${where} can't be derived (${e.message})`;
      continue;
    }
    const problem = keyControls(node, d, ct, f, where);
    if (problem) {
      if (loc.guess) continue;
      anyOurs = true;
      firstProblem = firstProblem || problem;
      continue;
    }
    r.sign = r.mine = true;
    r.path = where;
    r.keyPath = loc.rel;
    r.fullPath = loc.full;
    r.pubkey = toHex(taproot ? node.publicKey.subarray(1) : node.publicKey);
    return r;
  }
  if (!anyOurs) {
    const fps = [...new Set(derivations.map((d) => toHex(d.fingerprint)))].join(", ");
    return no(`its key${derivations.length > 1 ? "s are" : " is"} from another wallet (fingerprint ${fps}; ` +
      `this wallet is ${toHex(keys.fp)})`);
  }
  r.mine = true;
  return no(firstProblem);
}

// The scripts a key can pay to: what kind this one is, or null.
function paysTo(script, publicKey) {
  const h = hash160(publicKey);
  const w = p2wpkhScript(h);
  if (equal(script, w)) return "p2wpkh";
  if (equal(script, p2shScript(hash160(w)))) return "p2sh-p2wpkh";
  if (equal(script, p2pkhScript(h))) return "p2pkh";
  return null;
}

function planOutput(psbt, i, keys) {
  const f = psbt.outputs[i].fields, script = psbt.tx.outputs[i].script;
  const o = { index: i, ours: false, type: null, path: null, role: null, problem: null, oddities: [] };
  if (keys.single) {
    const type = paysTo(script, keys.root.publicKey) ||
      (equal(script, concat([Uint8Array.of(0x51, 32), p2trOutputKey(keys.root.publicKey.subarray(1))])) ? "p2tr" : null);
    if (type) {
      o.ours = true;
      o.type = type;
      o.fullPath = null;
    } else {
      o.type = classify(script).type;
    }
    return o;
  }
  const claims = [
    ...f.bip32.map((d) => ({ d, taproot: false })),
    ...f.tapBip32.filter((d) => d.leafHashes.length === 0).map((d) => ({ d, taproot: true })),
  ];
  for (const { d, taproot } of claims) {
    const loc = keys.resolve(d.fingerprint, d.path);
    if (!loc) continue;
    const where = pathText(loc);
    const claim = (text) => {
      if (!loc.guess) o.problem = o.problem || text;
    };
    let node;
    try {
      node = keys.node(loc.rel);
    } catch (e) {
      claim(`it says it is yours (${where}), but that key can't be derived`);
      continue;
    }
    let type = null;
    if (taproot) {
      const xonly = node.publicKey.subarray(1);
      if (!equal(d.xonly, xonly)) {
        claim(`it says it is yours (${where}), but the key it names is not this wallet's key at that path`);
        continue;
      }
      if (equal(script, concat([Uint8Array.of(0x51, 32), p2trOutputKey(xonly)]))) type = "p2tr";
    } else {
      if (d.pubkey.length !== 33 || !equal(d.pubkey, node.publicKey)) {
        claim(`it says it is yours (${where}), but the key it names is not this wallet's key at that path`);
        continue;
      }
      type = paysTo(script, node.publicKey);
    }
    if (!type) {
      claim(`it says it is yours (${where}), but it doesn't pay to that key`);
      continue;
    }
    o.ours = true;
    o.problem = null;
    o.type = type;
    o.path = where;
    o.fullPath = loc.full;
    const branch = loc.rel.length >= 2 ? loc.rel[loc.rel.length - 2] : -1;
    o.role = branch === 1 ? "change" : branch === 0 ? "receive" : null;
    break;
  }
  if (!o.ours) o.type = classify(script).type;
  return o;
}

function planWith(psbt, keys, options) {
  const network = options.network || null, maxIndex = options.maxIndex ?? MAX_INDEX;
  if (psbt.tx.locktime === null) {
    const reason = "the inputs' locktime requirements contradict each other (PSBT version 2)";
    return { inputs: psbt.inputs.map((_, index) => ({ index, sign: false, final: false, signed: false, badSignature: false,
      mine: false, type: null, path: null, pubkey: null, sighash: null, reason, oddities: [] })), outputs: psbt.outputs.map((_, i) => planOutput(psbt, i, keys)) };
  }
  const prevouts = psbt.inputs.map((_, i) => spentOutput(psbt, i));
  const inputs = psbt.inputs.map((_, i) => planInput(psbt, i, keys, prevouts));
  const outputs = psbt.outputs.map((_, i) => planOutput(psbt, i, keys));

  // oddities: the path itself, and an account other than most inputs'
  const signing = inputs.filter((r) => r.sign && r.fullPath);
  const counts = new Map();
  for (const r of signing) counts.set(accountOf(r.fullPath), (counts.get(accountOf(r.fullPath)) || 0) + 1);
  let main = null;
  for (const [a, n] of counts) if (main === null || n > counts.get(main)) main = a;
  const types = new Set(inputs.filter((r) => r.sign).map((r) => r.type));
  for (const r of [...signing, ...outputs.filter((o) => o.ours && o.fullPath)]) {
    r.oddities.push(...pathOddities(r.fullPath, r.type, network, maxIndex));
    const a = accountOf(r.fullPath);
    if (main !== null && a !== main) {
      r.oddities.push(`account ${a} is not the one ${signing.length > 1 ? "most inputs use" : "the input uses"} (${main})`);
    }
  }
  for (const o of outputs) {
    if (o.ours && types.size && !types.has(o.type)) {
      o.oddities.push(`it pays to a ${typeName(o.type)} script of your key, but the inputs are ${[...types].map(typeName).join(", ")}`);
    }
  }
  return { inputs, outputs, prevouts };
}

function publicPlan(p, keys) {
  const strip = ({ fullPath, keyPath, ...rest }) => rest;
  const inputs = p.inputs.map(strip), outputs = p.outputs.map(strip);
  const signable = inputs.filter((r) => r.sign).length;
  return { fingerprint: toHex(keys.fp), inputs, outputs, signable,
    complete: inputs.every((r) => r.sign || r.final || r.signed) };
}

export function plan(psbt, key, options = {}) {
  const keys = new Keys(key, options.accounts);
  try {
    return publicPlan(planWith(psbt, keys, options), keys);
  } finally {
    keys.wipe();
  }
}

export const verifyChange = (psbt, key, options = {}) => plan(psbt, key, options).outputs;

// plan() for several keys: each input and output as the key that can do
// most with it sees it. `keys[i].signs` counts the inputs that key can sign
// by itself. An output no key speaks for (neither `ours` nor a `problem`)
// stays unchecked: `claimed` says that it names keys at all.
export function planKeys(psbt, list, options = {}) {
  const plans = list.map((k) => plan(psbt, k, options));
  const held = plans.length ? null : heldByNobody(psbt);
  const rank = (r) => (r.sign ? 3 : r.final || r.signed ? 2 : r.mine ? 1 : 0);
  const inputs = psbt.inputs.map((_, i) => {
    let best = null;
    for (const p of plans) if (!best || rank(p.inputs[i]) > rank(best)) best = p.inputs[i];
    return best || { index: i, sign: false, final: held[i] === "final", signed: held[i] === "good", badSignature: held[i] === "bad",
      mine: false, type: null, path: null, pubkey: null, sighash: null,
      reason: held[i] === "final" || held[i] === "good" ? "it is signed already" : "no key is loaded", oddities: [] };
  });
  const outputs = psbt.outputs.map((m, i) => {
    let best = null;
    for (const p of plans) {
      const o = p.outputs[i];
      if (!best || (o.ours && !best.ours) || (!best.ours && o.problem && !best.problem)) best = o;
    }
    return { ...(best || { index: i, ours: false, type: null, path: null, role: null, problem: null, oddities: [] }),
      claimed: m.fields.bip32.length + m.fields.tapBip32.length > 0 };
  });
  return { inputs, outputs, signable: inputs.filter((r) => r.sign).length,
    complete: inputs.every((r) => r.sign || r.final || r.signed),
    keys: plans.map((p) => ({ fingerprint: p.fingerprint, signs: p.signable })) };
}

// Each key signs what it can, on top of the signatures before it.
export function signKeys(psbt, list, options = {}) {
  let current = psbt;
  const signed = [];
  for (const k of list) {
    const r = signPsbt(current, k, options);
    current = r.psbt;
    signed.push(...r.signed);
  }
  return { psbt: current, signed, plan: planKeys(current, list, options) };
}

function auxFor(options, i) {
  const a = options.aux;
  if (a === undefined || a === null) return undefined;
  const v = typeof a === "function" ? a(i) : a;
  if (!(v instanceof Uint8Array) || v.length !== 32) throw new SignError("aux: 32 bytes expected");
  return v;
}

export function signPsbt(psbt, key, options = {}) {
  const keys = new Keys(key, options.accounts);
  try {
    const p = planWith(psbt, keys, options);
    const out = parsePsbt(serializePsbt(psbt)); // a copy: the caller's PSBT is left as it was
    const tx = out.tx;
    const signed = [], skipped = [];
    const coins = p.inputs.some((r) => r.sign && r.type === "p2tr")
      ? p.prevouts.map((c) => ({ value: c.value, script: c.script })) : null; // all known when a taproot input signs
    for (const r of p.inputs) {
      if (!r.sign) {
        skipped.push({ input: r.index, reason: r.reason });
        continue;
      }
      const node = keys.node(r.keyPath);
      const coin = p.prevouts[r.index];
      if (r.type === "p2tr") {
        const xonly = node.publicKey.subarray(1);
        const tweak = bip86Tweak(xonly);
        const q = cr().taprootTweakPublicKey(xonly, tweak).key;
        const msg = taprootSighash(tx, r.index, coins, r.sighash);
        const key = cr().taprootTweakPrivateKey(node.privateKey, tweak);
        let sig;
        try {
          const aux = auxFor(options, r.index);
          sig = aux === undefined ? cr().schnorrSign(msg, key) : cr().schnorrSign(msg, key, aux);
        } finally {
          zero(key);
        }
        if (!cr().schnorrVerify(sig, msg, q)) throw new SignError(`input ${r.index + 1}: the signature made doesn't verify`);
        const value = r.sighash === SIGHASH.DEFAULT ? sig : concat([sig, Uint8Array.of(r.sighash)]);
        setEntry(out.inputs[r.index], IN.TAP_KEY_SIG, new Uint8Array(0), value);
      } else {
        const h = hash160(node.publicKey);
        const hash = r.type === "p2pkh"
          ? legacySighash(tx, r.index, coin.script, r.sighash)
          : segwitV0Sighash(tx, r.index, p2wpkhScriptCode(h), coin.value, r.sighash);
        const der = cr().ecdsaSign(hash, node.privateKey);
        if (!cr().ecdsaVerify(der, hash, node.publicKey)) throw new SignError(`input ${r.index + 1}: the signature made doesn't verify`);
        setEntry(out.inputs[r.index], IN.PARTIAL_SIG, node.publicKey, concat([der, Uint8Array.of(r.sighash)]));
      }
      signed.push({ input: r.index, path: r.path, pubkey: r.pubkey });
    }
    const result = signed.length ? parsePsbt(serializePsbt(out)) : out;
    return { psbt: result, signed, skipped, plan: publicPlan(p, keys) };
  } finally {
    keys.wipe();
  }
}

// --- the final transaction -----------------------------------------------------

const push = (data) => {
  if (data.length > 75) throw new SignError("push too long"); // signatures, keys and P2SH-P2WPKH's redeemScript are short
  return concat([Uint8Array.of(data.length), data]);
};

// The network transaction, when every input is signed (or final). Throws
// SignError naming the first input that isn't. Signatures are taken as they
// are in the PSBT (signPsbt verified its own).
export function finalize(psbt) {
  const tx = { ...psbt.tx, inputs: [], segwit: false };
  for (let i = 0; i < psbt.inputs.length; i++) {
    const f = psbt.inputs[i].fields, txin = psbt.tx.inputs[i];
    const n = i + 1;
    if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) {
      tx.inputs.push({ ...txin, scriptSig: f.finalScriptSig || new Uint8Array(0), witness: f.finalScriptWitness || [] });
      continue;
    }
    const coin = spentOutput(psbt, i);
    if (coin.error) throw new SignError(`input ${n}: ${coin.error}`);
    const ct = coinType(coin.script, f);
    if (ct.error) throw new SignError(`input ${n}: ${ct.error}`);
    if (ct.type === "p2tr") {
      if (!f.tapKeySig) throw new SignError(`input ${n} is not signed`);
      tx.inputs.push({ ...txin, scriptSig: new Uint8Array(0), witness: [f.tapKeySig] });
      continue;
    }
    const sig = f.partialSigs.find((s) => s.pubkey.length === 33 && equal(hash160(s.pubkey), ct.hash));
    if (!sig) throw new SignError(`input ${n} is not signed`);
    if (ct.type === "p2pkh") {
      tx.inputs.push({ ...txin, scriptSig: concat([push(sig.signature), push(sig.pubkey)]), witness: [] });
    } else {
      const scriptSig = ct.type === "p2sh-p2wpkh" ? push(ct.redeemScript) : new Uint8Array(0);
      tx.inputs.push({ ...txin, scriptSig, witness: [sig.signature, sig.pubkey] });
    }
  }
  if (tx.locktime === null) throw new SignError("the inputs' locktime requirements contradict each other");
  const bytes = serializeTx(tx);
  return { tx: bytes, txid: txidOf(tx), vsize: vsizeOf(tx) };
}
