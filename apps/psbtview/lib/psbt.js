// PSBT: Partially Signed Bitcoin Transactions, version 0 (BIP-174) and
// version 2 (BIP-370). Parse, check, serialize.
//
// Each map (global, each input, each output) keeps its key-value pairs as
// read, in order, so serialize(parse(x)) gives x back byte for byte,
// unknown and proprietary keys included. What is understood is decoded
// next to them, in `fields`:
//
//   psbt = { version: 0 | 2, tx, global: { entries, fields }, inputs: [...], outputs: [...] }
//   entry = { type, key (key data, after the type), value }
//
// `tx` is the unsigned transaction: PSBT_GLOBAL_UNSIGNED_TX in version 0,
// put together from the per-input and per-output fields in version 2
// (its locktime by BIP-370's rules; null when they can't give one).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { Reader, Writer, DecodeError, equal, toHex } from "./bytes.js";
import { parseTx } from "./tx.js";

export const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff); // "psbt" 0xff

export const GLOBAL = { UNSIGNED_TX: 0x00, XPUB: 0x01, TX_VERSION: 0x02, FALLBACK_LOCKTIME: 0x03, INPUT_COUNT: 0x04,
  OUTPUT_COUNT: 0x05, TX_MODIFIABLE: 0x06, VERSION: 0xfb, PROPRIETARY: 0xfc };
export const IN = { NON_WITNESS_UTXO: 0x00, WITNESS_UTXO: 0x01, PARTIAL_SIG: 0x02, SIGHASH_TYPE: 0x03,
  REDEEM_SCRIPT: 0x04, WITNESS_SCRIPT: 0x05, BIP32_DERIVATION: 0x06, FINAL_SCRIPTSIG: 0x07,
  FINAL_SCRIPTWITNESS: 0x08, POR_COMMITMENT: 0x09, RIPEMD160: 0x0a, SHA256: 0x0b, HASH160: 0x0c, HASH256: 0x0d,
  PREVIOUS_TXID: 0x0e, OUTPUT_INDEX: 0x0f, SEQUENCE: 0x10, REQUIRED_TIME_LOCKTIME: 0x11,
  REQUIRED_HEIGHT_LOCKTIME: 0x12, TAP_KEY_SIG: 0x13, TAP_SCRIPT_SIG: 0x14, TAP_LEAF_SCRIPT: 0x15,
  TAP_BIP32_DERIVATION: 0x16, TAP_INTERNAL_KEY: 0x17, TAP_MERKLE_ROOT: 0x18, MUSIG2_PARTICIPANT_PUBKEYS: 0x1a,
  MUSIG2_PUB_NONCE: 0x1b, MUSIG2_PARTIAL_SIG: 0x1c, PROPRIETARY: 0xfc };
export const OUT = { REDEEM_SCRIPT: 0x00, WITNESS_SCRIPT: 0x01, BIP32_DERIVATION: 0x02, AMOUNT: 0x03, SCRIPT: 0x04,
  TAP_INTERNAL_KEY: 0x05, TAP_TREE: 0x06, TAP_BIP32_DERIVATION: 0x07, MUSIG2_PARTICIPANT_PUBKEYS: 0x08,
  PROPRIETARY: 0xfc };

// Fields only version 2 has (and version 0 must not).
const V2_GLOBAL = [GLOBAL.TX_VERSION, GLOBAL.FALLBACK_LOCKTIME, GLOBAL.INPUT_COUNT, GLOBAL.OUTPUT_COUNT, GLOBAL.TX_MODIFIABLE];
const V2_IN = [IN.PREVIOUS_TXID, IN.OUTPUT_INDEX, IN.SEQUENCE, IN.REQUIRED_TIME_LOCKTIME, IN.REQUIRED_HEIGHT_LOCKTIME];
const V2_OUT = [OUT.AMOUNT, OUT.SCRIPT];

