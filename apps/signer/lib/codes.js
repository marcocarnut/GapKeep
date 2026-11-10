// What the camera reads, code by code: one QR code that holds a transaction
// (transport.js: Electrum's forms), or the parts of a BBQr series, as they
// come. The text decides which.
//
//   const r = new CodeReader();
//   r.read(text, bytes) -> { part: { have, total, added } }   more to come
//                       or { payload: { encoding, bytes, kind, chars } }
//   r.reset()           forget the parts read; r.started: any read?
//   seriesFor(bytes, kind) -> { version, encoding, parts }  to show them
//   sizeProblem(tx) -> a Message if the transaction has more inputs or
//                      outputs than are checked in time, else null
//
// kind and bytes as readPayload()'s: "psbt" or "tx". encoding: as
// readPayload()'s, or "BBQr". Throws DecodeError with a message for people;
// the parts read so far stay, but for a series that can't be finished.
//
// Pure, as the rest of lib/: tested under Node.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t } from "./text.js";
import { DecodeError } from "./psbt/bytes.js";
import { readPayload } from "./psbt/transport.js";
import { isPsbt } from "./psbt/psbt.js";
import { Joiner, BBQrError, FILE_TYPES, isBBQr, parsePart, split } from "./bbqr.js";

// The limits of what is read, as everything a code holds is checked in one
// handler, and a handler has 10 s (a hostile computer could aim at that).
// In the simulator, parsing a 486 KB PSBT takes 77 ms, and analysing and
// planning 200 inputs that each hold a signature to verify 30 ms; a Pi Zero
// is some 30 to 40 times slower. So, at most:
//   - 256 KiB, a PSBT with its previous transactions (some 200 inputs of
//     ordinary ones): the Joiner stops there, compressed or not;
//   - 200 inputs and 500 outputs.
// (Base43 isn't one: a QR code holds at most 4296 of its characters,
// decoded in about 2 ms in the simulator.)
export const MAX_BYTES = 256 * 1024;
export const MAX_INPUTS = 200;
export const MAX_OUTPUTS = 500;

export function sizeProblem(tx) {
  if (tx.inputs.length > MAX_INPUTS) {
    return t("This transaction has {n} inputs: this signer checks at most {max}.", { n: tx.inputs.length, max: MAX_INPUTS });
  }
  if (tx.outputs.length > MAX_OUTPUTS) {
    return t("This transaction has {n} outputs: this signer checks at most {max}.", { n: tx.outputs.length, max: MAX_OUTPUTS });
  }
  return null;
}

const isPart = (text) => {
  if (!isBBQr(text)) return false;
  try {
    parsePart(text);
    return true;
  } catch (e) {
    if (e instanceof BBQrError) return false;
    throw e;
  }
};

// Up to version 12, a size a phone or webcam reads off a screen, and few
// parts if that's enough. (Core tunes these on the rig: B2.)
const MAX_VERSION = 12;
const FEW_PARTS = 8;

// BBQr for a "psbt" or a "tx". Every part is to be shown at this version and
// error correction L.
export function seriesFor(bytes, kind) {
  const type = kind === "psbt" ? "P" : "T";
  try {
    return split(bytes, type, { maxVersion: MAX_VERSION, maxParts: FEW_PARTS });
  } catch (e) {
    if (!(e instanceof BBQrError)) throw e;
  }
  return split(bytes, type, { minVersion: MAX_VERSION, maxVersion: MAX_VERSION });
}

export class CodeReader {
  constructor() {
    this.joiner = new Joiner({ maxBytes: MAX_BYTES });
    this.chars = 0;
  }

  get started() {
    return this.joiner.have > 0;
  }

  reset() {
    this.joiner.reset();
    this.chars = 0;
  }

  read(text, bytes = null) {
    // ("B$" is in Base43's alphabet too, but a transaction in Base43 won't
    // read as a BBQr header; if it doesn't, readPayload says what it is)
    if (!isPart(text)) {
      const r = readPayload(text, bytes);
      return { payload: { ...r, chars: text === null || text === undefined ? bytes.length : text.length } };
    }
    let p;
    try {
      p = this.joiner.add(text);
    } catch (e) {
      if (!(e instanceof BBQrError)) throw e;
      if (e.code === "series") {
        throw new DecodeError(t("That code is from another series. Keep showing the first one ({have} of {total} " +
          "read), or start over.", { have: this.joiner.have, total: this.joiner.total }));
      }
      throw new DecodeError(t("This BBQr code can't be used: {why}", { why: e.message }));
    }
    if (p.added) this.chars += text.length;
    if (!p.done) return { part: { have: p.have, total: p.total, added: p.added } };
    return { payload: this.finish() };
  }

  finish() {
    const chars = this.chars;
    let file;
    try {
      file = this.joiner.result();
    } catch (e) {
      if (!(e instanceof BBQrError)) throw e;
      this.reset();
      throw new DecodeError(t("These BBQr codes don't make a file: {why}", { why: e.message }));
    }
    this.reset();
    if (file.type === "T") return { encoding: "BBQr", bytes: file.bytes, kind: "tx", chars };
    if (file.type === "P") {
      if (!isPsbt(file.bytes)) throw new DecodeError(t("This BBQr series says it is a PSBT, but it isn't one."));
      return { encoding: "BBQr", bytes: file.bytes, kind: "psbt", chars };
    }
    throw new DecodeError(t("This BBQr series holds a {kind}, not a transaction.", { kind: FILE_TYPES[file.type] || "file" }));
  }
}
