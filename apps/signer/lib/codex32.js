// codex32 (BIP-93) share checking and recombination, for any zerogap app.
//
// Pure: no zg:* module, no globals, no I/O, so it runs unchanged in an app,
// under Node (tests/codex32/run_node.mjs) and in a future signer. The
// arithmetic is dice39's own code (../vendor/codex32.js, copied verbatim by
// tools/extract_codex32.py); this file adds what a keyboard needs on top:
// errors that name the share and the character, the current BIP-93 length
// rule, and a suggested fix for a single mistyped character.
//
//   recoverSeed(["ms12name...", "ms12name..."])  -> Uint8Array
//   recover(shares)       -> { seed, secret, id, threshold, indices, ... }
//   checkShare(text)      -> { ok: true, share } or { ok: false, error }
//   checkShareSet(shares) -> null, or the first problem across the shares
//
// Errors are Codex32Error: `code` (below), `message` (English), and fields
// for the details (`share`, `position`, `suggestion`, ...). Positions count
// from 1 at the "m" of "ms1", spaces left out.
//
// What the seed is: BIP-93 calls it the BIP-32 master seed. Shares made by
// dice39 carry BIP-39 entropy instead (16 or 32 bytes, which dice39 turns
// back into words). The bytes are the same either way; which meaning they
// have is the caller's to decide (see the app's README).
//
// None of these functions log. Messages hold positions and characters of
// the text they were given, never a whole share or the seed.

import {
  CX_CHARSET, CX_SECRET_INDEX, MS32_CONST, MS32_LONG_CONST, MS32_GEN, MS32_LONG_GEN, BECH32_INV, bech32Mul,
  ms32Polymod, ms32LongPolymod, cxDecode, cxSeedFromData, cxRecover,
} from "../vendor/codex32.js";

export { CX_CHARSET };

// BIP-93 (current revision): the only legal string lengths, and the seed
// size each carries. dice39's cxDecode predates this rule and accepts any
// 16..64-byte payload, so it is checked here first.
export const SHARE_LENGTHS = Object.freeze({ 48: 16, 54: 20, 61: 24, 67: 28, 74: 32, 127: 64 });
const LENGTHS = Object.keys(SHARE_LENGTHS).map(Number);

// Characters that are not bech32, and what they are usually a misreading of
// (BIP-93's own suggestions: B -> 8, O -> 0, I -> l; and 1, which only
// appears in the prefix, for l).
const LOOKALIKES = { b: "8", o: "0", i: "l", "1": "l" };

export class Codex32Error extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "Codex32Error";
    this.code = code;
    Object.assign(this, details);
  }
}

// Spaces, tabs and line breaks are ignored: printed shares are often
// grouped in fours, and people type them that way.
export function normalizeShare(text) {
  return String(text == null ? "" : text).replace(/\s+/g, "");
}

const quote = (c) => `'${c}'`;

// Checks one share (or an unshared secret). Never throws for bad input.
// options.suggest = false skips the search for a mistyped character (for
// checks while typing, where nobody reads the answer).
export function checkShare(text, options) {
  try {
    return { ok: true, share: parseShare(text, options) };
  } catch (e) {
    if (e instanceof Codex32Error) return { ok: false, error: e };
    throw e;
  }
}