export class PsbtError extends DecodeError {
  constructor(message) {
    super(message);
    this.name = "PsbtError";
  }
}

export const isPsbt = (bytes) => bytes.length >= 5 && equal(bytes.subarray(0, 5), MAGIC);

// One map: entries until the 0x00 separator.
function readMap(r, where) {
  const entries = [];
  const seen = new Set();
  for (;;) {
    const keyLength = r.compactSize(`a key length in ${where}`);
    if (keyLength === 0) return entries;
    const fullKey = r.bytes(keyLength, `a key in ${where}`);
    const kr = new Reader(fullKey);
    const type = kr.compactSize(`a key type in ${where}`);
    const key = fullKey.subarray(kr.pos);
    const value = r.varBytes(`a value in ${where}`);
    const id = toHex(fullKey);
    if (seen.has(id)) throw new PsbtError(`${where}: the key ${id} appears twice`);
    seen.add(id);
    entries.push({ type, key, value, fullKey });
  }
}

function writeMap(w, entries) {
  for (const e of entries) {
    const fullKey = e.fullKey || keyBytes(e.type, e.key);
    w.varBytes(fullKey).varBytes(e.value);
  }
  w.u8(0);
}

function keyBytes(type, key) {
  const w = new Writer(1 + key.length);
  w.compactSize(type).bytes(key);
  return w.done();
}

// --- field decoders: each checks sizes as BIP-174 says ---------------------

function fail(where, what) {
  throw new PsbtError(`${where}: ${what}`);
}

function needKeyLength(e, where, name, ...lengths) {
  if (!lengths.includes(e.key.length)) {
    fail(where, lengths.length === 1 && lengths[0] === 0
      ? `the ${name} key has extra data`
      : `the ${name} key is ${e.key.length} bytes, not ${lengths.join(" or ")}`);
  }
}

function needValueLength(e, where, name, ...lengths) {
  if (!lengths.includes(e.value.length)) fail(where, `the ${name} value is ${e.value.length} bytes, not ${lengths.join(" or ")}`);
}

const u32le = (b) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

// A public key's size and first byte (curve checks need EC maths, not here).
function needPubkey(e, where, name) {
  const k = e.key;
  const ok = (k.length === 33 && (k[0] === 2 || k[0] === 3)) || (k.length === 65 && (k[0] === 4 || k[0] === 6 || k[0] === 7));
  if (!ok) fail(where, `the ${name} key is not a public key (${k.length} bytes)`);
}

// <fingerprint> <path element>*: { fingerprint (4 bytes), path: [u32] }
function keyOrigin(value, where, name) {
  if (value.length < 4 || value.length % 4) fail(where, `the ${name} value is ${value.length} bytes, not 4 + 4 per step`);
  const path = [];
  for (let i = 4; i < value.length; i += 4) path.push(u32le(value.subarray(i, i + 4)));
  return { fingerprint: value.subarray(0, 4), path };
}

function tapKeyOrigin(value, where) {
  const r = new Reader(value);
  const n = r.compactSize(`${where}: the number of leaf hashes`);
  if (n > r.left / 32) fail(where, "the taproot derivation has fewer leaf hashes than it says");
  const leafHashes = [];
  for (let i = 0; i < n; i++) leafHashes.push(r.bytes(32));
  return { leafHashes, ...keyOrigin(value.subarray(r.pos), where, "taproot derivation") };
}

function txOut(value, where) {
  const r = new Reader(value);
  const out = { value: r.u64(`${where}: the witness UTXO's amount`), script: r.varBytes(`${where}: the witness UTXO's script`) };
  if (r.left) fail(where, "the witness UTXO has extra data");
  return out;
}

function witnessStack(value, where) {
  const r = new Reader(value);
  const n = r.compactSize(`${where}: the number of witness items`);
  if (n > r.left) fail(where, "the final witness has fewer items than it says");
  const items = [];
  for (let i = 0; i < n; i++) items.push(r.varBytes(`${where}: a witness item`));
  if (r.left) fail(where, "the final witness has extra data");
  return items;
}

