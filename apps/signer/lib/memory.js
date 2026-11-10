// What this Signer has signed since the device was switched on: each input's
// outpoint (txid:vout) and the amount the PSBT said it spends. Kept in
// gk:session: RAM only, wiped at power-off, never on the card. Nothing else
// is kept: no keys, scripts, addresses or transactions.
//
//   const memory = new SignedMemory(store)   store: gk:session (get, set), or
//                                            a stand-in with get and set (tests)
//   memory.check(psbt, amounts) -> { same: [index], changed: [{ index, before, now }] }
//   memory.record(psbt, indices, amounts)    after signing those inputs
//   memory.warnings(seen) -> [{ level, text }]   for the review (Messages)
//
// `amounts`: each input's amount as the review shows it (analyze()'s), or
// null when unknown.
//
// Why: a segwit v0 signature covers its own input's amount only. A hostile
// computer can ask twice for the same coins, each time understating a
// different input, and put the two signatures together: the fee shown was
// modest both times, the real one is not (the segwit v0 fee attack). A
// coin's amount never changes, so the same outpoint told with another amount
// means one of the two times was a lie: the Signer refuses. Every input is
// checked and recorded, whatever its kind, as that costs nothing: proved
// amounts (a previous transaction) and taproot's too. After power-off the
// memory is gone; the review's amber warning (analyze.js) says what to do
// then.
//
// Pure, as the rest of lib/: tested under Node.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t, plural, btcValue, numbers } from "./text.js";
import { toHexReversed } from "./psbt/bytes.js";

const KEY = "signed";
// gk:session holds 64 KiB per app; an entry takes about 80 bytes. Past this,
// the oldest are forgotten (a person signs far fewer coins between two
// power-offs).
export const MAX_ENTRIES = 500;

const outpoint = (psbt, i) => `${toHexReversed(psbt.tx.inputs[i].txid)}:${psbt.tx.inputs[i].vout}`;

export class SignedMemory {
  constructor(store) {
    this.store = store;
  }

  entries() {
    const e = this.store.get(KEY);
    return e && typeof e === "object" ? e : {};
  }

  check(psbt, amounts) {
    const known = this.entries();
    const same = [], changed = [];
    psbt.tx.inputs.forEach((_, i) => {
      const before = known[outpoint(psbt, i)];
      if (typeof before !== "number" || typeof amounts[i] !== "number") return;
      if (before === amounts[i]) same.push(i);
      else changed.push({ index: i, before, now: amounts[i] });
    });
    return { same, changed };
  }

  record(psbt, indices, amounts) {
    const known = this.entries();
    for (const i of indices) {
      if (typeof amounts[i] !== "number") continue;
      const id = outpoint(psbt, i);
      delete known[id]; // to the end: the newest
      known[id] = amounts[i];
    }
    const keep = (n) => {
      const ids = Object.keys(known);
      for (const id of ids.slice(0, Math.max(0, ids.length - n))) delete known[id];
    };
    keep(MAX_ENTRIES);
    try {
      this.store.set(KEY, known);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      keep(MAX_ENTRIES / 2); // the app's 64 KiB, shared with nothing else here: should not happen
      this.store.set(KEY, known);
    }
  }

  warnings(seen) {
    const out = seen.changed.map((c) => ({ level: "danger", text: t("Input {n} was signed before, since this device " +
      "was switched on, as spending {before} BTC; now it says {now} BTC. A coin's amount never changes, so one of " +
      "the two is a lie: this is the segwit fee attack (two signatures, each made with a different amount, can pay " +
      "a much larger fee together). It is not signed.", { n: c.index + 1, before: btcValue(c.before), now: btcValue(c.now) }) }));
    if (seen.same.length) {
      const list = numbers(seen.same.map((i) => i + 1));
      out.push({ level: "info", text: plural(seen.same.length, "Input {list}: signed before since this device was " +
        "switched on, with the same amount.", "Inputs {list}: signed before since this device was switched on, with " +
        "the same amounts.", { list }) });
    }
    return out;
  }
}
