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
//                  reason (for people, when not signing) | null, oddities: [string],
//                  multisig (those coins only): { m, n, have (good signatures), will (more from these keys) } }
//   OutputPlan = { index, ours, type, path | null, role: "change" | "receive" | null,
//                  problem: string | null, unproved: string | null, noXpubs, oddities: [string] }
//     planKeys adds `claimed`; `stray`: why an output that is ours may
//     still be lost in practice (below), or null; and `far`: the index of an
//     output at home that a wallet finds only by scanning that far, or null.
//
// `psbt` from parsePsbt() (./psbt/psbt.js). `key` is one of:
//   - a private BIP-32 node (./bip32.js) at depth 0: a master key;
//   - a private BIP-32 node deeper down, as an account's xprv. It doesn't know
//     the master's fingerprint, so it recognises its keys by its own
//     fingerprint (Electrum's watch-only wallets) or by the path and the
//     public key the PSBT names: deriving must give that very key. The steps
//     above it are the PSBT's word: paths are shown below the key
//     ("key/0/3"), and not judged as oddities;
//   - a single key, { single: true, privateKey, publicKey } (keys.js: WIF).
//     It has no paths: an input or output is its own if the script pays to
//     that key. An uncompressed one (a 65-byte publicKey) only ever spends
//     or recognises P2PKH: its other scripts would not be spendable.
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
//             the crypto given (gk:crypto); tests pass zeros to compare.
//
// An input is signed only when all of these hold:
//   - it spends a P2WPKH, P2SH-P2WPKH, P2TR (key path, no script tree) or
//     P2PKH coin, and is not final yet;
//   - the coin is described: a witness UTXO or the previous transaction
//     (whose txid must be the one spent; both, when given, must agree; the
//     amount is then the previous transaction's);
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
// finalize() takes only signatures that verify the same way.
//
// A segwit v0 input described by its witness UTXO alone is signed: that is
// all Electrum's QR codes carry. Its signature covers its own amount only,
// so with several such inputs the fee shown can be a lie (the segwit v0 fee
// attack): analyze() (./psbt/analyze.js) says so (amber), and the Signer
// remembers each coin it signed and its amount until power-off, refusing the
// same coin told with another amount (apps/signer/lib/memory.js). Taproot is
// safe from it (every input's amount is signed), and P2PKH is refused
// without its previous transaction.
//
// An output is "ours" only when deriving its stated path gives the key it
// names, and that key's script (P2WPKH, P2SH-P2WPKH, P2PKH, or BIP-86 P2TR)
// is the output's script. Multisig change needs more: see ./multisig.js. What
// it can't tell stays not ours, with `unproved` saying why; change the inputs
// prove isn't their wallet's gets a `problem`, and `notWallet`. Fingerprints
// alone prove nothing: anyone can write ours into a PSBT.
//
// An output can be truly ours and still be a way to lose the money: at a path
// the wallet never scans, it is held to ransom by whoever knows the path. So
// a verified output is only at home (planKeys; `stray` null) when, compared
// with the inputs the keys loaded sign or have signed:
//   - it is in the same account (the path but its last two steps: same
//     purpose, coin type and account);
//   - its chain is 1, or 0 (`role` says which);
//   - its index is at most CHANGE_GAP past the highest index of those
//     inputs, and not hardened.
// A single key has no path: its output is at home when that key spends too.
// With no such input to compare with, only the chain and index are checked.
//
// Wallets scan about CHANGE_NEAR addresses ahead, so an output at home but
// more than CHANGE_NEAR past those inputs is `far`: still the wallet's, and
// counted as change, but hidden from it until someone looks further. A hostile
// computer can use that, so the review says so and gives the index.
//
// Nothing here logs; reasons and errors name paths and positions, never keys.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t } from "./text.js";
import { cr, hash160, taggedHash, zero } from "./crypto.js";
import { HARDENED, deriveChild, fingerprint, parsePath, formatPath, wipe } from "./bip32.js";
import { SIGHASH, legacySighash, segwitV0Sighash, taprootSighash, p2wpkhScriptCode } from "./sighash.js";
import { toHex, toHexReversed, equal, concat } from "./psbt/bytes.js";
import { parsePsbt, serializePsbt, setEntry, IN } from "./psbt/psbt.js";
import { multisigCoin, cosignerWallet, proveOutput } from "./multisig.js";
import { txid as txidOf, serializeTx, vsize as vsizeOf, MAX_MONEY } from "./psbt/tx.js";
import { classify, p2wpkhScript, p2shScript, p2pkhScript, TYPE_NAMES } from "./psbt/script.js";