function decodeGlobal(entries, where, version) {
  const f = { xpubs: [], unknown: [], proprietary: [] };
  for (const e of entries) {
    if (version === 0 && V2_GLOBAL.includes(e.type) && !onlyV2(e, where)) {
      f.unknown.push(e);
      continue;
    }
    switch (e.type) {
      case GLOBAL.UNSIGNED_TX:
        needKeyLength(e, where, "unsigned transaction", 0);
        f.unsignedTx = e.value;
        break;
      case GLOBAL.XPUB:
        needKeyLength(e, where, "xpub", 78);
        f.xpubs.push({ xpub: e.key, ...keyOrigin(e.value, where, "xpub") });
        break;
      case GLOBAL.TX_VERSION:
        needKeyLength(e, where, "transaction version", 0);
        needValueLength(e, where, "transaction version", 4);
        f.txVersion = u32le(e.value) | 0;
        break;
      case GLOBAL.FALLBACK_LOCKTIME:
        needKeyLength(e, where, "fallback locktime", 0);
        needValueLength(e, where, "fallback locktime", 4);
        f.fallbackLocktime = u32le(e.value);
        break;
      case GLOBAL.INPUT_COUNT:
      case GLOBAL.OUTPUT_COUNT: {
        const name = e.type === GLOBAL.INPUT_COUNT ? "input count" : "output count";
        needKeyLength(e, where, name, 0);
        const r = new Reader(e.value);
        const n = r.compactSize(`${where}: the ${name}`);
        if (r.left) fail(where, `the ${name} has extra data`);
        f[e.type === GLOBAL.INPUT_COUNT ? "inputCount" : "outputCount"] = n;
        break;
      }
      case GLOBAL.TX_MODIFIABLE:
        needKeyLength(e, where, "modifiable flags", 0);
        needValueLength(e, where, "modifiable flags", 1);
        f.txModifiable = e.value[0];
        break;
      case GLOBAL.VERSION:
        needKeyLength(e, where, "version", 0);
        needValueLength(e, where, "version", 4);
        f.version = u32le(e.value);
        break;
      case GLOBAL.PROPRIETARY:
        f.proprietary.push(e);
        break;
      default:
        f.unknown.push(e);
    }
  }
  return f;
}

