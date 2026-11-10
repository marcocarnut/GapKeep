// Signature hashes: what a signature commits to.
//
//   legacySighash(tx, index, scriptCode, type)            pre-segwit (P2PKH)
//   segwitV0Sighash(tx, index, scriptCode, amount, type)   BIP-143
//   taprootSighash(tx, index, prevouts, type)              BIP-341, key path
//   taprootSigMsg(tx, index, prevouts, type)               its message, before hashing
//
// `tx` as tx.js parses it (a PSBT's psbt.tx); `prevouts`: every input's spent
// output, [{ value, script }]. Every sighash type is computed (the tests
// check them all); which ones may be signed is sign.js's decision.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { Writer, concat } from "./psbt/bytes.js";
import { sha256, sha256d } from "./psbt/hashes.js";
import { serializeTx } from "./psbt/tx.js";
import { taggedHash } from "./crypto.js";

export const SIGHASH = { DEFAULT: 0, ALL: 1, NONE: 2, SINGLE: 3, ANYONECANPAY: 0x80 };

function outpoints(tx) {
  const w = new Writer(36 * tx.inputs.length);
  for (const i of tx.inputs) w.bytes(i.txid).u32(i.vout);
  return w.done();
}

function sequences(tx) {
  const w = new Writer(4 * tx.inputs.length);
  for (const i of tx.inputs) w.u32(i.sequence);
  return w.done();
}

function outputBytes(outputs) {
  const w = new Writer(256);
  for (const o of outputs) w.u64(o.value).varBytes(o.script);
  return w.done();
}

// Hashes shared by every input's sighash, computed once per transaction.
const cache = new WeakMap();
function shared(tx) {
  let s = cache.get(tx);
  if (!s) {
    s = {};
    cache.set(tx, s);
  }
  return s;
}
const once = (tx, name, make) => {
  const s = shared(tx);
  if (!(name in s)) s[name] = make();
  return s[name];
};

// --- legacy ------------------------------------------------------------------

const ONE = (() => {
  const b = new Uint8Array(32);
  b[0] = 1;
  return b;
})();

// Bitcoin's original SignatureHash. scriptCode: the spent script (P2PKH's
// scriptPubKey); OP_CODESEPARATOR is not handled (no supported script has it).
export function legacySighash(tx, index, scriptCode, type) {
  if (index >= tx.inputs.length) return ONE.slice();
  const base = type & 0x1f, anyone = (type & SIGHASH.ANYONECANPAY) !== 0;
  if (base === SIGHASH.SINGLE && index >= tx.outputs.length) return ONE.slice(); // the "SIGHASH_SINGLE bug"
  const empty = new Uint8Array(0);
  let inputs = tx.inputs.map((inp, i) => ({
    ...inp, witness: [], scriptSig: i === index ? scriptCode : empty,
    sequence: i !== index && (base === SIGHASH.NONE || base === SIGHASH.SINGLE) ? 0 : inp.sequence,
  }));
  if (anyone) inputs = [inputs[index]];
  let outputs = tx.outputs;
  if (base === SIGHASH.NONE) outputs = [];
  else if (base === SIGHASH.SINGLE) {
    outputs = tx.outputs.slice(0, index + 1).map((o, i) => (i < index ? { value: 0xffffffffffffffffn, script: empty } : o));
  }
  const bytes = serializeTx({ version: tx.version, inputs, outputs, locktime: tx.locktime }, { withWitness: false });
  const w = new Writer(bytes.length + 4);
  w.bytes(bytes).u32(type >>> 0);
  return sha256d(w.done());
}

// --- BIP-143 -----------------------------------------------------------------

const ZERO32 = new Uint8Array(32);