export class SignError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignError";
  }
}

export const STANDARD_ACCOUNTS = ["m/84'/0'/0'", "m/49'/0'/0'", "m/86'/0'/0'", "m/44'/0'/0'", "m/48'/0'/0'/2'",
  "m/84'/1'/0'", "m/49'/1'/0'", "m/86'/1'/0'", "m/44'/1'/0'", "m/48'/1'/0'/2'"];

export const MAX_INDEX = 1000000;
const MAX_DEPTH = 16;
export const CHANGE_NEAR = 20;
export const CHANGE_GAP = 1000;

// BIP-44/49/84/86: the purpose each script type's accounts use.
const PURPOSE = { p2pkh: 44, "p2sh-p2wpkh": 49, p2wpkh: 84, p2tr: 86, p2wsh: 48, "p2sh-p2wsh": 48 };

const typeName = (x) => (x.startsWith("p2sh-") ? "P2SH-" + TYPE_NAMES[x.slice(5)] : TYPE_NAMES[x] || x);
const sighashName = (x) => ({ 0: "DEFAULT", 1: "ALL", 2: "NONE", 3: "SINGLE", 0x81: "ALL|ANYONECANPAY",
  0x82: "NONE|ANYONECANPAY", 0x83: "SINGLE|ANYONECANPAY" })[x] || "0x" + x.toString(16);

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
    // Only the key's own child number is checked against the path: the steps
    // above it are the PSBT's word, so they are not shown (nor checked for
    // oddities) as if they were known.
    if (path.length > this.depth && path[this.depth - 1] === this.root.childNumber) {
      return { rel: path.slice(this.depth), full: null, guess: true };
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
      return { error: t("its previous transaction is not the one it spends (wrong txid)") };
    }
    const o = f.nonWitnessUtxo.outputs[txin.vout];
    if (!o) return { error: t("its previous transaction has no output {vout}", { vout: String(txin.vout) }) };
    out = { value: o.value, script: o.script, full: true };
  }
  if (f.witnessUtxo) {
    if (out && (out.value !== f.witnessUtxo.value || !equal(out.script, f.witnessUtxo.script))) {
      return { error: t("its previous transaction and its witness UTXO disagree about the coin") };
    }
    if (!out) out = { value: f.witnessUtxo.value, script: f.witnessUtxo.script, full: false };
  }
  if (!out) return { error: t("the coin it spends is not described (no UTXO in the PSBT), so its amount is unknown") };
  if (typeof out.value !== "number" || out.value > MAX_MONEY) return { error: t("its amount is impossible") };
  return out;
}

// What kind of coin: { type, hash?, program?, redeemScript? } or { error }.
function coinType(script, f) {
  const multisig = multisigCoin(script, f);
  if (multisig) return multisig;
  const c = classify(script);
  if (c.type === "p2sh") {
    if (!f.redeemScript) return { error: t("it spends a P2SH coin without its redeemScript") };
    if (!equal(hash160(f.redeemScript), c.hash)) {
      return { error: t("its redeemScript is not the one the coin's script commits to") };
    }
    const inner = classify(f.redeemScript);
    if (inner.type === "p2wpkh") return { type: "p2sh-p2wpkh", hash: inner.hash, redeemScript: f.redeemScript };
    return { error: t("it spends a P2SH coin that is not P2SH-P2WPKH or P2SH-P2WSH (other scripts are not supported)") };
  }
  if (c.type === "p2wpkh" || c.type === "p2pkh") return { type: c.type, hash: c.hash };
  if (c.type === "p2tr") return { type: "p2tr", program: c.program };
  return { error: t("it spends a {type} coin: only P2WPKH, P2SH-P2WPKH, P2TR, P2PKH and P2WSH multisig are signed",
    { type: TYPE_NAMES[c.type] || c.type }) };
}

const bip86Tweak = (xonly) => taggedHash("TapTweak", xonly);
const p2trOutputKey = (xonly) => cr().taprootTweakPublicKey(xonly, bip86Tweak(xonly)).key;