function decodeInput(entries, where, version) {
  const f = { partialSigs: [], bip32: [], tapBip32: [], tapScriptSigs: [], tapLeafScripts: [], preimages: [],
    unknown: [], proprietary: [] };
  for (const e of entries) {
    if (version === 0 && V2_IN.includes(e.type) && !onlyV2(e, where)) {
      f.unknown.push(e);
      continue;
    }
    switch (e.type) {
      case IN.NON_WITNESS_UTXO:
        needKeyLength(e, where, "non-witness UTXO", 0);
        try {
          f.nonWitnessUtxo = parseTx(e.value);
        } catch (err) {
          if (err instanceof DecodeError) fail(where, `the non-witness UTXO is not a transaction (${err.message})`);
          throw err;
        }
        f.nonWitnessUtxoBytes = e.value;
        break;
      case IN.WITNESS_UTXO:
        needKeyLength(e, where, "witness UTXO", 0);
        f.witnessUtxo = txOut(e.value, where);
        break;
      case IN.PARTIAL_SIG:
        needPubkey(e, where, "partial signature");
        f.partialSigs.push({ pubkey: e.key, signature: e.value });
        break;
      case IN.SIGHASH_TYPE:
        needKeyLength(e, where, "sighash type", 0);
        needValueLength(e, where, "sighash type", 4);
        f.sighashType = u32le(e.value);
        break;
      case IN.REDEEM_SCRIPT:
        needKeyLength(e, where, "redeemScript", 0);
        f.redeemScript = e.value;
        break;
      case IN.WITNESS_SCRIPT:
        needKeyLength(e, where, "witnessScript", 0);
        f.witnessScript = e.value;
        break;
      case IN.BIP32_DERIVATION:
        needPubkey(e, where, "BIP-32 derivation");
        f.bip32.push({ pubkey: e.key, ...keyOrigin(e.value, where, "BIP-32 derivation") });
        break;
      case IN.FINAL_SCRIPTSIG:
        needKeyLength(e, where, "final scriptSig", 0);
        f.finalScriptSig = e.value;
        break;
      case IN.FINAL_SCRIPTWITNESS:
        needKeyLength(e, where, "final script witness", 0);
        f.finalScriptWitness = witnessStack(e.value, where);
        break;
      case IN.POR_COMMITMENT:
        needKeyLength(e, where, "proof-of-reserves commitment", 0);
        f.porCommitment = e.value;
        break;
      case IN.RIPEMD160: case IN.HASH160:
        needKeyLength(e, where, "hash preimage", 20);
        f.preimages.push(e);
        break;
      case IN.SHA256: case IN.HASH256:
        needKeyLength(e, where, "hash preimage", 32);
        f.preimages.push(e);
        break;
      case IN.PREVIOUS_TXID:
        needKeyLength(e, where, "previous txid", 0);
        needValueLength(e, where, "previous txid", 32);
        f.previousTxid = e.value;
        break;
      case IN.OUTPUT_INDEX:
        needKeyLength(e, where, "output index", 0);
        needValueLength(e, where, "output index", 4);
        f.outputIndex = u32le(e.value);
        break;
      case IN.SEQUENCE:
        needKeyLength(e, where, "sequence", 0);
        needValueLength(e, where, "sequence", 4);
        f.sequence = u32le(e.value);
        break;
      case IN.REQUIRED_TIME_LOCKTIME:
        needKeyLength(e, where, "required time locktime", 0);
        needValueLength(e, where, "required time locktime", 4);
        f.requiredTimeLocktime = u32le(e.value);
        if (f.requiredTimeLocktime < 500000000) fail(where, "the required time locktime is below 500000000 (that is a height)");
        break;
      case IN.REQUIRED_HEIGHT_LOCKTIME:
        needKeyLength(e, where, "required height locktime", 0);
        needValueLength(e, where, "required height locktime", 4);
        f.requiredHeightLocktime = u32le(e.value);
        if (f.requiredHeightLocktime === 0 || f.requiredHeightLocktime >= 500000000) {
          fail(where, "the required height locktime is not a height from 1 to 499999999");
        }
        break;
      case IN.TAP_KEY_SIG:
        needKeyLength(e, where, "taproot key signature", 0);
        needValueLength(e, where, "taproot key signature", 64, 65);
        f.tapKeySig = e.value;
        break;
      case IN.TAP_SCRIPT_SIG:
        needKeyLength(e, where, "taproot script signature", 64);
        needValueLength(e, where, "taproot script signature", 64, 65);
        f.tapScriptSigs.push({ xonly: e.key.subarray(0, 32), leafHash: e.key.subarray(32), signature: e.value });
        break;
      case IN.TAP_LEAF_SCRIPT:
        if (e.key.length < 33 || (e.key.length - 33) % 32 || e.key.length > 33 + 128 * 32) {
          fail(where, `the taproot control block is ${e.key.length} bytes`);
        }
        if (e.value.length < 1) fail(where, "the taproot leaf script has no leaf version");
        f.tapLeafScripts.push({ controlBlock: e.key, script: e.value.subarray(0, -1), leafVersion: e.value[e.value.length - 1] });
        break;
      case IN.TAP_BIP32_DERIVATION:
        needKeyLength(e, where, "taproot BIP-32 derivation", 32);
        f.tapBip32.push({ xonly: e.key, ...tapKeyOrigin(e.value, where) });
        break;
      case IN.TAP_INTERNAL_KEY:
        needKeyLength(e, where, "taproot internal key", 0);
        needValueLength(e, where, "taproot internal key", 32);
        f.tapInternalKey = e.value;
        break;
      case IN.TAP_MERKLE_ROOT:
        needKeyLength(e, where, "taproot merkle root", 0);
        needValueLength(e, where, "taproot merkle root", 32);
        f.tapMerkleRoot = e.value;
        break;
      case IN.PROPRIETARY:
        f.proprietary.push(e);
        break;
      default:
        f.unknown.push(e);
    }
  }
  return f;
}

