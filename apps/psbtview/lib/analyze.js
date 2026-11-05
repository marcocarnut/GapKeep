// What a PSBT does, for a person about to sign it: what it spends, where
// the money goes, which outputs come back to the same wallet (change), the
// fee, and what to be careful about.
//
//   analyze(psbt, { network })   // psbt from parsePsbt(); network: a key of
//                                // NETWORKS, or omitted to guess it
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { toHex, toHexReversed, equal, compactSizeLength } from "./bytes.js";
import { sha256, hash160, haveRipemd160 } from "./hashes.js";
import { txid as txidOf, inputBaseSize, outputSize, witnessSize } from "./tx.js";
import { classify, scriptToAddress, parseMultisig, parseScript, NETWORKS, TYPE_NAMES } from "./script.js";

export const HARDENED = 0x80000000;
export const DUST = 546;            // below this, most nodes won't relay a (P2PKH) output
const HIGH_FEE_RATE = 500;           // sat/vB
const HIGH_FEE_SHARE = 0.1;          // of what is spent

export function formatPath(path) {
  return "m" + path.map((p) => "/" + (p >= HARDENED ? (p - HARDENED) + "'" : p)).join("");
}

// 123456789 -> "1.23456789"; negative too. Whole satoshis (Numbers).
export function formatBtc(sats) {
  const neg = sats < 0, a = Math.abs(sats);
  const whole = Math.floor(a / 1e8), frac = String(a % 1e8).padStart(8, "0");
  return (neg ? "-" : "") + whole + "." + frac;
}

export const SIGHASH_NAMES = { 0: "DEFAULT", 1: "ALL", 2: "NONE", 3: "SINGLE", 0x81: "ALL|ANYONECANPAY",
  0x82: "NONE|ANYONECANPAY", 0x83: "SINGLE|ANYONECANPAY" };
export const sighashName = (t) => SIGHASH_NAMES[t] || "0x" + t.toString(16);

// The network, from what the PSBT says about keys: BIP-44-style paths
// (m/purpose'/coin'/...: coin 0' is mainnet, 1' the test networks) and
// global xpubs' version bytes. -> { network, why }
export function guessNetwork(psbt) {
  let main = 0, test = 0;
  const paths = [];
  for (const m of [...psbt.inputs, ...psbt.outputs]) {
    for (const d of [...m.fields.bip32, ...m.fields.tapBip32]) paths.push(d.path);
  }
  for (const x of psbt.global.fields.xpubs) {
    const v = toHex(x.xpub.subarray(0, 4));
    if (["0488b21e", "049d7cb2", "04b24746", "0295b43f", "02aa7ed3"].includes(v)) main++;
    else if (["043587cf", "044a5262", "045f1cf6", "024289ef", "02575483"].includes(v)) test++;
  }
  for (const p of paths) {
    if (p.length >= 2 && [44, 45, 48, 49, 84, 86].includes(p[0] - HARDENED)) {
      if (p[1] === HARDENED) main++;
      else if (p[1] === HARDENED + 1) test++;
    }
  }
  if (main && !test) return { network: "mainnet", why: "key paths and xpubs are for mainnet" };
  if (test && !main) return { network: "testnet", why: "key paths and xpubs are for a test network" };
  if (main && test) return { network: "mainnet", why: "key paths disagree: some mainnet, some test" };
  return { network: "mainnet", why: "nothing in the PSBT says: mainnet assumed" };
}

const fpHex = (d) => toHex(d.fingerprint);