// Does `node`'s key (claimed at `path`) control this coin? null if so, else why not.
function keyControls(node, d, coin, f, where) {
  if (coin.type === "p2tr") {
    const xonly = node.publicKey.subarray(1);
    if (!equal(d.xonly, xonly)) return t("the key at {path} is not the one the PSBT names", { path: where });
    if (f.tapInternalKey && !equal(f.tapInternalKey, xonly)) {
      return t("the coin's internal key is not the key at {path}", { path: where });
    }
    if (!equal(p2trOutputKey(xonly), coin.program)) {
      return t("the coin's taproot output key is not BIP-86's for the key at {path}", { path: where });
    }
    return null;
  }
  if (d.pubkey.length !== 33 || !equal(d.pubkey, node.publicKey)) {
    return t("the key at {path} is not the one the PSBT names", { path: where });
  }
  const h = hash160(node.publicKey);
  if (!equal(coin.hash, h)) return t("the coin's script doesn't pay to the key at {path}", { path: where });
  return null;
}

// A signature the PSBT already holds for this coin (from a merged copy; a
// multisig coin's are all it needs): "none", "good", or "bad" (doesn't verify, or isn't SIGHASH_ALL).
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
  if (ct.multisig) {
    const h = heldMultisig(psbt, i, ct, coin);
    return h.good.length >= ct.multisig.m ? "good" : h.bad ? "bad" : "none";
  }
  const held = f.partialSigs.filter((s) => keyFits(s.pubkey, ct) && equal(hash160(s.pubkey), ct.hash));
  if (!held.length) return "none";
  return held.some((s) => ecdsaGood(psbt, i, ct, coin, s.pubkey, s.signature)) ? "good" : "bad";
}

// The signatures a multisig input holds, of the script's own keys: the keys
// of the good ones, and how many are bad.
function heldMultisig(psbt, i, ct, coin) {
  const good = [];
  let bad = 0;
  for (const s of psbt.inputs[i].fields.partialSigs) {
    if (!ct.multisig.pubkeys.some((k) => equal(k, s.pubkey))) continue;
    if (ecdsaGood(psbt, i, ct, coin, s.pubkey, s.signature)) good.push(s.pubkey);
    else bad++;
  }
  return { good, bad };
}

// Only P2PKH can use an uncompressed key.
const keyFits = (pubkey, ct) => pubkey.length === 33 || (pubkey.length === 65 && ct.type === "p2pkh");

// Each verification is done once per PSBT: plan() asks several times, and
// planKeys() once per key, and a hostile PSBT can hold many signatures. (A
// parsed PSBT is not changed: signing and merging make new ones.)
const verified = new WeakMap();

function ecdsaGood(psbt, i, ct, coin, pubkey, signature) {
  if (signature.length < 9 || signature[signature.length - 1] !== SIGHASH.ALL) return false;
  let seen = verified.get(psbt);
  if (!seen) verified.set(psbt, (seen = new Map()));
  const id = `${i}/${toHex(pubkey)}/${toHex(signature)}`;
  let good = seen.get(id);
  if (good === undefined) {
    const tx = psbt.tx;
    const hash = ct.type === "p2pkh" ? legacySighash(tx, i, coin.script, SIGHASH.ALL)
      : segwitV0Sighash(tx, i, ct.multisig ? ct.witnessScript : p2wpkhScriptCode(ct.hash), coin.value, SIGHASH.ALL);
    good = cr().ecdsaVerify(signature.subarray(0, signature.length - 1), hash, pubkey);
    seen.set(id, good);
  }
  return good;
}

// Is this signature of input i, by this key, one the signer would accept?
// null: it can't tell (the input is not a coin of that key, or its coin is
// not described).
export function partialSigGood(psbt, i, pubkey, signature) {
  const coin = spentOutput(psbt, i);
  if (coin.error) return null;
  const ct = coinType(coin.script, psbt.inputs[i].fields);
  if (ct.error || ct.type === "p2tr") return null;
  if (ct.multisig ? !ct.multisig.pubkeys.some((k) => equal(k, pubkey)) : !keyFits(pubkey, ct) || !equal(hash160(pubkey), ct.hash)) return null;
  return ecdsaGood(psbt, i, ct, coin, pubkey, signature);
}