function decodeOutput(entries, where, version) {
  const f = { bip32: [], tapBip32: [], unknown: [], proprietary: [] };
  for (const e of entries) {
    if (version === 0 && V2_OUT.includes(e.type) && !onlyV2(e, where)) {
      f.unknown.push(e);
      continue;
    }
    switch (e.type) {
      case OUT.REDEEM_SCRIPT:
        needKeyLength(e, where, "redeemScript", 0);
        f.redeemScript = e.value;
        break;
      case OUT.WITNESS_SCRIPT:
        needKeyLength(e, where, "witnessScript", 0);
        f.witnessScript = e.value;
        break;
      case OUT.BIP32_DERIVATION:
        needPubkey(e, where, "BIP-32 derivation");
        f.bip32.push({ pubkey: e.key, ...keyOrigin(e.value, where, "BIP-32 derivation") });
        break;
      case OUT.AMOUNT: {
        needKeyLength(e, where, "amount", 0);
        needValueLength(e, where, "amount", 8);
        f.amount = new Reader(e.value).u64();
        break;
      }
      case OUT.SCRIPT:
        needKeyLength(e, where, "script", 0);
        f.script = e.value;
        break;
      case OUT.TAP_INTERNAL_KEY:
        needKeyLength(e, where, "taproot internal key", 0);
        needValueLength(e, where, "taproot internal key", 32);
        f.tapInternalKey = e.value;
        break;
      case OUT.TAP_TREE:
        needKeyLength(e, where, "taproot tree", 0);
        f.tapTree = e.value;
        break;
      case OUT.TAP_BIP32_DERIVATION:
        needKeyLength(e, where, "taproot BIP-32 derivation", 32);
        f.tapBip32.push({ xonly: e.key, ...tapKeyOrigin(e.value, where) });
        break;
      case OUT.PROPRIETARY:
        f.proprietary.push(e);
        break;
      default:
        f.unknown.push(e);
    }
  }
  return f;
}

// A version 2 field in a version 0 PSBT: refused when its key is empty
// (BIP-370); with key data, it is some other, unknown field.
function onlyV2(e, where) {
  if (e.key.length === 0) fail(where, `field 0x${e.type.toString(16)} is for PSBT version 2 only`);
  return false;
}

// BIP-370's locktime: null when the inputs' requirements can't all be met.
export function computeLocktime(fallback, inputs) {
  const constrained = inputs.filter((f) => f.requiredTimeLocktime !== undefined || f.requiredHeightLocktime !== undefined);
  if (constrained.length === 0) return fallback ?? 0;
  if (constrained.every((f) => f.requiredHeightLocktime !== undefined)) {
    return Math.max(...constrained.map((f) => f.requiredHeightLocktime));
  }
  if (constrained.every((f) => f.requiredTimeLocktime !== undefined)) {
    return Math.max(...constrained.map((f) => f.requiredTimeLocktime));
  }
  return null;
}

