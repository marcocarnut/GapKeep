// Extracted from dice39 by tools/extract_dice39.py - do not edit.
// Source: bip39_generator.html (sha256 2761011a95e7b961bfe3a6001df7e6ec4d49106134c19453e49e1364c67357dd), UI block (selected declarations) starting at line 4238.
// dice39 is licensed under the GNU AGPL v3; see apps/dice39/LICENSE-dice39.txt.
// The code between the prelude and the export line is copied verbatim.

import { BIP39_WORDS } from "./wordlist.js";

/* ==================================================================
   Printable dice tables

   Two tables of 1024 words each, split by parity of the word's index in
   the BIP-39 list: Table A holds words 1, 3, 5, … and Table B holds
   2, 4, 6, …. A coin flip picks the table (exactly 1 bit), two pairs of
   dice pick the cell (1296 outcomes). 1296 > 1024, so 272 cells say
   REROLL — rejection is unavoidable, since exact uniformity over 2048
   would need 2^11 | 6^k, i.e. k >= 11 dice.

   Splitting by parity rather than by range does three things: the check
   for a skipped coin becomes one bit of the word index, each table still
   spans abandon…zoo so neither looks like a truncated half-dictionary,
   and the layout is unchanged.

   The REROLL cells sit at floor(i * 1296 / 272) — deterministic, so
   anyone can regenerate these tables from the wordlist and diff them.
   Their positions have no effect on the distribution (every cell is
   equally likely); spreading them evenly only keeps the pages from
   having a dead block at the end.
   ================================================================== */
const TABLE_CELLS = 1296;

const TABLE_WORDS = 1024;

const REROLL_CELLS = TABLE_CELLS - TABLE_WORDS;

const GRID_COLS = 36, GRID_ROWS = 36, COLS_PER_PAGE = 18;

function rerollPositions() {
  const set = new Set();
  for (let i = 0; i < REROLL_CELLS; i++) {
    set.add(Math.floor(i * TABLE_CELLS / REROLL_CELLS));
  }
  return set;
}

// parity 0 -> Table A (even 0-based indices = words 1, 3, 5, …)
// parity 1 -> Table B (odd 0-based indices  = words 2, 4, 6, …)
function buildTableCells(parity) {
  const words = BIP39_WORDS.filter((w, i) => (i & 1) === parity);
  const rerolls = rerollPositions();
  const cells = [];
  let w = 0;
  for (let c = 0; c < TABLE_CELLS; c++) {
    cells.push(rerolls.has(c) ? null : words[w++]);
  }
  if (w !== TABLE_WORDS) throw new Error('table build: placed ' + w + ' words, expected ' + TABLE_WORDS);
  return cells;
}

let diceTablesCache = null;

function diceTable(parity) {
  if (!diceTablesCache) diceTablesCache = [buildTableCells(0), buildTableCells(1)];
  return diceTablesCache[parity];
}

// The very tables the app prints, built once on first use.
/* Did every pair get read smallest-first?

   The printed procedure says the first pair of dice names the column and the
   second names the row, each read LEFT TO RIGHT. Sorting a pair low-to-high
   instead folds 5-3 onto 3-5: fifteen of the thirty-six columns become
   unreachable, mixed pairs get double the weight of doubles, and the words
   that come out are still perfectly valid BIP-39 words. Nothing downstream
   notices — the coin detector only tests parity, and the wordlist-order
   detector only tests the list.

   The word itself gives the cell away. Each word appears once in one table,
   so its position recovers the exact column and row that were looked up: if
   they sorted, the word came off the sorted cell.

   A single pair is non-descending with probability 21/36, so a word is
   sorted-looking with probability (7/12)^2 = 49/144, and N words by chance
   with (49/144)^N — about 1 in 644 at six words, 1 in 400,000 at twelve.
   Reported, never blocking: it is evidence, not proof.

   Both directions are checked. Sorting high-first is the same misreading and
   costs the same bits; only the sentence differs. Where every pair is a
   double both directions hold and neither is evidence of anything, so that
   returns null and the other detectors keep it. */
function sortedPairsSuspected(userWords) {
  let up = true, down = true;
  for (const w of userWords) {
    const idx = BIP39_WORDS.indexOf(w);
    if (idx < 0) return null;
    const at = diceTable(idx & 1).indexOf(w);
    if (at < 0) return null;
    for (const p of [at % GRID_COLS, Math.floor(at / GRID_COLS)]) {
      const first = Math.floor(p / 6), second = p % 6;
      if (first > second) up = false;
      if (first < second) down = false;
    }
    if (!up && !down) return null;
  }
  return (up && down) ? null : (up ? 'up' : 'down');
}

function stripDiceSeparators(v) { return (v || '').replace(/[\s\-_.,]/g, '').toLowerCase(); }

// Returns null for anything that is not a complete dice code, so ordinary
// words fall through this untouched. `parity` is null for the four-dice form,
// which names one cell on each table and so needs the coin to pick between
// them — see diceCandidates.
function parseDiceCode(raw) {
  const m = /^([abht]?)([1-6]{4})$/.exec(stripDiceSeparators(raw));
  if (!m) return null;
  const d = m[2].split('').map(Number);
  return {
    parity: m[1] ? ((m[1] === 'a' || m[1] === 'h') ? 0 : 1) : null,
    col: (d[0] - 1) * 6 + (d[1] - 1),
    row: (d[2] - 1) * 6 + (d[3] - 1),
    dice: d
  };
}