// What each input holds when no key is loaded: { held: "final", or as
// heldSignature; multisig }. (A merged PSBT can be complete with no key in
// this device.)
function heldByNobody(psbt) {
  const prevouts = psbt.inputs.map((_, i) => spentOutput(psbt, i));
  return psbt.inputs.map((m, i) => {
    const f = m.fields;
    if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) return { held: "final", multisig: null };
    if (prevouts[i].error) return { held: "none", multisig: null };
    const ct = coinType(prevouts[i].script, f);
    if (ct.error) return { held: "none", multisig: null };
    return { held: heldSignature(psbt, i, ct, prevouts[i], prevouts), multisig: ct.multisig ? multisigState(psbt, i, ct, prevouts[i]) : null };
  });
}

// BIP-48's paths have a step more, for the script type.
function pathOddities(fullPath, type, network, maxIndex) {
  const odd = [];
  const bip48 = fullPath.length === 6 && fullPath[0] === 48 + HARDENED && (type === "p2wsh" || type === "p2sh-p2wsh");
  const path = bip48 ? [...fullPath.slice(0, 3), ...fullPath.slice(4)] : fullPath;
  const p = formatPath(fullPath);
  if (path.length !== 5) {
    odd.push(t("{path} is not the usual m/purpose'/coin'/account'/change/index", { path: p }));
    if (path.length >= 1 && path[path.length - 1] > maxIndex && path[path.length - 1] < HARDENED) {
      odd.push(t("index {index} is unusually high", { index: String(path[path.length - 1]) }));
    }
    return odd;
  }
  const [purpose, coin, account, branch, index] = path;
  if (purpose < HARDENED || coin < HARDENED || account < HARDENED) {
    odd.push(t("{path}: the first three steps are usually hardened", { path: p }));
  }
  const want = PURPOSE[type];
  if (want !== undefined && purpose !== want + HARDENED) {
    odd.push(t("{path}: purpose {purpose} is not the usual {usual} for {type}", { path: p,
      purpose: purpose >= HARDENED ? purpose - HARDENED + "'" : String(purpose), usual: want + "'", type: typeName(type) }));
  }
  if (network && (coin === HARDENED || coin === HARDENED + 1) && (coin === HARDENED) !== (network === "mainnet")) {
    odd.push(coin === HARDENED
      ? t("{path}: coin type 0' is for mainnet, not {network}", { path: p, network })
      : t("{path}: coin type 1' is for test networks, not {network}", { path: p, network }));
  }
  if (branch !== 0 && branch !== 1) {
    odd.push(t("{path}: branch {branch} is neither receive (0) nor change (1)",
      { path: p, branch: branch >= HARDENED ? branch - HARDENED + "'" : String(branch) }));
  }
  if (index >= HARDENED) odd.push(t("{path}: a hardened address index", { path: p }));
  else if (index > maxIndex) odd.push(t("{path}: index {index} is unusually high", { path: p, index: String(index) }));
  return odd;
}

const accountOf = (path) => formatPath(path.length >= 3 ? path.slice(0, path.length - 2) : path.slice(0, 1));

// Where a key sits: its account, chain and index. The account is named by
// its key's fingerprint, not its path: a master key and that account's own
// xprv see the same account, and only one of them knows the path. (An
// xprv one step below the account gets it from its parent fingerprint; one
// deeper can't tell, and goes by the path.)
function homeOf(loc, keys) {
  // a key on the chain level is its chain: its own child number
  const p = loc.full || (loc.rel.length === 1 && keys.depth > 0 ? [keys.root.childNumber, ...loc.rel] : loc.rel);
  if (p.length < 2) return { account: null, chain: null, index: null };
  const rel = loc.rel;
  const account = rel.length >= 2 ? toHex(fingerprint(keys.node(rel.slice(0, rel.length - 2))))
    : rel.length === 1 ? toHex(keys.root.parentFingerprint) : formatPath(p.slice(0, p.length - 2));
  return { account, chain: p[p.length - 2], index: p[p.length - 1] };
}

