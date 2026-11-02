// Extracted from dice39 by tools/extract_dice39.py - do not edit.
// Source: bip39_generator.html (sha256 9d8f7ba296e81fa3fae05eb1398b94ed00e38148b5014cf350f039f3c8364fe8), core algorithm block starting at line 3223.
// dice39 is licensed under the GNU AGPL v3; see apps/dice39/LICENSE-dice39.txt.
// The code between the prelude and the export line is copied verbatim.

const window = {}, module = undefined;

// Core algorithm for the handmade BIP-39 generator.
// Pure logic, no DOM — testable under Node and reusable verbatim inside the SPA.
//
// Design recap (per spec worked out with the user):
//  - User supplies N words (12<=N<=22), sourced from physical dice + printed tables.
//  - Words are used VERBATIM for positions 1..N.
//  - Words 23 and 24 are ALWAYS device-sourced (CSPRNG mixed with user screen
//    interaction) — capping user input at 22 avoids ever needing a user-guessed
//    word 24 that gets silently checksum-corrected, so there's nothing to explain
//    about a "wrong" final word.
//
// importMnemonic is the other door, and deliberately not the same one: it takes
// a complete 24-word phrase the user already holds, generates nothing, and
// REFUSES a bad checksum instead of correcting it. It exists so an existing
// phrase can be split with codex32 by this page. See its own comment.
//
// Color tags: 'user' (green, verbatim), 'device' (yellow, generator-sourced).