// Half-typed codes are not mistakes, so they must not be flagged as one.
function isPartialDiceCode(raw) {
  return /^[abht]?[1-6]{0,3}$/.test(stripDiceSeparators(raw)) &&
         stripDiceSeparators(raw).length > 0;
}

function diceWordFor(code) {
  return diceTable(code.parity)[code.row * GRID_COLS + code.col];
}

/* ==================================================================
   SeedQR and Compact SeedQR (the SeedSigner conventions)

   Two more encodings of the same secret, for wallets that read those
   and not a line of text: SeedSigner, Krux, and others that followed.

   SeedQR is each word's position in the BIP-39 list, zero-padded to
   four digits and run together, in QR's Numeric mode. The index is
   0-based — "abandon" is 0000 — which is the one detail worth getting
   wrong quietly, so it is checked in seedqrtest.py against the worked
   example in SeedSigner's own documentation, resolved through the
   wordlist this page already bundles.

   Compact SeedQR is the entropy itself in QR's Binary mode, with the
   BIP-39 checksum left off because it is derivable. That is exactly
   what entropyBytes already holds, so there is nothing to recompute
   here and nothing that can drift from what the phrase was built from.

   Both are written at error-correction level L, not the M used
   elsewhere on this page. That is not a corner cut: L is what the
   reference implementation emits, and it is what puts a compact
   24-word code at 25x25 instead of 29x29. The published grids people
   use to transcribe these by hand onto steel are cut to those exact
   sizes, so matching them is a compatibility property, not a
   cosmetic one.
   ================================================================== */
const SEEDQR_ECC = 'L';

function seedQrDigits(words) {
  return words.map(w => {
    const i = BIP39_WORDS.indexOf(w);
    if (i < 0) throw new Error('not a BIP-39 word: ' + w);
    return String(i).padStart(4, '0');
  }).join('');
}

// qrcode-generator's Byte mode runs its input through qrcode.stringToBytes,
// which is the default latin1 truncation (charCodeAt & 0xff). Feeding it a
// string built with fromCharCode therefore passes the bytes through exactly,
// with no UTF-8 expansion — the round-trip is checked in seedqrtest.py.
function compactSeedQrPayload(entropyBytes) {
  let s = '';
  for (let i = 0; i < entropyBytes.length; i++) s += String.fromCharCode(entropyBytes[i]);
  return s;
}

/* ==================================================================
   Seed derivation: CSPRNG baseline + collected screen-interaction entropy
   ================================================================== */
// Four doubles per sample: position, high-resolution timestamp, and the
// wall-clock millisecond. Every sample goes into the hash in full,
// regardless of how conservatively the progress bar scored it.
function samplesToBytes(samples) {
  const arr = new Float64Array(samples.length * 4);
  samples.forEach((s, i) => {
    arr[i * 4] = s.x; arr[i * 4 + 1] = s.y; arr[i * 4 + 2] = s.t; arr[i * 4 + 3] = s.ms;
  });
  return new Uint8Array(arr.buffer);
}

/* Entropy accounting.
   The progress bar used to count raw pointer samples, which meant a mouse
   drifting across the pad — or resting on it while the OS emitted move
   events — filled it without contributing anything unpredictable. We now
   only accept input that a human actually caused, and score it in
   deliberately pessimistic bits:

     - a drag point is credited with the low-order jitter of where the
       finger/cursor landed, and nothing for timing: during a drag, sample
       arrival is paced by the pointer hardware (~8ms here), so the clock
       reading is close to predictable from the previous one;
     - a tap/press is human-initiated, so the wall-clock millisecond it
       lands on is genuinely the user's to choose — worth ~3 bits on its
       own (a millisecond digit is 10 bits if uniform; we claim well under
       that because presses cluster and users have rhythm).

   None of this gates the real security of the seed: crypto.getRandomValues
   supplies a full 32-byte CSPRNG baseline that this material is hashed
   together with. The bar exists so the user contributes *something*
   physical, and so the number it shows isn't a lie. */
const BITS_PER_DRAG_POINT = 1;

const BITS_PER_TAP = 4;

// Far enough apart that a point isn't largely predictable from the previous
// one — a smooth drag sampled every few pixels is mostly its own direction
// repeated, which is what would make the 1-bit credit above a lie.
const MIN_DRAG_DISTANCE_PX = 12;

const MIN_SAMPLE_INTERVAL_MS = 8;

const SAMPLE_CAP = 1200;

export { TABLE_CELLS, TABLE_WORDS, REROLL_CELLS, GRID_COLS, rerollPositions, buildTableCells, diceTable, sortedPairsSuspected, stripDiceSeparators, parseDiceCode, isPartialDiceCode, diceWordFor, SEEDQR_ECC, seedQrDigits, compactSeedQrPayload, samplesToBytes, BITS_PER_DRAG_POINT, BITS_PER_TAP, MIN_DRAG_DISTANCE_PX, MIN_SAMPLE_INTERVAL_MS, SAMPLE_CAP };