function planInput(psbt, i, keys, prevouts) {
  const f = psbt.inputs[i].fields;
  const r = { index: i, sign: false, final: false, signed: false, badSignature: false, mine: false, type: null, path: null,
    pubkey: null, sighash: null, reason: null, oddities: [] };
  let held = "none";
  const no = (reason) => {
    r.signed = held === "good";
    r.reason = r.signed ? t("it is signed already") : reason;
    return r;
  };
  if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) {
    r.final = true;
    return no(t("it is already signed (final)"));
  }
  const coin = prevouts[i];
  if (coin.error) return no(coin.error);
  const ct = coinType(coin.script, f);
  if (ct.error) return no(ct.error);
  r.type = ct.type;
  const taproot = ct.type === "p2tr";

  if (ct.type === "p2pkh" && !coin.full) {
    return no(t("a P2PKH coin is signed only with its previous transaction in the PSBT, which Electrum's QR codes " +
      "leave out: it needs a wallet that sends it whole (BBQr, for the size)"));
  }
  r.sighash = f.sighashType ?? (taproot ? SIGHASH.DEFAULT : SIGHASH.ALL);
  if (!(r.sighash === SIGHASH.ALL || (taproot && r.sighash === SIGHASH.DEFAULT))) {
    return no(taproot
      ? t("it asks for sighash {sighash}: only ALL (or DEFAULT) is signed", { sighash: sighashName(r.sighash) })
      : t("it asks for sighash {sighash}: only ALL is signed", { sighash: sighashName(r.sighash) }));
  }
  if (taproot) {
    if (f.tapMerkleRoot) return no(t("its taproot coin has a script tree: only BIP-86 key-path spends are signed"));
    const missing = prevouts.findIndex((p) => p.error);
    if (missing >= 0) {
      return no(t("input {n}'s coin is not known, and a taproot signature covers every input's amount", { n: missing + 1 }));
    }
  }

  held = heldSignature(psbt, i, ct, coin, prevouts);
  r.badSignature = held === "bad";
  if (ct.multisig) return planMultisig(psbt, i, keys, ct, coin, r, no);
  const ours = () => {
    r.mine = true;
    r.sign = held !== "good";
    return r.sign ? r : no(null);
  };

  if (keys.single) {
    const node = keys.root;
    if (node.publicKey.length !== 33) {
      if (taproot || !equal(hash160(node.publicKey), ct.hash)) return no(t("this key doesn't control it"));
      if (!keyFits(node.publicKey, ct)) return no(t("an uncompressed key spends only legacy (P2PKH) coins"));
    }
    const xonly = node.publicKey.subarray(1);
    if (!(taproot ? equal(p2trOutputKey(xonly), ct.program) : equal(hash160(node.publicKey), ct.hash))) {
      return no(t("this key doesn't control it"));
    }
    r.keyPath = [];
    r.fullPath = null;
    r.home = { single: toHex(keys.fp) };
    r.pubkey = toHex(taproot ? xonly : node.publicKey);
    return ours();
  }

  const derivations = taproot ? f.tapBip32.filter((d) => d.leafHashes.length === 0) : f.bip32;
  if (derivations.length === 0) return no(t("the PSBT names no key (BIP-32 derivation) for it"));
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
      firstProblem = firstProblem || t("the key at {path} can't be derived ({why})", { path: where, why: e.message });
      continue;
    }
    const problem = keyControls(node, d, ct, f, where);
    if (problem) {
      if (loc.guess) continue;
      anyOurs = true;
      firstProblem = firstProblem || problem;
      continue;
    }
    r.path = where;
    r.keyPath = loc.rel;
    r.fullPath = loc.full;
    r.home = homeOf(loc, keys);
    r.pubkey = toHex(taproot ? node.publicKey.subarray(1) : node.publicKey);
    return ours();
  }
  if (!anyOurs) {
    const fps = [...new Set(derivations.map((d) => toHex(d.fingerprint)))].join(", ");
    return no(derivations.length > 1
      ? t("its keys are from another wallet (fingerprint {theirs}; this wallet is {ours})", { theirs: fps, ours: toHex(keys.fp) })
      : t("its key is from another wallet (fingerprint {theirs}; this wallet is {ours})", { theirs: fps, ours: toHex(keys.fp) }));
  }
  r.mine = true;
  return no(firstProblem);
}

const multisigState = (psbt, i, ct, coin) => {
  const { m, n } = ct.multisig;
  return { m, n, have: Math.min(heldMultisig(psbt, i, ct, coin).good.length, m), will: 0 };
};