class BitWriter {
  constructor() { this.bits = []; }
  push(value, nBits) {
    for (let i = nBits - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
  toBytes() {
    if (this.bits.length % 8 !== 0) {
      throw new Error('BitWriter: bit length not a multiple of 8 (' + this.bits.length + ')');
    }
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= (1 << (7 - (i & 7)));
    }
    return out;
  }
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  read(nBits) {
    let v = 0;
    for (let i = 0; i < nBits; i++) {
      const byteIdx = this.pos >> 3;
      if (byteIdx >= this.bytes.length) {
        throw new Error('BitReader: ran out of bits (need ' + nBits + ' more, have none left)');
      }
      const bit = (this.bytes[byteIdx] >> (7 - (this.pos & 7))) & 1;
      v = (v << 1) | bit;
      this.pos++;
    }
    return v >>> 0;
  }
  bitsRemaining() { return this.bytes.length * 8 - this.pos; }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// Expand a 32-byte seed into `neededBits` of pseudorandom material via
// iterated SHA-256 (simple HKDF-like expand: block_i = SHA256(seed || i)).
async function deriveKeystream(seed, neededBits) {
  const neededBytes = Math.ceil(neededBits / 8);
  const blocks = [];
  let have = 0;
  let counter = 0;
  while (have < neededBytes) {
    const ctr = new Uint8Array([counter & 0xff]);
    const block = await sha256(concatBytes(seed, ctr));
    blocks.push(block);
    have += block.length;
    counter++;
  }
  return concatBytes(...blocks).slice(0, neededBytes);
}

/* BIP-39 sizes. A phrase of T words carries T*32/3 bits of entropy followed by
   a checksum of entropy/32 bits, and the two always add up to 11*T:

     T=24  ->  256 entropy + 8 checksum = 264 = 11*24   last word: 3 + 8
     T=12  ->  128 entropy + 4 checksum = 132 = 11*12   last word: 7 + 4

   The last word is the only one that straddles the boundary, and how it
   straddles differs between the two: at 24 words it is 3 entropy bits then 8
   of checksum, at 12 it is 7 then 4. Everything below reads those numbers off
   this table rather than spelling them out, because the pair that is easy to
   transpose is exactly the pair that produces a valid-looking wrong phrase. */
const PHRASE_SIZES = {
  12: { total: 12, entropyBits: 128, checksumBits: 4, entropyBytes: 16, minUser: 6,  maxUser: 10 },
  24: { total: 24, entropyBits: 256, checksumBits: 8, entropyBytes: 32, minUser: 12, maxUser: 22 }
};

function phraseSize(total) {
  const spec = PHRASE_SIZES[total];
  if (!spec) throw new Error('unsupported phrase length: ' + total);
  return spec;
}

// wordlist: array of 2048 BIP-39 words (index-ordered, as per the spec).
// userWords: array of exactly N strings (already validated to be in wordlist),
//            N between minUser and maxUser for the chosen length. The last two
//            words are ALWAYS device-sourced — capping user input two short of
//            the total means there is never a case where a user-guessed final
//            word gets silently checksum-corrected, so there's nothing to
//            explain about a word coming back different from what was typed.
// seedBytes: 32-byte seed for the device-entropy stream (already mixed from
//            CSPRNG + screen interaction by the caller).
// total:     12 or 24. Defaults to 24, so callers predating 12-word support
//            keep the behaviour they were written against.
// Returns: { finalWords: string[T], sourceTags: string[T], userBits, deviceBits }
async function buildMnemonic(wordlist, userWords, seedBytes, total) {
  const spec = phraseSize(total || 24);
  const T = spec.total;
  const N = userWords.length;
  if (N < spec.minUser || N > spec.maxUser) {
    throw new Error('N must be between ' + spec.minUser + ' and ' + spec.maxUser +
                    ' for a ' + T + '-word phrase, got ' + N);
  }

  const wordIndex = new Map(wordlist.map((w, i) => [w, i]));
  for (const w of userWords) {
    if (!wordIndex.has(w)) throw new Error('Not a BIP-39 word: "' + w + '"');
  }

  const userBits = 11 * N;
  const deviceBits = spec.entropyBits - userBits; // always > 0, since N <= maxUser

  const keystream = await deriveKeystream(seedBytes, deviceBits);
  const reader = new BitReader(keystream);

  const writer = new BitWriter();
  const wordIndices = new Array(T).fill(null);
  const sourceTags = new Array(T).fill(null);

  // Positions 0..N-1: user words, verbatim.
  for (let i = 0; i < N; i++) {
    const idx = wordIndex.get(userWords[i]);
    writer.push(idx, 11);
    wordIndices[i] = idx;
    sourceTags[i] = 'user';
  }

  // Positions N..T-2 (the second-to-last word at most): full 11-bit device words.
  for (let i = N; i < T - 1; i++) {
    const idx = reader.read(11);
    writer.push(idx, 11);
    wordIndices[i] = idx;
    sourceTags[i] = 'device';
  }

  // Last position: the remaining device entropy bits, then the checksum.
  const tailBits = 11 - spec.checksumBits;   // 3 at 24 words, 7 at 12
  const tail = reader.read(tailBits);
  writer.push(tail, tailBits);
  sourceTags[T - 1] = 'device';

  const entropyBytes = writer.toBytes();     // exactly spec.entropyBytes long
  const hash = await sha256(entropyBytes);
  // The checksum is the TOP checksumBits of SHA256(entropy): 8 bits is the
  // whole first byte, 4 bits is its high nibble, not its low one.
  const checksum = hash[0] >> (8 - spec.checksumBits);

  wordIndices[T - 1] = (tail << spec.checksumBits) | checksum;

  const finalWords = wordIndices.map(idx => wordlist[idx]);

  // Printed Table A holds the even-indexed words, Table B the odd ones, and a
  // coin flip picks between them per word. A user who skipped the coin and
  // read every word off one table produces words that all share a parity —
  // a 1-in-2^(N-1) coincidence if the coin really was flipped, so this is
  // close to a certain detector for the one mistake the procedure invites.
  // It costs 1 bit per word, so it is worth telling them about; never block.
  const userParity = userWords.map(w => wordIndex.get(w) & 1);
  const singleTable = userParity.every(b => b === userParity[0]);

  // Two shapes dice do not produce, flagged for the same reason as the coin
  // check: they mean the boxes were filled in by hand, not thrown.
  //
  // These are mistake detectors, not entropy estimates. Nothing here scores a
  // phrase — a score would only invite rerolling until the number looked
  // good, and rerolling on the strength of the output is exactly what turns a
  // uniform draw into a biased one.
  //
  // Both are far more conservative than the coin check. All-N-identical needs
  // no argument. Strictly ordered indices happen with probability ~1/N! per
  // direction, i.e. under 1 in 100 million even at the minimum N = 12, and
  // ~1 in 6e20 at N = 22 — against 1 in 2048 for the coin detector at N = 12.
  const userIdx = userWords.map(w => wordIndex.get(w));
  const allSame = userIdx.every(i => i === userIdx[0]);
  const nonDecreasing = userIdx.every((v, i) => i === 0 || v >= userIdx[i - 1]);
  const nonIncreasing = userIdx.every((v, i) => i === 0 || v <= userIdx[i - 1]);
  const patternSuspected = allSame ? 'identical'
    : (nonDecreasing || nonIncreasing) ? 'ordered' : null;

  return {
    finalWords, sourceTags, userBits, deviceBits, entropyBytes,
    coinSkipSuspected: singleTable,
    coinSkipTable: singleTable ? (userParity[0] === 0 ? 'A' : 'B') : null,
    patternSuspected: patternSuspected,
    patternDirection: patternSuspected === 'ordered'
      ? (nonDecreasing ? 'up' : 'down') : null
  };
}

// A phrase the user already has, taken as-is so the rest of the page (and in
// particular the codex32 split) can work on it. Nothing is generated here.
//
// The checksum is RECOMPUTED from the first 256 bits and compared, and a
// mismatch is refused rather than repaired. buildMnemonic can afford to write
// the correct final word because it owns the entropy; here the 24 words are
// evidence about a phrase that already exists somewhere else, so a silent
// correction would hand back a DIFFERENT wallet from the one being imported
// and the split would be of a seed that secures nothing.
//
// The 8-bit checksum still passes roughly 1 mistyped phrase in 256, so this
// catches most typos and proves nothing on its own. It is a typo check, not
// an assurance that the phrase is the one the user meant.
//
// words: exactly 24 strings from the wordlist.
// Returns the same shape as buildMnemonic, plus imported: true.
async function importMnemonic(wordlist, words) {
  // The length decides the arithmetic, so it is read off the phrase rather
  // than assumed: 12 and 24 differ in where the last word stops being entropy
  // and starts being checksum, and using the wrong split silently produces a
  // different wallet from a phrase that looks perfectly valid.
  if (!PHRASE_SIZES[words.length]) {
    throw new Error('an imported phrase must be 12 or 24 words, got ' + words.length);
  }
  const spec = phraseSize(words.length);
  const T = spec.total;
  const wordIndex = new Map(wordlist.map((w, i) => [w, i]));
  for (const w of words) {
    if (!wordIndex.has(w)) throw new Error('Not a BIP-39 word: "' + w + '"');
  }
  const idx = words.map(w => wordIndex.get(w));

  // The last word is the split point: its top (11 - checksumBits) bits are the
  // last of the entropy, its bottom checksumBits are the checksum.
  const tailBits = 11 - spec.checksumBits;
  const writer = new BitWriter();
  for (let i = 0; i < T - 1; i++) writer.push(idx[i], 11);
  writer.push(idx[T - 1] >>> spec.checksumBits, tailBits);
  const entropyBytes = writer.toBytes(); // exactly spec.entropyBytes long

  const hash = await sha256(entropyBytes);
  const want = hash[0] >> (8 - spec.checksumBits);
  const got = idx[T - 1] & ((1 << spec.checksumBits) - 1);
  if (got !== want) {
    const err = new Error('BIP-39 checksum mismatch');
    err.code = 'CHECKSUM';
    throw err;
  }

  // The same two shapes buildMnemonic flags, for a different reason: a phrase
  // in wordlist order that still passes the checksum is not a suspicious
  // throw, it is a published test vector. Reported separately so the wording
  // can say so -- see importPatternWarnHtml.
  const allSame = idx.every(v => v === idx[0]);
  const nonDecreasing = idx.every((v, i) => i === 0 || v >= idx[i - 1]);
  const nonIncreasing = idx.every((v, i) => i === 0 || v <= idx[i - 1]);

  return {
    finalWords: words.slice(),
    sourceTags: new Array(T).fill('user'),
    userBits: spec.entropyBits,
    deviceBits: 0,
    entropyBytes,
    imported: true,
    // The dice-shaped detectors cannot apply to a phrase that was never
    // thrown, and their wording says "dice do not do that". Off, explicitly.
    coinSkipSuspected: false,
    coinSkipTable: null,
    patternSuspected: null,
    patternDirection: null,
    importPatternSuspected: allSame || nonDecreasing || nonIncreasing
  };
}

const BIP39CORE_EXPORTS = { BitWriter, BitReader, sha256, concatBytes, deriveKeystream, buildMnemonic, importMnemonic, PHRASE_SIZES, phraseSize };

if (typeof module !== 'undefined') {
  module.exports = BIP39CORE_EXPORTS;
}
if (typeof window !== 'undefined') {
  window.BIP39CORE = BIP39CORE_EXPORTS;
}


export { BitWriter, BitReader, sha256, concatBytes, deriveKeystream,
  buildMnemonic, importMnemonic, PHRASE_SIZES, phraseSize };
