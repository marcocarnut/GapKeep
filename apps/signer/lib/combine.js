// BIP-174's Combiner: copies of one transaction, each with what its signer
// added, into one PSBT.
//
//   combine(a, b) -> { psbt (a new, re-parsed PSBT), added (entries new to a) }
//
// `a` and `b` come from parsePsbt(). Different transactions are never
// combined, and neither are copies that disagree: a key that holds two
// values anywhere is refused, signatures included (two valid signatures of
// one input by one key are possible, but nothing here needs them).
// CombineError has the reason, for people.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { equal } from "./psbt/bytes.js";
import { parsePsbt, serializePsbt, IN } from "./psbt/psbt.js";
import { txid } from "./psbt/tx.js";

export class CombineError extends Error {
  constructor(message) {
    super(message);
    this.name = "CombineError";
  }
}

const idOf = (psbt) => {
  if (psbt.tx.locktime === null) throw new CombineError("The inputs' locktime requirements contradict each other.");
  return txid(psbt.tx);
};

const NAMES = { [IN.PARTIAL_SIG]: "a signature", [IN.NON_WITNESS_UTXO]: "the previous transaction",
  [IN.WITNESS_UTXO]: "the coin spent", [IN.SIGHASH_TYPE]: "the sighash type" };

function mergeMap(into, from, where, isInput) {
  let added = 0;
  for (const e of from.entries) {
    const mine = into.entries.find((x) => equal(x.fullKey, e.fullKey));
    if (!mine) {
      into.entries.push(e);
      added++;
    } else if (!equal(mine.value, e.value)) {
      const what = (isInput && NAMES[e.type]) || `field ${e.type}`;
      throw new CombineError(`The two copies disagree about ${what} in ${where}: not merged.`);
    }
  }
  return added;
}

export function combine(a, b) {
  if (a.version !== b.version) throw new CombineError(`These are PSBTs of different versions (${a.version} and ${b.version}): not merged.`);
  if (idOf(a) !== idOf(b)) throw new CombineError("That is a different transaction: only copies of the same one are merged.");
  // (a txid can't tell apart two lists of maps of different lengths, as the
  // lengths come from the transaction: they are equal here)
  const out = parsePsbt(serializePsbt(a)); // the caller's PSBT is left as it was
  let added = mergeMap(out.global, b.global, "the global fields", false);
  b.inputs.forEach((m, i) => (added += mergeMap(out.inputs[i], m, `input ${i + 1}`, true)));
  b.outputs.forEach((m, i) => (added += mergeMap(out.outputs[i], m, `output ${i + 1}`, false)));
  return { psbt: parsePsbt(serializePsbt(out)), added };
}