// Which of the script's keys are this key's, wherever the PSBT says they are.
function ownKeys(f, keys, ct) {
  const own = [];
  let problem = null;
  const inScript = (pubkey) => ct.multisig.pubkeys.some((k) => equal(k, pubkey));
  if (keys.single) {
    if (inScript(keys.root.publicKey)) own.push({ keyPath: [], path: null, fullPath: null, home: { single: toHex(keys.fp) }, pubkey: keys.root.publicKey });
    return { own, problem };
  }
  for (const d of f.bip32) {
    if (!inScript(d.pubkey)) continue;
    const loc = keys.resolve(d.fingerprint, d.path);
    if (!loc) continue;
    const where = pathText(loc);
    let node;
    try {
      node = keys.node(loc.rel);
    } catch (e) {
      if (!loc.guess) problem = problem || t("the key at {path} can't be derived ({why})", { path: where, why: e.message });
      continue;
    }
    if (!equal(d.pubkey, node.publicKey)) {
      if (!loc.guess) problem = problem || t("the key at {path} is not the one the PSBT names", { path: where });
      continue;
    }
    own.push({ keyPath: loc.rel, path: where, fullPath: loc.full, home: homeOf(loc, keys), pubkey: node.publicKey });
  }
  return { own, problem };
}

function planMultisig(psbt, i, keys, ct, coin, r, no) {
  const f = psbt.inputs[i].fields;
  const state = r.multisig = multisigState(psbt, i, ct, coin);
  const { own, problem } = ownKeys(f, keys, ct);
  if (own.length) {
    r.mine = true;
    r.path = own[0].path;
    r.keyPath = own[0].keyPath;
    r.fullPath = own[0].fullPath;
    r.home = own[0].home;
    r.pubkey = toHex(own[0].pubkey);
  }
  if (state.have >= state.m) return no(null);
  const good = heldMultisig(psbt, i, ct, coin).good;
  const left = own.filter((k) => !good.some((g) => equal(g, k.pubkey)));
  if (left.length) {
    r.sign = true;
    r.slots = left.slice(0, state.m - state.have);
    r.scriptCode = ct.witnessScript;
    state.will = r.slots.length;
    r.signers = r.slots.map((k) => toHex(k.pubkey));
    return no(null);
  }
  if (own.length) {
    return no(t("it has {have} of the {need} signatures it needs, and this key has signed", { have: state.have, need: state.m }));
  }
  if (problem) {
    r.mine = true;
    return no(problem);
  }
  if (!f.bip32.length) return no(t("the PSBT names no key (BIP-32 derivation) for it"));
  const fps = [...new Set(f.bip32.map((d) => toHex(d.fingerprint)))].join(", ");
  return no(t("its keys are from another wallet (fingerprints {theirs}; this wallet is {ours})",
    { theirs: fps, ours: toHex(keys.fp) }));
}

// The scripts a key can pay to: what kind this one is, or null.
function paysTo(script, publicKey) {
  const h = hash160(publicKey);
  if (publicKey.length !== 33) return equal(script, p2pkhScript(h)) ? "p2pkh" : null;
  const w = p2wpkhScript(h);
  if (equal(script, w)) return "p2wpkh";
  if (equal(script, p2shScript(hash160(w)))) return "p2sh-p2wpkh";
  if (equal(script, p2pkhScript(h))) return "p2pkh";
  return null;
}

