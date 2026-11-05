// Bitcoin transactions: parse and serialize (legacy and segwit, BIP-144),
// txid, wtxid, weight.
//
//   tx = { version, inputs: [{ txid (32 bytes, as serialized), vout, scriptSig,
//          sequence, witness: [Uint8Array] }], outputs: [{ value, script }],
//          locktime, segwit }
//
// `segwit`: serialized with the marker and flag. A segwit serialization
// with no witness at all is refused (as Bitcoin Core does), and so is a
// legacy one that reads as segwit; zero inputs, then, can only be read
// with { allowZeroInputs: true } (a PSBT's unsigned transaction).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { Reader, Writer, DecodeError, toHexReversed, compactSizeLength } from "./bytes.js";
import { sha256d } from "./hashes.js";

export const MAX_MONEY = 2100000000000000;

function readInputs(r, n) {
  const inputs = [];
  for (let i = 0; i < n; i++) {
    inputs.push({
      txid: r.bytes(32, `input ${i}'s previous txid`),
      vout: r.u32(`input ${i}'s output index`),
      scriptSig: r.varBytes(`input ${i}'s scriptSig`),
      sequence: r.u32(`input ${i}'s sequence`),
      witness: [],
    });
  }
  return inputs;
}

function readOutputs(r) {
  const n = r.compactSize("the number of outputs");
  if (n > r.left / 9) throw new DecodeError("truncated: fewer outputs than the count says");
  const outputs = [];
  for (let i = 0; i < n; i++) {
    outputs.push({ value: r.u64(`output ${i}'s amount`), script: r.varBytes(`output ${i}'s script`) });
  }
  return outputs;
}

// Reads one transaction from r (which may go on past it).
export function readTx(r, { allowZeroInputs = false } = {}) {
  const tx = { version: r.i32("the version"), inputs: null, outputs: null, locktime: 0, segwit: false };
  let n = r.compactSize("the number of inputs");
  if (n === 0 && !allowZeroInputs) {
    const flag = r.u8("the segwit flag");
    if (flag !== 1) throw new DecodeError("unknown transaction serialization (segwit flag not 1)");
    tx.segwit = true;
    n = r.compactSize("the number of inputs");
  }
  if (n > r.left / 41) throw new DecodeError("truncated: fewer inputs than the count says");
  tx.inputs = readInputs(r, n);
  tx.outputs = readOutputs(r);
  if (tx.segwit) {
    let any = false;
    for (const input of tx.inputs) {
      const k = r.compactSize("the number of witness items");
      if (k > r.left) throw new DecodeError("truncated: fewer witness items than the count says");
      for (let j = 0; j < k; j++) input.witness.push(r.varBytes("a witness item"));
      if (k) any = true;
    }
    if (!any) throw new DecodeError("segwit serialization with no witness data");
  }
  tx.locktime = r.u32("the locktime");
  return tx;
}

export function parseTx(bytes, options) {
  const r = new Reader(bytes);
  const tx = readTx(r, options);
  if (r.left) throw new DecodeError(`${r.left} bytes after the end of the transaction`);
  return tx;
}

export const hasWitness = (tx) => tx.inputs.some((i) => i.witness.length > 0);

// withWitness: segwit serialization when any input has a witness.
export function serializeTx(tx, { withWitness = true } = {}) {
  const w = new Writer(256);
  const segwit = withWitness && hasWitness(tx);
  w.u32(tx.version >>> 0);
  if (segwit) w.u8(0).u8(1);
  w.compactSize(tx.inputs.length);
  for (const i of tx.inputs) w.bytes(i.txid).u32(i.vout).varBytes(i.scriptSig).u32(i.sequence);
  w.compactSize(tx.outputs.length);
  for (const o of tx.outputs) w.u64(o.value).varBytes(o.script);
  if (segwit) {
    for (const i of tx.inputs) {
      w.compactSize(i.witness.length);
      for (const item of i.witness) w.varBytes(item);
    }
  }
  w.u32(tx.locktime);
  return w.done();
}

// Display order (reversed), as block explorers and wallets show them.
export const txid = (tx) => toHexReversed(sha256d(serializeTx(tx, { withWitness: false })));
export const wtxid = (tx) => toHexReversed(sha256d(serializeTx(tx)));

export function witnessSize(witness) {
  let n = compactSizeLength(witness.length);
  for (const item of witness) n += compactSizeLength(item.length) + item.length;
  return n;
}

export const outputSize = (o) => 8 + compactSizeLength(o.script.length) + o.script.length;
export const inputBaseSize = (scriptSigLength) => 32 + 4 + compactSizeLength(scriptSigLength) + scriptSigLength + 4;

// BIP-141 weight of a complete transaction.
export function weight(tx) {
  const base = serializeTx(tx, { withWitness: false }).length;
  const total = serializeTx(tx).length;
  return base * 3 + total;
}

export const vsize = (tx) => Math.ceil(weight(tx) / 4);
