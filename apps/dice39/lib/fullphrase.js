// dice39 on GapKeep: all the words from the dice (not on dice39's page).
//
// dice39 caps the dice words at two short of the phrase, so the device
// always supplies the last words and a typed final word is never changed.
// Here the person may also type every word, to split a phrase made
// entirely of their own throws: the first T-1 words are used verbatim, and
// so are the last word's top (11 - checksumBits) bits; its checksum bits
// are recomputed. If they already match, the phrase is used exactly as
// typed; if not, only the last word changes (to the one word that keeps its
// entropy bits and has the right checksum). No device entropy.
//
// Result: the shape of dice39's buildMnemonic, with deviceBits 0, every
// sourceTag "user" but the last one's "checksum" when it changed, and
// lastTyped (the word typed last) and corrected.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { BitWriter, PHRASE_SIZES, sha256 } from "../vendor/bip39core.js";

export async function fullMnemonic(wordlist, words) {
  const spec = PHRASE_SIZES[words.length];
  if (!spec) throw new Error("a phrase must be " + Object.keys(PHRASE_SIZES).join(", ") + " words, got " + words.length);
  const T = spec.total;
  const wordIndex = new Map(wordlist.map((w, i) => [w, i]));
  for (const w of words) {
    if (!wordIndex.has(w)) throw new Error('Not a BIP-39 word: "' + w + '"');
  }
  const idx = words.map((w) => wordIndex.get(w));

  const writer = new BitWriter();
  for (let i = 0; i < T - 1; i++) writer.push(idx[i], 11);
  const tail = idx[T - 1] >>> spec.checksumBits;
  writer.push(tail, 11 - spec.checksumBits);
  const entropyBytes = writer.toBytes();
  const hash = await sha256(entropyBytes);
  const last = (tail << spec.checksumBits) | (hash[0] >> (8 - spec.checksumBits));

  const finalWords = words.slice();
  finalWords[T - 1] = wordlist[last];
  const corrected = last !== idx[T - 1];
  const sourceTags = new Array(T).fill("user");
  if (corrected) sourceTags[T - 1] = "checksum";

  // dice39's mistake detectors (buildMnemonic's), over the words as typed
  const parity = idx.map((v) => v & 1);
  const singleTable = parity.every((b) => b === parity[0]);
  const allSame = idx.every((v) => v === idx[0]);
  const up = idx.every((v, i) => i === 0 || v >= idx[i - 1]);
  const down = idx.every((v, i) => i === 0 || v <= idx[i - 1]);
  const patternSuspected = allSame ? "identical" : (up || down) ? "ordered" : null;

  return {
    finalWords, sourceTags, userBits: spec.entropyBits, deviceBits: 0, entropyBytes,
    full: true, corrected, lastTyped: words[T - 1],
    coinSkipSuspected: singleTable,
    coinSkipTable: singleTable ? (parity[0] === 0 ? "A" : "B") : null,
    patternSuspected,
    patternDirection: patternSuspected === "ordered" ? (up ? "up" : "down") : null,
  };
}