function planOutput(psbt, i, keys) {
  const f = psbt.outputs[i].fields, script = psbt.tx.outputs[i].script;
  const o = { index: i, ours: false, type: null, path: null, role: null, problem: null, unproved: null, noXpubs: false, oddities: [] };
  if (keys.single) {
    const type = paysTo(script, keys.root.publicKey) || (keys.root.publicKey.length === 33 &&
      equal(script, concat([Uint8Array.of(0x51, 32), p2trOutputKey(keys.root.publicKey.subarray(1))])) ? "p2tr" : null);
    if (type) {
      o.ours = true;
      o.type = type;
      o.fullPath = null;
      o.home = { single: toHex(keys.fp) };
    } else {
      o.type = classify(script).type;
    }
    return o;
  }
  const multisig = multisigCoin(script, f);
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
      claim(t("it says it is yours ({path}), but that key can't be derived", { path: where }));
      continue;
    }
    let type = null;
    if (taproot) {
      const xonly = node.publicKey.subarray(1);
      if (!equal(d.xonly, xonly)) {
        claim(t("it says it is yours ({path}), but the key it names is not this wallet's key at that path", { path: where }));
        continue;
      }
      if (equal(script, concat([Uint8Array.of(0x51, 32), p2trOutputKey(xonly)]))) type = "p2tr";
    } else {
      if (d.pubkey.length !== 33 || !equal(d.pubkey, node.publicKey)) {
        claim(t("it says it is yours ({path}), but the key it names is not this wallet's key at that path", { path: where }));
        continue;
      }
      if (!multisig) type = paysTo(script, node.publicKey);
      else if (multisig.error) type = "p2wsh"; // proveOutput says what is wrong
      else type = multisig.multisig.pubkeys.some((k) => equal(k, node.publicKey)) ? multisig.type : null;
    }
    if (!type) {
      claim(t("it says it is yours ({path}), but it doesn't pay to that key", { path: where }));
      continue;
    }
    const proof = multisig ? proveOutput(cosignerWallet(psbt, spentOutput), script, f) : {};
    if (proof.reason && (proof.open || loc.guess)) {
      o.unproved = proof.reason;
      o.noXpubs = proof.noXpubs === true;
      o.problem = null;
      break;
    }
    if (proof.reason) {
      o.problem = proof.reason;
      o.notWallet = true;
      break;
    }
    o.ours = true;
    o.problem = null;
    o.type = type;
    o.path = where;
    o.fullPath = loc.full;
    o.home = homeOf(loc, keys);
    if (proof.uneven) o.home.uneven = proof.uneven;
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
    const reason = t("the inputs' locktime requirements contradict each other (PSBT version 2)");
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
      r.oddities.push(signing.length > 1
        ? t("account {account} is not the one most inputs use ({usual})", { account: a, usual: main })
        : t("account {account} is not the one the input uses ({usual})", { account: a, usual: main }));
    }
  }
  for (const o of outputs) {
    if (o.ours && types.size && !types.has(o.type)) {
      o.oddities.push(t("it pays to a {outputType} script of your key, but the inputs are {inputTypes}",
        { outputType: typeName(o.type), inputTypes: [...types].map(typeName).join(", ") }));
    }
  }
  return { inputs, outputs, prevouts };
}

function publicPlan(p, keys) {
  const strip = ({ fullPath, keyPath, scriptCode, ...rest }) => rest;
  const inputs = p.inputs.map(({ slots, ...rest }) => strip(rest)), outputs = p.outputs.map(strip);
  const signable = inputs.filter((r) => r.sign).length;
  return { fingerprint: toHex(keys.fp), inputs, outputs, signable, complete: inputs.every(done) };
}

// Will this input be complete, as far as these keys go? (Each of a multisig's
// keys adds its signature; it may need more.)
const done = (r) => r.final || r.signed || (r.sign && (!r.multisig || r.multisig.have + r.multisig.will >= r.multisig.m));

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
  const rank = (r) => (r.sign ? 4 : r.signed && r.home ? 3 : r.final || r.signed ? 2 : r.mine ? 1 : 0);
  const inputs = psbt.inputs.map((_, i) => {
    let best = null;
    for (const p of plans) if (!best || rank(p.inputs[i]) > rank(best)) best = p.inputs[i];
    if (best) {
      if (!best.multisig) return best;
      const signers = new Set(plans.flatMap((p) => p.inputs[i].signers || []));
      return { ...best, multisig: { ...best.multisig, will: Math.min(signers.size, best.multisig.m - best.multisig.have) } };
    }
    return { index: i, sign: false, final: held[i].held === "final", signed: held[i].held === "good", badSignature: held[i].held === "bad",
      mine: false, type: null, path: null, pubkey: null, sighash: null, multisig: held[i].multisig,
      reason: held[i].held === "final" || held[i].held === "good" ? t("it is signed already") : t("no key is loaded"), oddities: [] };
  });
  const outputs = psbt.outputs.map((m, i) => {
    let best = null;
    for (const p of plans) {
      const o = p.outputs[i];
      if (!best || (o.ours && !best.ours) || (!best.ours && (o.unproved || o.problem) && !best.unproved && !best.problem)) best = o;
    }
    return { ...(best || { index: i, ours: false, type: null, path: null, role: null, problem: null, unproved: null, noXpubs: false, oddities: [] }),
      claimed: m.fields.bip32.length + m.fields.tapBip32.length > 0 };
  });
  const homes = inputs.filter((r) => r.home).map((r) => r.home);
  for (const o of outputs) {
    o.stray = o.ours ? strayReason(o.home, homes) : null;
    o.far = o.ours && !o.stray ? farIndex(o.home, homes) : null;
  }
  return { inputs, outputs, signable: inputs.filter((r) => r.sign).length,
    complete: inputs.every(done),
    keys: plans.map((p) => ({ fingerprint: p.fingerprint, signs: p.signable })) };
}