// Parses one share; throws Codex32Error. The share:
//   string      canonical lowercase form
//   threshold   k as a number (0 for an unshared secret)
//   thresholdChar, id (4 characters), index (one character, "s" for the secret)
//   isSecret    index is "s": the string is the secret itself
//   seedBytes   the size of the seed it carries
export function parseShare(text, options) {
  const suggest = !options || options.suggest !== false;
  const s = normalizeShare(text);
  if (!s) throw new Codex32Error("empty", "Nothing typed.");
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) {
    throw new Codex32Error("case", "Upper and lower case are mixed: type it all in capitals, or all in small letters.");
  }
  const low = s.toLowerCase();
  if (!low.startsWith("ms1")) {
    // a prefix still being typed is not wrong yet
    const partial = "ms1".startsWith(low);
    throw new Codex32Error("prefix", partial ? "A share starts with MS1." :
      "This does not start with MS1, as every codex32 share does.", { partial });
  }
  const bad = [];
  for (let i = 3; i < low.length; i++) if (CX_CHARSET.indexOf(low[i]) < 0) bad.push(i);
  if (bad.length) {
    const i = bad[0];
    const c = s[i];
    const like = LOOKALIKES[low[i]];
    const details = { position: i + 1, char: c, count: bad.length };
    let msg = `Character ${i + 1} is ${quote(c)}, which codex32 does not use` +
      (like ? ` (perhaps ${quote(caseAs(like, s))}?).` : ".");
    if (bad.length > 1) msg += ` ${bad.length - 1} more character${bad.length > 2 ? "s are" : " is"} not codex32 either.`;
    // one unreadable character in a share of the right length: the checksum
    // can tell what it was (BIP-93: suggest, never use it unconfirmed)
    if (suggest && bad.length === 1 && SHARE_LENGTHS[low.length]) {
      const fix = fillErasure(low, i);
      if (fix) {
        details.suggestion = caseAs(fix, s);
        msg = `Character ${i + 1} is ${quote(c)}, which codex32 does not use. ` +
          `${quote(details.suggestion)} there makes the checksum valid: check it against the paper.`;
      }
    }
    throw new Codex32Error("char", msg, details);
  }
  if (!SHARE_LENGTHS[low.length]) {
    const n = low.length;
    const longer = LENGTHS.find((l) => l > n);
    const shorter = [...LENGTHS].reverse().find((l) => l < n);
    const chars = (k) => `${k} character${k === 1 ? "" : "s"}`;
    const hints = [];
    if (longer) hints.push(`${chars(longer - n)} short of ${longer}`);
    if (shorter) hints.push(`${chars(n - shorter)} over ${shorter}`);
    throw new Codex32Error("length",
      `This has ${n} characters; a share has 48, 54, 61, 67, 74 or 127 (this is ${hints.join(", or ")}).`,
      { length: n, shortBy: longer ? longer - n : null, overBy: shorter ? n - shorter : null });
  }
  const t = low[3];
  if ("023456789".indexOf(t) < 0) {
    throw new Codex32Error("threshold",
      `Character 4 is the threshold: ${quote(s[3])} is not 0 or 2 to 9.`, { position: 4, char: s[3] });
  }
  if (t === "0" && low[8] !== "s") {
    throw new Codex32Error("threshold0",
      `Threshold 0 means an unshared secret, whose index (character 9) must be S, not ${quote(s[8])}.`,
      { position: 9, char: s[8] });
  }
  let dec;
  try {
    dec = cxDecode(low);
  } catch (e) {
    if (e && e.message === "checksum failed") {
      const fix = suggest ? findSubstitution(low) : null;
      const details = {};
      let msg = "The checksum does not match: a character is mistyped.";
      if (fix) {
        details.position = fix.position;
        details.char = s[fix.position - 1];
        details.suggestion = caseAs(fix.char, s);
        msg = `The checksum does not match. Most likely character ${fix.position} is mistyped: ` +
          `${quote(details.suggestion)} there instead of ${quote(details.char)} makes it valid. ` +
          "Check it against the paper.";
      } else {
        msg += " More than one is wrong, or one is missing and another is extra.";
      }
      throw new Codex32Error("checksum", msg, details);
    }
    throw new Codex32Error("invalid", "Not a valid share: " + (e && e.message ? e.message : e) + ".");
  }
  return {
    string: low,
    threshold: t === "0" ? 0 : Number(t),
    thresholdChar: dec.thresholdChar,
    id: dec.id,
    index: dec.indexChar,
    isSecret: dec.index === CX_SECRET_INDEX,
    seedBytes: dec.seedBytes,
  };
}

function caseAs(c, like) {
  return like === like.toUpperCase() && like !== like.toLowerCase() ? c.toUpperCase() : c;
}