// Witness and scriptSig sizes an input will have once signed (an estimate:
// 72-byte ECDSA signatures, 64-byte Schnorr ones), or exact when final.
function estimateInput(a, f) {
  if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) {
    const sigLen = f.finalScriptSig ? f.finalScriptSig.length : 0;
    const wit = f.finalScriptWitness ? witnessSize(f.finalScriptWitness) : 0;
    return { weight: inputBaseSize(sigLen) * 4 + wit, witness: !!f.finalScriptWitness, exact: true };
  }
  const SIG = 73; // push + 72
  const multisigWitness = (script) => {
    const ms = parseMultisig(script);
    if (!ms) return null;
    return 1 + 1 + ms.m * SIG + compactSizeLength(script.length) + script.length;
  };
  const pushLen = (n) => (n < 76 ? 1 : n < 256 ? 2 : 3) + n;
  const pk = f.bip32.length && f.bip32[0].pubkey.length === 65 ? 66 : 34;
  switch (a.type) {
    case "p2pkh": return { weight: inputBaseSize(SIG + pk) * 4, witness: false, exact: false };
    case "p2wpkh": return { weight: inputBaseSize(0) * 4 + 1 + SIG + 34, witness: true, exact: false };
    case "p2sh-p2wpkh": return { weight: inputBaseSize(23) * 4 + 1 + SIG + 34, witness: true, exact: false };
    case "p2tr": {
      const sig = 1 + 64 + (f.sighashType ? 1 : 0);
      return { weight: inputBaseSize(0) * 4 + 1 + sig, witness: true, exact: false };
    }
    case "p2wsh": case "p2sh-p2wsh": {
      const w = f.witnessScript ? multisigWitness(f.witnessScript) : null;
      if (w === null) return null;
      return { weight: inputBaseSize(a.type === "p2wsh" ? 0 : 35) * 4 + w, witness: true, exact: false };
    }
    case "p2sh": {
      const ms = f.redeemScript ? parseMultisig(f.redeemScript) : null;
      if (!ms) return null;
      return { weight: inputBaseSize(1 + ms.m * SIG + pushLen(f.redeemScript.length)) * 4, witness: false, exact: false };
    }
    default: return null;
  }
}

// The kind of an input or output, seeing through P2SH: "p2sh-p2wpkh" etc.
function effectiveType(script, redeemScript) {
  const c = classify(script);
  if (c.type === "p2sh" && redeemScript) {
    const inner = classify(redeemScript).type;
    if (inner === "p2wpkh" || inner === "p2wsh") return "p2sh-" + inner;
  }
  return c.type;
}

export const typeName = (t) => (t.startsWith("p2sh-") ? "P2SH-" + TYPE_NAMES[t.slice(5)] : TYPE_NAMES[t] || t);

// Checks that a P2SH output's or input's redeemScript and witnessScript
// are the ones its script commits to. -> list of problems ([] if fine);
// sets .unchecked when RIPEMD-160 was needed but missing.
function checkScripts(script, redeemScript, witnessScript, res) {
  const problems = [];
  const c = classify(script);
  let inner = c;
  if (c.type === "p2sh" && redeemScript) {
    const h = hash160(redeemScript);
    if (h === null) res.unchecked = true;
    else if (!equal(h, c.hash)) problems.push("its redeemScript doesn't match the script");
    inner = classify(redeemScript);
  }
  if (inner.type === "p2wsh" && witnessScript && !equal(sha256(witnessScript), inner.program)) {
    problems.push("its witnessScript doesn't match the script");
  }
  return problems;
}

// Does a key from a derivation pay to this script? true / false / null
// (can't tell: RIPEMD-160 missing, taproot's tweak, an unknown script).
function keyMatchesScript(pubkey, script, redeemScript, witnessScript) {
  const c = classify(script);
  const hasKey = (ms) => ms.pubkeys.some((k) => equal(k, pubkey));
  let inner = c;
  if (c.type === "p2sh") {
    if (!redeemScript) return null;
    const h = hash160(redeemScript);
    if (h === null) return null;
    if (!equal(h, c.hash)) return false;
    inner = classify(redeemScript);
    if (inner.type !== "p2wpkh" && inner.type !== "p2wsh") {
      const ms = parseMultisig(redeemScript);
      return ms ? hasKey(ms) : null;
    }
  }
  if (inner.type === "p2wsh") {
    if (!witnessScript) return null;
    if (!equal(sha256(witnessScript), inner.program)) return false;
    const ms = parseMultisig(witnessScript);
    return ms ? hasKey(ms) : null;
  }
  if (inner.type === "p2wpkh" || inner.type === "p2pkh") {
    const h = hash160(pubkey);
    return h === null ? null : equal(h, inner.hash);
  }
  return null;
}