// The highest index of the inputs in home's account, over both chains.
function topIndex(home, inputs) {
  return Math.max(0, ...inputs.filter((h) => h.account === home.account).map((h) => (h.index < HARDENED ? h.index : 0)));
}

// The index of an output at home that wallets don't scan as far as, or null.
function farIndex(home, inputs) {
  return home.single || home.index <= topIndex(home, inputs) + CHANGE_NEAR ? null : home.index;
}

// Why an output of ours may never be seen by the wallet (the rule at the top
// of this file), or null.
function strayReason(home, inputs) {
  if (home.uneven) return home.uneven;
  if (home.single) {
    return !inputs.length || inputs.some((h) => h.single === home.single) ? null : t("that key spends nothing here");
  }
  if (home.account === null) return t("its path has no account, chain and index");
  if (home.chain !== 0 && home.chain !== 1) {
    return home.chain >= HARDENED ? t("a hardened chain is neither change (1) nor receive (0)")
      : t("chain {chain} is neither change (1) nor receive (0)", { chain: String(home.chain) });
  }
  if (home.index >= HARDENED) return t("its index is hardened");
  if (inputs.length && !inputs.some((h) => h.account === home.account)) return t("it is another account than the inputs'");
  const limit = topIndex(home, inputs) + CHANGE_GAP;
  if (home.index > limit) {
    return t("its index is over {limit}, {gap} past the inputs'", { limit: String(limit), gap: String(CHANGE_GAP) });
  }
  return null;
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
      const coin = p.prevouts[r.index];
      if (r.slots) {
        const hash = segwitV0Sighash(tx, r.index, r.scriptCode, coin.value, r.sighash);
        for (const slot of r.slots) {
          const node = keys.node(slot.keyPath);
          const der = cr().ecdsaSign(hash, node.privateKey);
          if (!cr().ecdsaVerify(der, hash, node.publicKey)) throw new SignError(`input ${r.index + 1}: the signature made doesn't verify`);
          setEntry(out.inputs[r.index], IN.PARTIAL_SIG, node.publicKey, concat([der, Uint8Array.of(r.sighash)]));
          signed.push({ input: r.index, path: slot.path, pubkey: toHex(slot.pubkey) });
        }
        continue;
      }
      const node = keys.node(r.keyPath);
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
  if (data.length > 75) throw new SignError("push too long"); // signatures, keys and P2SH-P2W*'s redeemScript are short
  return concat([Uint8Array.of(data.length), data]);
};

// The network transaction, when every input is signed (or final). Throws
// SignError naming the first input that isn't. Only signatures that verify
// are taken (signPsbt verified its own; a merged copy's are checked here, as
// plan() counts them).
export function finalize(psbt) {
  const tx = { ...psbt.tx, inputs: [], segwit: false };
  let prevouts = null; // every input's coin, for a taproot signature
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
      prevouts = prevouts || psbt.inputs.map((_, k) => spentOutput(psbt, k));
      if (heldSignature(psbt, i, ct, coin, prevouts) !== "good") throw new SignError(`input ${n}: its signature doesn't verify`);
      tx.inputs.push({ ...txin, scriptSig: new Uint8Array(0), witness: [f.tapKeySig] });
      continue;
    }
    if (ct.multisig) {
      const { m, pubkeys } = ct.multisig;
      const sigs = [];
      for (const k of pubkeys) {
        const s = f.partialSigs.find((c) => equal(c.pubkey, k));
        if (s && sigs.length < m && ecdsaGood(psbt, i, ct, coin, s.pubkey, s.signature)) sigs.push(s.signature);
      }
      if (sigs.length < m) throw new SignError(`input ${n} has ${sigs.length} of the ${m} good signatures it needs`);
      tx.inputs.push({ ...txin, scriptSig: ct.redeemScript ? push(ct.redeemScript) : new Uint8Array(0),
        witness: [new Uint8Array(0), ...sigs, ct.witnessScript] });
      continue;
    }
    const sig = f.partialSigs.find((s) => keyFits(s.pubkey, ct) && equal(hash160(s.pubkey), ct.hash));
    if (!sig) throw new SignError(`input ${n} is not signed`);
    if (!ecdsaGood(psbt, i, ct, coin, sig.pubkey, sig.signature)) throw new SignError(`input ${n}: its signature doesn't verify`);
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