// --- finding a mistyped character -----------------------------------------
//
// The checksum residue is linear over GF(32): XOR-ing e into data symbol p
// (of n) changes the residue by e * R_p, where R_p is x^(n-1-p) modulo the
// generator g, as 13 (or 15) GF(32) symbols. So, walking p from the end,
// R_p takes one multiplication by x per step, and the change that a single
// substitution needs (the syndrome S) gives e = S_j / R_p,j at any nonzero
// symbol j, to be checked on the others. All in small numbers: no BigInt in
// the loop (QuickJS's BigInt is slow on a Pi Zero).

const SYMBOLS = (big, count) => {
  const out = [];
  for (let j = count - 1; j >= 0; j--) out.push(Number((big >> BigInt(5 * j)) & 31n));
  return out;   // most significant symbol first
};
const GEN_SYMBOLS = { 13: SYMBOLS(MS32_GEN[0], 13), 15: SYMBOLS(MS32_LONG_GEN[0], 15) };

function checksumKind(n) {
  // as vendor ms32VerifyChecksum: the long code from 96 symbols up
  return n >= 96
    ? { polymod: ms32LongPolymod, target: MS32_LONG_CONST, size: 15 }
    : { polymod: ms32Polymod, target: MS32_CONST, size: 13 };
}

// Calls fn(p, e) for each data position p, last first, with the e that a
// change at p alone would need to fix the checksum (0 when no change is
// needed), or with -1 when no change at p can. fn returns false to stop.
function walkFixes(data, fn) {
  const k = checksumKind(data.length);
  const syndrome = SYMBOLS(k.polymod(data) ^ k.target, k.size);
  const g = GEN_SYMBOLS[k.size];
  const r = new Array(k.size).fill(0);
  r[k.size - 1] = 1;                       // x^0
  for (let p = data.length - 1; p >= 0; p--) {
    let e = 0, j = 0;
    while (j < k.size && r[j] === 0) j++;
    e = bech32Mul(syndrome[j], BECH32_INV[r[j]]);
    for (let i = 0; i < k.size && e >= 0; i++) if (bech32Mul(e, r[i]) !== syndrome[i]) e = -1;
    if (fn(p, e) === false) return;
    // r *= x (mod g)
    const top = r[0];
    for (let i = 0; i < k.size - 1; i++) r[i] = r[i + 1] ^ bech32Mul(top, g[i]);
    r[k.size - 1] = bech32Mul(top, g[k.size - 1]);
  }
}

function dataOf(low) {
  const data = [];
  for (const c of low.slice(3)) data.push(CX_CHARSET.indexOf(c));
  return data;
}

// One substituted character that makes the checksum valid: { position, char }
// (position counted from 1 over the whole string), or null. The code is
// distance 9: two different single substitutions can never both fit, so a
// hit is the only one-character fix there is.
export function findSubstitution(text) {
  const low = normalizeShare(text).toLowerCase();
  if (!low.startsWith("ms1")) return null;
  const data = dataOf(low);
  if (data.some((v) => v < 0)) return null;
  const hits = [];
  walkFixes(data, (p, e) => { if (e > 0) hits.push({ p, v: data[p] ^ e }); });
  if (hits.length !== 1) return null;
  const fixed = data.slice();
  fixed[hits[0].p] = hits[0].v;
  if (!headerOk(fixed)) return null;
  return { position: hits[0].p + 4, char: CX_CHARSET[hits[0].v] };
}

// The character at string index i (not bech32) as the checksum says it must
// be, or null.
function fillErasure(low, i) {
  const data = dataOf(low).map((v) => Math.max(0, v));
  const p = i - 3;
  data[p] = 0;
  let found = -1;
  walkFixes(data, (q, e) => {
    if (q !== p) return true;
    found = e;
    return false;
  });
  if (found < 0) return null;
  data[p] = found;
  return headerOk(data) ? CX_CHARSET[found] : null;
}

function headerOk(data) {
  const t = CX_CHARSET[data[0]];
  return "023456789".indexOf(t) >= 0 && !(t === "0" && data[5] !== CX_SECRET_INDEX);
}