export function segwitV0Sighash(tx, index, scriptCode, amount, type) {
  const base = type & 0x1f, anyone = (type & SIGHASH.ANYONECANPAY) !== 0;
  const single = base === SIGHASH.SINGLE, none = base === SIGHASH.NONE;
  const hashPrevouts = anyone ? ZERO32 : once(tx, "v0prevouts", () => sha256d(outpoints(tx)));
  const hashSequence = anyone || single || none ? ZERO32 : once(tx, "v0sequences", () => sha256d(sequences(tx)));
  let hashOutputs = ZERO32;
  if (!single && !none) hashOutputs = once(tx, "v0outputs", () => sha256d(outputBytes(tx.outputs)));
  else if (single && index < tx.outputs.length) hashOutputs = sha256d(outputBytes([tx.outputs[index]]));
  const inp = tx.inputs[index];
  const w = new Writer(160 + scriptCode.length);
  w.u32(tx.version >>> 0).bytes(hashPrevouts).bytes(hashSequence).bytes(inp.txid).u32(inp.vout)
    .varBytes(scriptCode).u64(amount).u32(inp.sequence).bytes(hashOutputs).u32(tx.locktime).u32(type >>> 0);
  return sha256d(w.done());
}

// The scriptCode BIP-143 uses for P2WPKH (and P2SH-P2WPKH): the P2PKH script
// of the key hash.
export const p2wpkhScriptCode = (hash20) =>
  concat([Uint8Array.of(0x76, 0xa9, 20), hash20, Uint8Array.of(0x88, 0xac)]);

// --- BIP-341 -----------------------------------------------------------------

const VALID_TAPROOT_TYPES = [0, 1, 2, 3, 0x81, 0x82, 0x83];

// SigMsg(hash_type, 0) of BIP-341 for a key-path spend without annex,
// prefixed with the epoch byte (0x00), as the BIP's test vectors give it.
export function taprootSigMsg(tx, index, prevouts, type) {
  if (!VALID_TAPROOT_TYPES.includes(type)) throw new RangeError("taproot: invalid sighash type");
  if (prevouts.length !== tx.inputs.length) throw new RangeError("taproot: every input's spent output is needed");
  const base = type & 3, anyone = (type & SIGHASH.ANYONECANPAY) !== 0;
  if (base === SIGHASH.SINGLE && index >= tx.outputs.length) throw new RangeError("taproot: SIGHASH_SINGLE without its output");
  const s = shared(tx);
  if (s.tapFor !== prevouts) {
    for (const k of ["tapAmounts", "tapScripts"]) delete s[k];
    s.tapFor = prevouts;
  }
  const w = new Writer(256);
  w.u8(0).u8(type).u32(tx.version >>> 0).u32(tx.locktime);
  if (!anyone) {
    w.bytes(once(tx, "tapPrevouts", () => sha256(outpoints(tx))));
    w.bytes(once(tx, "tapAmounts", () => {
      const a = new Writer(8 * prevouts.length);
      for (const p of prevouts) a.u64(p.value);
      return sha256(a.done());
    }));
    w.bytes(once(tx, "tapScripts", () => {
      const a = new Writer(256);
      for (const p of prevouts) a.varBytes(p.script);
      return sha256(a.done());
    }));
    w.bytes(once(tx, "tapSequences", () => sha256(sequences(tx))));
  }
  if (base !== SIGHASH.NONE && base !== SIGHASH.SINGLE) w.bytes(once(tx, "tapOutputs", () => sha256(outputBytes(tx.outputs))));
  w.u8(0); // spend_type: key path, no annex
  if (anyone) {
    const inp = tx.inputs[index];
    w.bytes(inp.txid).u32(inp.vout).u64(prevouts[index].value).varBytes(prevouts[index].script).u32(inp.sequence);
  } else {
    w.u32(index);
  }
  if (base === SIGHASH.SINGLE) w.bytes(sha256(outputBytes([tx.outputs[index]])));
  return w.done();
}

// The hashes every input shares are computed once per tx object (and
// prevouts array): the tx must not be changed between calls.
export const taprootSighash = (tx, index, prevouts, type) => taggedHash("TapSighash", taprootSigMsg(tx, index, prevouts, type));