function analyzeInput(psbt, i, network, warn) {
  const txin = psbt.tx.inputs[i];
  const f = psbt.inputs[i].fields;
  const n = i + 1; // people count from 1
  const a = {
    index: i, prevTxid: toHexReversed(txin.txid), vout: txin.vout, sequence: txin.sequence,
    amount: null, script: null, type: "unknown", address: null, utxo: "none",
    derivations: [], fingerprints: [], signatures: 0, signaturesNeeded: null, final: false,
    sighash: f.sighashType ?? null, problems: [], unchecked: false,
  };
  // the output it spends: from the previous transaction, or the output alone
  if (f.nonWitnessUtxo) {
    const prev = f.nonWitnessUtxo;
    if (toHexReversed(txin.txid) !== txidOf(prev)) {
      a.problems.push("its previous transaction is not the one it spends");
      warn("danger", `Input ${n}: the previous transaction given is not the one it spends (wrong txid).`);
    } else if (txin.vout >= prev.outputs.length) {
      a.problems.push("its previous transaction has no such output");
      warn("danger", `Input ${n}: the previous transaction has no output ${txin.vout}.`);
    } else {
      a.amount = prev.outputs[txin.vout].value;
      a.script = prev.outputs[txin.vout].script;
      a.utxo = "full";
    }
  }
  if (f.witnessUtxo) {
    if (a.utxo === "full") {
      if (f.witnessUtxo.value !== a.amount || !equal(f.witnessUtxo.script, a.script)) {
        a.problems.push("its two descriptions of the coin disagree");
        warn("danger", `Input ${n}: the previous transaction and the witness UTXO disagree about the coin spent.`);
      }
      a.utxo = "both";
    } else if (!a.problems.length) {
      a.amount = f.witnessUtxo.value;
      a.script = f.witnessUtxo.script;
      a.utxo = "witness";
    }
  }
  if (typeof a.amount === "bigint") {
    a.problems.push("its amount is impossible");
    warn("danger", `Input ${n}: the amount is larger than all bitcoin there can be.`);
    a.amount = null;
  }
  if (a.script) {
    a.type = effectiveType(a.script, f.redeemScript);
    a.address = scriptToAddress(a.script, network);
    for (const p of checkScripts(a.script, f.redeemScript, f.witnessScript, a)) {
      a.problems.push(p);
      warn("danger", `Input ${n}: ${p}.`);
    }
  }
  const segwitV0 = a.type === "p2wpkh" || a.type === "p2wsh" || a.type === "p2sh-p2wpkh" || a.type === "p2sh-p2wsh";
  // how far the amount can be trusted: grouped over all inputs in analyze()
  if (a.utxo === "none" && !a.problems.length) a.caveat = "unknown";
  else if (a.utxo === "witness" && a.script) {
    if (segwitV0) a.caveat = "segwit-v0";
    else if (a.type !== "p2tr" && a.type !== "witness" && a.type !== "anchor") a.caveat = "legacy";
  }

  // keys: which wallet (fingerprint) and path
  for (const d of f.bip32) a.derivations.push({ key: toHex(d.pubkey), fingerprint: fpHex(d), path: formatPath(d.path), raw: d });
  for (const d of f.tapBip32) {
    a.derivations.push({ key: toHex(d.xonly), fingerprint: fpHex(d), path: formatPath(d.path), raw: d, taproot: true,
      leaves: d.leafHashes.length });
  }
  a.fingerprints = [...new Set(a.derivations.map((d) => d.fingerprint))].sort();
  if (a.script) {
    for (const d of f.bip32) {
      const m = keyMatchesScript(d.pubkey, a.script, f.redeemScript, f.witnessScript);
      if (m === null) a.unchecked = true;
      else if (!m) {
        a.problems.push(`its key ${formatPath(d.path)} is not in its script`);
        warn("warn", `Input ${n}: the key at ${formatPath(d.path)} is not one its script uses.`);
      }
    }
  }

  // signatures
  a.final = f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined;
  a.signatures = f.partialSigs.length + (f.tapKeySig ? 1 : 0) + f.tapScriptSigs.length;
  const ms = parseMultisig(f.witnessScript || f.redeemScript || new Uint8Array(0));
  a.signaturesNeeded = ms ? ms.m : ["p2pkh", "p2wpkh", "p2sh-p2wpkh", "p2tr"].includes(a.type) ? 1 : null;
  if (ms) a.multisig = { m: ms.m, n: ms.n };
  if (a.sighash !== null && !(a.sighash === 1 || (a.sighash === 0 && a.type === "p2tr"))) {
    warn("warn", `Input ${n}: signs with sighash ${sighashName(a.sighash)}, not ALL: parts of the transaction could ` +
      "be changed after signing.");
  }
  a.size = estimateInput(a, f);
  return a;
}