// --- sets of shares -------------------------------------------------------

const need = (share) => (share.threshold === 0 ? 1 : share.threshold);

// The first problem with a list of parsed shares as a set, or null. Each
// share is compared with the first: { code, message, share (1-based) }.
export function checkShareSet(shares) {
  if (!shares.length) return new Codex32Error("none", "Type at least one share.");
  const a = shares[0];
  for (let i = 1; i < shares.length; i++) {
    const b = shares[i];
    if (b.id !== a.id || b.threshold !== a.threshold) {
      return new Codex32Error("mismatch",
        `Share ${i + 1} belongs to a different split (${b.id.toUpperCase()}, threshold ${b.thresholdChar}) ` +
        `than share 1 (${a.id.toUpperCase()}, threshold ${a.thresholdChar}).`, { share: i + 1 });
    }
    if (b.string.length !== a.string.length) {
      return new Codex32Error("lengths",
        `Share ${i + 1} is ${b.string.length} characters long and share 1 ${a.string.length}: ` +
        "the shares of one split are all the same length.", { share: i + 1 });
    }
    for (let j = 0; j < i; j++) {
      if (shares[j].index === b.index) {
        return new Codex32Error("duplicate",
          `Shares ${j + 1} and ${i + 1} are the same share (index ${b.index.toUpperCase()}).`,
          { share: i + 1, other: j + 1 });
      }
    }
  }
  if (shares.length === 1 && a.isSecret) return null;   // the secret itself
  if (shares.length !== need(a)) {
    const k = need(a);
    return new Codex32Error("count",
      `These shares have threshold ${k}: exactly ${k} are needed, and there ${shares.length === 1 ? "is" : "are"} ` +
      `${shares.length}.`, { need: k, have: shares.length });
  }
  return null;
}

// Recombines shares (strings) into the secret. Throws Codex32Error, with
// `share` (1-based) when one share is the problem. Returns
//   seed       Uint8Array: the master secret's bytes (the caller zeroes it)
//   secret     the codex32 secret string (index s), lowercase
//   id, threshold, thresholdChar
//   indices    the share indices used, as typed order
export function recover(shareTexts) {
  const texts = shareTexts.map(normalizeShare).filter(Boolean);
  const shares = texts.map((t, i) => {
    try {
      return parseShare(t);
    } catch (e) {
      if (!(e instanceof Codex32Error)) throw e;
      e.share = i + 1;
      e.message = `Share ${i + 1}: ${e.message}`;
      throw e;
    }
  });
  const problem = checkShareSet(shares);
  if (problem) throw problem;

  let seed, secret;
  if (shares.length === 1) {
    // An unshared secret (threshold 0, as BIP-93 test vector 1) or the
    // secret of a split typed on its own. Not through cxRecover: it
    // interpolates even a single share, and with one point Lagrange
    // interpolation is all zeros, so it fails "checksum failed" on every
    // threshold-0 string (dice39 bug, see README). Decoding is all it takes.
    secret = shares[0].string;
    seed = cxSeedFromData(cxDecode(secret));
  } else {
    let r;
    try {
      r = cxRecover(shares.map((s) => s.string));
    } catch (e) {
      throw new Codex32Error("recover", "Could not recover: " + (e && e.message ? e.message : e) + ".");
    }
    seed = r.seed;
    secret = r.string;
  }
  if (!Object.values(SHARE_LENGTHS).includes(seed.length)) {
    seed.fill(0);
    throw new Codex32Error("size", `The secret has ${seed.length} bytes, which BIP-93 does not allow.`);
  }
  return {
    seed,
    secret,
    id: shares[0].id,
    threshold: shares[0].threshold,
    thresholdChar: shares[0].thresholdChar,
    indices: shares.map((s) => s.index),
  };
}

// The entry point for other apps: the master secret's bytes, or a thrown
// Codex32Error. The caller owns the array and should fill(0) it when done.
export function recoverSeed(shareTexts) {
  return recover(shareTexts).seed;
}