// Parses PSBT bytes. Throws PsbtError (a DecodeError) saying what is wrong.
export function parsePsbt(bytes) {
  if (!isPsbt(bytes)) throw new PsbtError("not a PSBT (it doesn't start with \"psbt\" 0xff)");
  const r = new Reader(bytes, 5);
  const globalEntries = readMap(r, "the global map");
  const v = globalEntries.find((e) => e.type === GLOBAL.VERSION && e.key.length === 0 && e.value.length === 4);
  const g = decodeGlobal(globalEntries, "the global map", v ? u32le(v.value) : 0);
  const version = g.version ?? 0;
  if (version !== 0 && version !== 2) throw new PsbtError(`PSBT version ${version} is not supported (only 0 and 2)`);

  let tx, nIn, nOut;
  if (version === 0) {
    if (!g.unsignedTx) throw new PsbtError("the global map has no unsigned transaction");
    try {
      tx = parseTx(g.unsignedTx, { allowZeroInputs: true });
    } catch (err) {
      if (err instanceof DecodeError) throw new PsbtError(`the unsigned transaction is malformed (${err.message})`);
      throw err;
    }
    if (tx.inputs.some((i) => i.scriptSig.length || i.witness.length)) {
      throw new PsbtError("the unsigned transaction has a scriptSig or witness");
    }
    nIn = tx.inputs.length;
    nOut = tx.outputs.length;
  } else {
    if (g.unsignedTx) throw new PsbtError("a version 2 PSBT can't have an unsigned transaction");
    for (const [name, v] of [["transaction version", g.txVersion], ["input count", g.inputCount], ["output count", g.outputCount]]) {
      if (v === undefined) throw new PsbtError(`the global map has no ${name} (required in version 2)`);
    }
    if (g.txVersion < 2) throw new PsbtError("version 2 PSBTs need a transaction version of 2 or more");
    nIn = g.inputCount;
    nOut = g.outputCount;
    if (nIn > r.left || nOut > r.left) throw new PsbtError("truncated: fewer maps than the counts say");
  }

  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const where = `input ${i}`;
    const entries = readMap(r, where);
    const fields = decodeInput(entries, where, version);
    if (version === 2) {
      if (!fields.previousTxid) fail(where, "no previous txid (required in version 2)");
      if (fields.outputIndex === undefined) fail(where, "no output index (required in version 2)");
    }
    inputs.push({ entries, fields });
  }
  const outputs = [];
  for (let i = 0; i < nOut; i++) {
    const where = `output ${i}`;
    const entries = readMap(r, where);
    const fields = decodeOutput(entries, where, version);
    if (version === 2) {
      if (fields.amount === undefined) fail(where, "no amount (required in version 2)");
      if (!fields.script) fail(where, "no script (required in version 2)");
    }
    outputs.push({ entries, fields });
  }
  if (r.left) throw new PsbtError(`${r.left} bytes after the last output map`);

  if (version === 2) {
    tx = {
      version: g.txVersion,
      inputs: inputs.map(({ fields: f }) => ({
        txid: f.previousTxid, vout: f.outputIndex, scriptSig: new Uint8Array(0), sequence: f.sequence ?? 0xffffffff, witness: [],
      })),
      outputs: outputs.map(({ fields: f }) => ({ value: f.amount, script: f.script })),
      locktime: computeLocktime(g.fallbackLocktime, inputs.map((i) => i.fields)),
      segwit: false,
    };
  }
  return { version, tx, global: { entries: globalEntries, fields: g }, inputs, outputs };
}

export function serializePsbt(psbt) {
  const w = new Writer(1024);
  w.bytes(MAGIC);
  writeMap(w, psbt.global.entries);
  for (const m of psbt.inputs) writeMap(w, m.entries);
  for (const m of psbt.outputs) writeMap(w, m.entries);
  return w.done();
}

// Sets (replaces, or appends) a key in a map, for an updater or signer.
// Call parsePsbt(serializePsbt(psbt)) afterwards to decode it again.
export function setEntry(map, type, key, value) {
  const fullKey = keyBytes(type, key);
  const e = { type, key: fullKey.subarray(fullKey.length - key.length), value, fullKey };
  const i = map.entries.findIndex((x) => equal(x.fullKey, fullKey));
  if (i >= 0) map.entries[i] = e;
  else map.entries.push(e);
}