function analyzeOutput(psbt, i, network, inputFingerprints, warn) {
  const txout = psbt.tx.outputs[i];
  const f = psbt.outputs[i].fields;
  const n = i + 1;
  const c = classify(txout.script);
  const o = {
    index: i, amount: txout.value, script: txout.script, type: effectiveType(txout.script, f.redeemScript),
    address: scriptToAddress(txout.script, network), derivations: [], fingerprints: [], mine: false, role: "external",
    problems: [], unchecked: false,
  };
  if (typeof o.amount === "bigint" || o.amount > 2100000000000000) {
    warn("danger", `Output ${n}: the amount is larger than all bitcoin there can be.`);
  }
  for (const d of f.bip32) o.derivations.push({ key: toHex(d.pubkey), fingerprint: fpHex(d), path: formatPath(d.path), raw: d });
  for (const d of f.tapBip32) {
    o.derivations.push({ key: toHex(d.xonly), fingerprint: fpHex(d), path: formatPath(d.path), raw: d, taproot: true });
  }
  o.fingerprints = [...new Set(o.derivations.map((d) => d.fingerprint))].sort();

  // Ours: a key from the wallet that spends. Then the script must pay to
  // that key (as far as can be checked without EC maths).
  const ours = o.derivations.filter((d) => inputFingerprints.has(d.fingerprint));
  if (ours.length) {
    let bad = checkScripts(txout.script, f.redeemScript, f.witnessScript, o);
    for (const d of ours) {
      if (d.taproot) {
        o.unchecked = true;
        continue;
      }
      const m = keyMatchesScript(d.raw.pubkey, txout.script, f.redeemScript, f.witnessScript);
      if (m === null) o.unchecked = true;
      else if (!m) bad = bad.concat(`the key at ${d.path} doesn't pay to this script`);
    }
    if (bad.length) {
      o.problems = bad;
      warn("danger", `Output ${n} says it goes back to your wallet, but ${bad[0]}: treat it as someone else's.`);
    } else {
      o.mine = true;
      const p = ours[0].raw.path;
      const branch = p.length >= 2 ? p[p.length - 2] : -1;
      o.role = branch === 1 ? "change" : branch === 0 ? "receive" : "mine";
    }
  }
  if (c.type === "op_return") {
    if (o.amount > 0) warn("warn", `Output ${n}: ${formatBtc(Number(o.amount))} BTC sent to OP_RETURN is burned (no one can spend it).`);
  } else if (typeof o.amount === "number" && o.amount < DUST && c.type !== "anchor") {
    warn("warn", `Output ${n}: ${o.amount} sat is below the dust limit (${DUST} sat): the network may not relay it.`);
  }
  if (o.address === null && c.type !== "op_return") {
    warn("warn", `Output ${n} pays to a ${typeName(o.type)} script, which has no address.`);
  }
  return o;
}

// The txid the transaction will have once signed, when signing can't change
// it: every input final, or segwit (whose scriptSig is empty, or for P2SH
// the push of its redeemScript). null otherwise (as Electrum's txid()).
function finalTxid(psbt, inputs) {
  const tx = { ...psbt.tx, inputs: [] };
  for (let i = 0; i < inputs.length; i++) {
    const f = psbt.inputs[i].fields, a = inputs[i];
    let scriptSig;
    if (f.finalScriptSig !== undefined || f.finalScriptWitness !== undefined) scriptSig = f.finalScriptSig || new Uint8Array(0);
    else if (["p2wpkh", "p2wsh", "p2tr", "witness", "anchor"].includes(a.type)) scriptSig = new Uint8Array(0);
    else if (a.type === "p2sh-p2wpkh" || a.type === "p2sh-p2wsh") {
      scriptSig = new Uint8Array(1 + f.redeemScript.length);
      scriptSig[0] = f.redeemScript.length; // 22 or 34: a direct push
      scriptSig.set(f.redeemScript, 1);
    } else return null;
    tx.inputs.push({ ...psbt.tx.inputs[i], scriptSig, witness: [] });
  }
  return txidOf(tx);
}

