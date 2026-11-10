// BIP-174's Combiner: copies of one transaction, each with what its signer
// added, into one PSBT.
//
//   combine(a, b) -> { psbt (a new, re-parsed PSBT), added (entries new to a),
//                      notes: [{ level, text }] }
//
// `a` and `b` come from parsePsbt(). Different transactions are never
// combined, and neither are copies that disagree: a key that holds two
// values anywhere is refused. CombineError has the reason, for people.
//
// One exception: two different signatures by one key of one input. They can
// both be valid (a signer that doesn't use RFC 6979, or grinds, or signed
// twice), so each is verified, once all else is merged: both good, `a`'s
// stays, with a note; only one good, it stays and the other goes, with a red
// note; neither good, `a`'s stays (sign.js reports it). When it can't tell,
// as for a key of a multisig coin, the copies are refused as they disagree.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t } from "./text.js";
import { equal } from "./psbt/bytes.js";
import { parsePsbt, serializePsbt, IN } from "./psbt/psbt.js";
import { txid } from "./psbt/tx.js";
import { partialSigGood } from "./sign.js";

export class CombineError extends Error {
  constructor(message) {
    super(String(message));
    this.text = message;   // a Message (text.js) where it is one: the app translates it
    this.name = "CombineError";
  }
}

const idOf = (psbt) => {
  if (psbt.tx.locktime === null) throw new CombineError(t("The inputs' locktime requirements contradict each other."));
  return txid(psbt.tx);
};

const NAMES = { [IN.PARTIAL_SIG]: () => t("a signature"), [IN.NON_WITNESS_UTXO]: () => t("the previous transaction"),
  [IN.WITNESS_UTXO]: () => t("the coin spent"), [IN.SIGHASH_TYPE]: () => t("the sighash type") };

function mergeMap(into, from, where, isInput, later) {
  let added = 0;
  for (const e of from.entries) {
    const mine = into.entries.find((x) => equal(x.fullKey, e.fullKey));
    if (!mine) {
      into.entries.push(e);
      added++;
    } else if (!equal(mine.value, e.value)) {
      if (isInput && e.type === IN.PARTIAL_SIG) {
        later.push(e);
        continue;
      }
      const what = isInput && NAMES[e.type] ? NAMES[e.type]() : t("field {type}", { type: String(e.type) });
      throw new CombineError(t("The two copies disagree about {what} in {where}: not merged.", { what, where }));
    }
  }
  return added;
}

export function combine(a, b) {
  if (a.version !== b.version) {
    throw new CombineError(t("These are PSBTs of different versions ({first} and {second}): not merged.",
      { first: String(a.version), second: String(b.version) }));
  }
  if (idOf(a) !== idOf(b)) throw new CombineError(t("That is a different transaction: only copies of the same one are merged."));
  // (a txid can't tell apart two lists of maps of different lengths, as the
  // lengths come from the transaction: they are equal here)
  const out = parsePsbt(serializePsbt(a)); // the caller's PSBT is left as it was
  let added = mergeMap(out.global, b.global, t("the global fields"), false);
  const twoSigs = [];
  b.inputs.forEach((m, i) => {
    const later = [];
    added += mergeMap(out.inputs[i], m, t("input {n}", { n: i + 1 }), true, later);
    for (const e of later) twoSigs.push({ i, e });
  });
  b.outputs.forEach((m, i) => (added += mergeMap(out.outputs[i], m, t("output {n}", { n: i + 1 }), false)));
  const merged = parsePsbt(serializePsbt(out));
  const notes = [];
  for (const { i, e } of twoSigs) {
    const map = merged.inputs[i], mine = map.entries.find((x) => equal(x.fullKey, e.fullKey));
    const goodA = partialSigGood(merged, i, e.key, mine.value), goodB = partialSigGood(merged, i, e.key, e.value);
    if (goodA === null || goodB === null) {
      throw new CombineError(t("The two copies disagree about a signature in input {n}: not merged.", { n: i + 1 }));
    }
    if (goodA && goodB) {
      notes.push({ level: "info", text: t("Input {n}: two valid signatures from the same key; kept one.", { n: i + 1 }) });
    } else if (goodA || goodB) {
      if (goodB) mine.value = e.value;
      notes.push({ level: "danger", text: t("Input {n}: one copy's signature is not valid for this transaction: dropped it.",
        { n: i + 1 }) });
    }
  }
  return { psbt: parsePsbt(serializePsbt(merged)), added, notes };
}
