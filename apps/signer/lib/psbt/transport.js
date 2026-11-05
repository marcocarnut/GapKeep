// How transactions travel in QR codes between zerogap and Electrum.
//
// Electrum shows a PSBT (or a signed transaction) as one QR code: the
// bytes in Base43 (PartialTransaction.to_qr_data(), electrum/transaction.py),
// after replacing each input's previous transaction by just the output it
// spends (convert_all_utxos_to_witness_utxos), to make it fit.
//
// Reading, Electrum ("Load transaction", "From QR code": tx_from_any())
// removes all whitespace, then takes the first of these that decodes:
//   1. hex (either case),
//   2. Base64, if it starts with "cHNidP" (a PSBT's Base64),
//   3. Base43, if at most 30000 characters,
// and the bytes are a PSBT ("psbt" 0xff) or else a network transaction.
// readPayload() does the same, so whatever Electrum would load, this does.
// (A "bitcoin:" URI there is a payment request, not a transaction.)
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { DecodeError, fromHex, isHex, fromBase64, toHex, equal } from "./bytes.js";
import { base43Encode, base43Decode, isBase43 } from "./basen.js";
import { isPsbt } from "./psbt.js";
import { parseTx } from "./tx.js";

export const MAX_BASE43 = 30000; // Electrum's limit (quadratic decoding)

const OLD_ELECTRUM = Uint8Array.of(0x45, 0x50, 0x54, 0x46, 0xff); // "EPTF" 0xff: Electrum before 4.0

// What a QR code holds -> { encoding: "hex" | "base64" | "base43" | "binary",
// bytes, kind: "psbt" | "tx" (anything else: parse it to know) }.
// `text`: the code's text (null if not UTF-8); `bytes`: its raw bytes.
// Throws DecodeError with a message for people.
export function readPayload(text, bytes = null) {
  if (text === null || text === undefined) {
    if (!bytes || bytes.length === 0) throw new DecodeError("The code is empty.");
    if (isPsbt(bytes)) return { encoding: "binary", bytes, kind: "psbt" };
    throw new DecodeError("This code holds binary data, not a transaction in a form Electrum uses.");
  }
  const s = text.replace(/\s/g, "");
  if (s.length === 0) throw new DecodeError("The code is empty.");
  const lower = s.slice(0, 16).toLowerCase();
  if (lower.startsWith("bitcoin:")) throw new DecodeError("This is a payment request (a bitcoin: link), not a transaction.");
  if (lower.startsWith("ur:")) throw new DecodeError("This is a UR code (ur:...). Only Electrum's single QR codes are read for now.");

  let encoding = null, out = null;
  if (isHex(s)) {
    encoding = "hex";
    out = fromHex(s);
  } else if (s.startsWith("cHNidP")) {
    try {
      out = fromBase64(s);
      encoding = "base64";
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
    }
  }
  if (encoding === null && isBase43(s)) {
    if (s.length > MAX_BASE43) throw new DecodeError(`The code is too long (${s.length} characters): Electrum reads at most ${MAX_BASE43}.`);
    encoding = "base43";
    out = base43Decode(s);
  }
  if (encoding === null) throw new DecodeError("This code is not a transaction: it is not hex, a PSBT in Base64, or Base43.");
  if (out.length >= 5 && equal(out.subarray(0, 5), OLD_ELECTRUM)) {
    throw new DecodeError("This is a partial transaction from Electrum before 4.0, which is not supported.");
  }
  const kind = isPsbt(out) ? "psbt" : "tx";
  // BBQr ("B$" and a header) is also Base43's alphabet: it is BBQr when it
  // doesn't read as a transaction
  if (kind === "tx" && encoding === "base43" && s.startsWith("B$")) {
    try {
      parseTx(out);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      throw new DecodeError("This is a BBQr code (B$...). Only Electrum's single QR codes are read for now.");
    }
  }
  return { encoding, bytes: out, kind };
}

// The text of a QR code Electrum will load: Base43, all in the QR code's
// alphanumeric mode. A Base43 string that is also valid hex (only digits and
// A-F, even length: unlikely beyond a few bytes) would be read by Electrum
// as hex, so then the hex is given instead (uppercase: still alphanumeric).
export function electrumQrText(bytes) {
  const b43 = base43Encode(bytes);
  if (isHex(b43)) return toHex(bytes).toUpperCase();
  return b43;
}