export function analyze(psbt, { network = null, complete = false } = {}) {
  const warnings = [];
  const warn = (level, text) => warnings.push({ level, text });
  const guess = guessNetwork(psbt);
  network = network || guess.network;
  if (!NETWORKS[network]) throw new Error("unknown network " + network);

  const inputs = psbt.tx.inputs.map((_, i) => analyzeInput(psbt, i, network, warn));
  const inputFingerprints = new Set(inputs.flatMap((a) => a.fingerprints));
  const outputs = psbt.tx.outputs.map((_, i) => analyzeOutput(psbt, i, network, inputFingerprints, warn));

  // amounts the PSBT asserts but no signature commits to
  const which = (caveat) => inputs.filter((a) => a.caveat === caveat).map((a) => a.index + 1);
  const list = (ns) => (ns.length > 1 ? "Inputs " : "Input ") + (ns.length > 6 ? ns.slice(0, 6).join(", ") + "..." : ns.join(", "));
  const unknown = which("unknown"), legacy = which("legacy"), v0 = which("segwit-v0");
  if (unknown.length && !complete) {
    warn("warn", `${list(unknown)}: the coin spent is not described, so the amount (and the fee) are unknown.`);
  }
  if (legacy.length) {
    warn("warn", `${list(legacy)}: only the spent output is given, not its transaction (as Electrum's QR codes do). ` +
      "For a non-segwit coin the amount can't be checked, and signing needs that transaction.");
  }
  if (v0.length && inputs.length > 1) {
    warn("info", `${list(v0)}: amounts as the PSBT states them (as in Electrum's QR codes). A segwit v0 signature ` +
      "covers its own input's amount only: if asked to sign a changed version of this transaction again, refuse " +
      "(two such signatures can make a transaction with a much larger fee).");
  }

  // wallets: whose keys sign
  const sets = inputs.map((a) => a.fingerprints.join(","));
  const fingerprints = [...inputFingerprints].sort();
  if (complete) {
    warn("info", "This transaction is signed and complete. It doesn't say what the coins it spends were worth, " +
      "so the fee isn't known here.");
  } else if (inputs.length && inputs.every((a) => a.fingerprints.length === 0)) {
    warn("warn", "No input says which wallet (key fingerprint) it is from: change can't be recognised.");
  } else if (sets.some((s) => s === "")) {
    const which = inputs.filter((a) => !a.fingerprints.length).map((a) => a.index + 1);
    warn("warn", `Input${which.length > 1 ? "s" : ""} ${which.join(", ")} say${which.length > 1 ? "" : "s"} nothing about ` +
      "their keys: maybe not from your wallet.");
  }
  if (new Set(sets.filter((s) => s !== "")).size > 1) {
    warn("warn", `The inputs come from different sets of wallets (${fingerprints.join(", ")}).`);
  }

  // amounts
  const known = inputs.every((a) => typeof a.amount === "number");
  const totalIn = known ? inputs.reduce((s, a) => s + a.amount, 0) : null;
  const outOk = outputs.every((o) => typeof o.amount === "number");
  const totalOut = outOk ? outputs.reduce((s, o) => s + o.amount, 0) : null;
  const toSelf = outOk ? outputs.filter((o) => o.mine).reduce((s, o) => s + o.amount, 0) : null;
  const sent = outOk ? totalOut - toSelf : null;
  const fee = totalIn !== null && totalOut !== null ? totalIn - totalOut : null;

  // size: exact when signed and final, else an estimate
  let weight = 4 * (4 + compactSizeLength(inputs.length) + compactSizeLength(outputs.length) + 4);
  for (const o of psbt.tx.outputs) weight += 4 * outputSize(o);
  let sizeKnown = true, exact = true, witness = false;
  for (const a of inputs) {
    if (!a.size) {
      sizeKnown = false;
      continue;
    }
    weight += a.size.weight;
    exact = exact && a.size.exact;
    witness = witness || a.size.witness;
  }
  if (witness) weight += 2;
  const vsize = sizeKnown ? Math.ceil(weight / 4) : null;
  const feeRate = fee !== null && vsize ? fee / vsize : null;

  if (fee !== null && fee < 0) {
    warn("danger", `The outputs add up to more than the inputs (by ${formatBtc(-fee)} BTC): this transaction is invalid.`);
  } else if (fee !== null && ((feeRate !== null && feeRate > HIGH_FEE_RATE) || fee > HIGH_FEE_SHARE * totalIn)) {
    warn("danger", `The fee is high: ${formatBtc(fee)} BTC` +
      (feeRate !== null ? ` (${feeRate.toFixed(1)} sat/vB)` : "") + `, ${(100 * fee / totalIn).toFixed(1)}% of what is spent.`);
  }
  if (!sizeKnown) warn("info", "Some inputs are of a kind whose signed size isn't known: no fee rate.");
  if (!haveRipemd160() && (inputs.some((a) => a.unchecked) || outputs.some((o) => o.unchecked))) {
    warn("info", "Some keys couldn't be checked against their scripts (this system has no RIPEMD-160).");
  }
  if (psbt.tx.locktime === null) warn("danger", "The inputs' locktime requirements can't all be met.");

  const locktime = psbt.tx.locktime;
  return {
    network, networkGuess: guess, version: psbt.version, txVersion: psbt.tx.version, complete,
    txid: locktime === null ? null : finalTxid(psbt, inputs),
    locktime, locktimeKind: !locktime ? "none" : locktime < 500000000 ? "height" : "time",
    rbf: psbt.tx.inputs.some((i) => i.sequence < 0xfffffffe),
    inputs, outputs, fingerprints,
    totalIn, totalOut, toSelf, sent, fee, feeRate,
    vsize, weight: sizeKnown ? weight : null, sizeExact: sizeKnown && exact,
    signed: { inputs: inputs.filter((a) => a.final || (a.signaturesNeeded && a.signatures >= a.signaturesNeeded)).length,
      final: inputs.filter((a) => a.final).length },
    warnings,
  };
}

// A complete (signed) transaction, seen the same way, as a PSBT whose
// inputs are all final.
export function analyzeTx(tx, { network = null } = {}) {
  const inputFields = (i) => ({
    partialSigs: [], bip32: [], tapBip32: [], tapScriptSigs: [], tapLeafScripts: [], preimages: [], unknown: [],
    proprietary: [], finalScriptSig: i.scriptSig, finalScriptWitness: i.witness.length ? i.witness : undefined,
  });
  const a = analyze({
    version: null, tx,
    global: { entries: [], fields: { xpubs: [], unknown: [], proprietary: [] } },
    inputs: tx.inputs.map((i) => ({ entries: [], fields: inputFields(i) })),
    outputs: tx.outputs.map(() => ({ entries: [], fields: { bip32: [], tapBip32: [], unknown: [], proprietary: [] } })),
  }, { network, complete: true });
  // the kind of each coin, from how it is signed
  tx.inputs.forEach((i, k) => (a.inputs[k].type = spentType(i)));
  return a;
}

// What kind of output a signed input spends, from its scriptSig and witness
// (the usual single-key and P2SH-wrapped forms; else "unknown").
function spentType({ scriptSig: s, witness: w }) {
  if (s.length === 0 && w.length === 2 && w[1].length === 33) return "p2wpkh";
  if (s.length === 0 && w.length === 1 && (w[0].length === 64 || w[0].length === 65)) return "p2tr";
  if (s.length === 0 && w.length > 2) return "p2wsh";
  if (s.length === 23 && s[0] === 22 && s[1] === 0 && s[2] === 20) return "p2sh-p2wpkh";
  if (s.length === 35 && s[0] === 34 && s[1] === 0 && s[2] === 32) return "p2sh-p2wsh";
  if (w.length === 0 && s.length > 0) {
    const ops = parseScript(s);
    if (ops && ops.length === 2 && ops[1].data && (ops[1].data.length === 33 || ops[1].data.length === 65)) return "p2pkh";
  }
  return "unknown";
}
