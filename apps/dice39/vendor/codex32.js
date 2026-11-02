// Extracted from dice39 by tools/extract_dice39.py - do not edit.
// Source: bip39_generator.html (sha256 9d8f7ba296e81fa3fae05eb1398b94ed00e38148b5014cf350f039f3c8364fe8), codex32 block starting at line 3527.
// dice39 is licensed under the GNU AGPL v3; see apps/dice39/LICENSE-dice39.txt.
// The code between the prelude and the export line is copied verbatim.

const window = {};

/* codex32 (BIP-93) — GF(32) Shamir over the bech32 alphabet.
   Constants and algorithms transcribed from the BIP-93 reference
   implementation; verified against its published test vectors. */

const CX_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CX_SECRET_INDEX = 16;              // charset position of 's'

const MS32_CONST      = 0x10ce0795c2fd1e62an;
const MS32_LONG_CONST = 0x43381e570bf4798ab26n;

const MS32_GEN = [
  0x19dc500ce73fde210n, 0x1bfae00def77fe529n, 0x1fbd920fffe7bee52n,
  0x1739640bdeee3fdadn, 0x07729a039cfc75f5an
];
const MS32_LONG_GEN = [
  0x3d59d273535ea62d897n, 0x7a9becb6361c6c51507n, 0x543f9b7e6c38d8a2a0en,
  0x0c577eaeccf1990d13cn, 0x1887f74f8dc71b10651n
];

const BECH32_INV = [
  0, 1, 20, 24, 10, 8, 12, 29, 5, 11, 4, 9, 6, 28, 26, 31,
  22, 18, 17, 23, 2, 25, 16, 19, 3, 21, 14, 30, 13, 7, 27, 15
];

function ms32Polymod(values) {
  let residue = 0x23181b3n;
  for (const v of values) {
    const b = residue >> 60n;
    residue = ((residue & 0x0fffffffffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0n; i < 5n; i++) if ((b >> i) & 1n) residue ^= MS32_GEN[Number(i)];
  }
  return residue;
}

function ms32LongPolymod(values) {
  let residue = 0x23181b3n;
  for (const v of values) {
    const b = residue >> 70n;
    residue = ((residue & 0x3fffffffffffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0n; i < 5n; i++) if ((b >> i) & 1n) residue ^= MS32_LONG_GEN[Number(i)];
  }
  return residue;
}

function ms32VerifyChecksum(data) {
  if (data.length >= 96) return ms32LongPolymod(data) === MS32_LONG_CONST;
  if (data.length <= 93) return ms32Polymod(data) === MS32_CONST;
  return false;
}

function ms32CreateChecksum(data) {
  if (data.length > 80) {
    const pm = ms32LongPolymod(data.concat(new Array(15).fill(0))) ^ MS32_LONG_CONST;
    return Array.from({ length: 15 }, (_, i) => Number((pm >> (5n * BigInt(14 - i))) & 31n));
  }
  const pm = ms32Polymod(data.concat(new Array(13).fill(0))) ^ MS32_CONST;
  return Array.from({ length: 13 }, (_, i) => Number((pm >> (5n * BigInt(12 - i))) & 31n));
}

/* ---- GF(32) arithmetic and Lagrange interpolation ---- */

function bech32Mul(a, b) {
  let res = 0;
  for (let i = 0; i < 5; i++) {
    if ((b >> i) & 1) res ^= a;
    a *= 2;
    if (a >= 32) a ^= 41;
  }
  return res;
}

function bech32Lagrange(l, x) {
  let n = 1;
  const c = [];
  for (const i of l) {
    n = bech32Mul(n, i ^ x);
    let m = 1;
    for (const j of l) m = bech32Mul(m, (i === j ? x : i) ^ j);
    c.push(m);
  }
  return c.map(ci => bech32Mul(n, BECH32_INV[ci]));
}

// `shares` are full data arrays: [threshold, id0..id3, index, ...payload, ...checksum]
function ms32Interpolate(shares, x) {
  const w = bech32Lagrange(shares.map(s => s[5]), x);
  const out = [];
  for (let i = 0; i < shares[0].length; i++) {
    let n = 0;
    for (let j = 0; j < shares.length; j++) n ^= bech32Mul(w[j], shares[j][i]);
    out.push(n);
  }
  return out;
}

/* ---- string <-> data ---- */

function cxEncode(data) {
  return 'ms1' + data.map(v => CX_CHARSET[v]).join('');
}

function cxDecode(str) {
  const s = String(str).trim();
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) throw new Error('mixed case');
  const low = s.toLowerCase();
  if (!low.startsWith('ms1')) throw new Error('missing ms1 prefix');
  const body = low.slice(3);
  const data = [];
  for (const ch of body) {
    const v = CX_CHARSET.indexOf(ch);
    if (v < 0) throw new Error('character not in bech32 alphabet: ' + ch);
    data.push(v);
  }
  if (data.length < 45) throw new Error('too short');
  if (!ms32VerifyChecksum(data)) throw new Error('checksum failed');
  const threshold = data[0];
  const index = data[5];
  // The threshold character is a digit: '0' for an unshared secret, or '2'..'9'.
  // Without this, strings like ms1faux… decode happily on a valid checksum.
  if ('023456789'.indexOf(CX_CHARSET[threshold]) < 0) {
    throw new Error('threshold must be 0 or 2-9, got ' + CX_CHARSET[threshold]);
  }
  if (CX_CHARSET[threshold] === '0' && index !== CX_SECRET_INDEX) {
    throw new Error("threshold 0 requires share index 's'");
  }
  const payload = data.slice(6, data.length - (data.length >= 96 ? 15 : 13));
  // A payload length is only legal if it encodes a whole 16..64-byte seed with
  // an incomplete final group of at most 4 bits. Checking here rather than at
  // seed extraction means a mis-length share is rejected even by callers that
  // only interpolate.
  const bits = payload.length * 5;
  const bytes = Math.floor(bits / 8);
  if (bits - bytes * 8 > 4) throw new Error('payload leaves an incomplete group larger than 4 bits');
  if (bytes < 16 || bytes > 64) throw new Error('seed length out of range: ' + bytes + ' bytes');

  return {
    data: data,
    threshold: threshold,
    thresholdChar: CX_CHARSET[threshold],
    id: data.slice(1, 5).map(v => CX_CHARSET[v]).join(''),
    index: index,
    indexChar: CX_CHARSET[index],
    payload: payload,
    seedBytes: bytes
  };
}

/* ---- bit conversion ---- */

// bytes -> bech32 symbols, zero-padding any incomplete final group.
function toBase32(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of bytes) {
    if (v < 0 || v > 255) throw new Error('byte out of range');
    acc = ((acc << 8) | v) & 0xfff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

// bech32 symbols -> bytes. BIP-93: "Any incomplete group at the end MUST be
// 4 bits or less, and is discarded" — and, unlike BIP-173, it is explicitly
// NOT required to be zero. Test vector 1 has padding bits of 0b10, so a
// zero-padding check here would reject a string the spec calls valid.
function fromBase32(values) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of values) {
    if (v < 0 || v > 31) throw new Error('symbol out of range');
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  if (bits > 4) throw new Error('incomplete group larger than 4 bits');
  return out;
}

/* ---- public operations ---- */

// The unshared secret: threshold digit, identifier, index 's', seed, checksum.
function cxSecretString(seedBytes, thresholdChar, id) {
  const t = CX_CHARSET.indexOf(thresholdChar);
  if (t < 0) throw new Error('bad threshold char');
  const idv = [...id].map(c => {
    const v = CX_CHARSET.indexOf(c);
    if (v < 0) throw new Error('identifier must be bech32 characters');
    return v;
  });
  if (idv.length !== 4) throw new Error('identifier must be 4 characters');
  if (seedBytes.length < 16 || seedBytes.length > 64) throw new Error('seed must be 16..64 bytes');
  const payload = toBase32(Array.from(seedBytes));
  const body = [t, ...idv, CX_SECRET_INDEX, ...payload];
  return cxEncode(body.concat(ms32CreateChecksum(body)));
}

function cxSeedFromData(dec) {
  return Uint8Array.from(fromBase32(dec.payload));
}

// Recover the unshared secret from exactly `threshold` distinct shares.
function cxRecover(shareStrings) {
  const decs = shareStrings.map(cxDecode);
  const ids = new Set(decs.map(d => d.id));
  if (ids.size !== 1) throw new Error('shares have different identifiers');
  const ths = new Set(decs.map(d => d.threshold));
  if (ths.size !== 1) throw new Error('shares have different thresholds');
  const idxs = new Set(decs.map(d => d.index));
  if (idxs.size !== decs.length) throw new Error('duplicate share index');
  const lens = new Set(decs.map(d => d.data.length));
  if (lens.size !== 1) throw new Error('shares have different lengths');
  const k = CX_CHARSET[decs[0].threshold];
  const need = k === '0' ? 1 : parseInt(k, 10);
  if (decs.length !== need) {
    throw new Error('need exactly ' + need + ' shares, got ' + decs.length);
  }
  const out = ms32Interpolate(decs.map(d => d.data), CX_SECRET_INDEX);
  const str = cxEncode(out);
  const dec = cxDecode(str);            // re-validates the produced checksum
  return { string: str, seed: cxSeedFromData(dec), decoded: dec };
}

// Share indices offered to users, in a friendly order. Every character is in
// the bech32 alphabet; 's' is excluded because it denotes the unshared secret.
const CX_SHARE_INDICES = 'acdefghjklmnpqrtuvwxyz023456789';

function cxRandomSymbols(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  // 256 is an exact multiple of 32, so the modulo is unbiased.
  return Array.from(bytes, b => b % 32);
}

// Split `seedBytes` into n shares, any k of which recover it.
//
// The polynomial is pinned by k points: the secret itself (index 's') plus
// k-1 shares with random payloads. Every other share is interpolated from
// those. The k-1 random shares are part of the output, exactly as in the
// BIP-93 test vectors.
function cxSplit(seedBytes, k, n, id, indices) {
  if (!(k >= 2 && k <= 9)) throw new Error('threshold must be 2..9');
  if (!(n >= k && n <= CX_SHARE_INDICES.length)) {
    throw new Error('share count must be between k and ' + CX_SHARE_INDICES.length);
  }
  const idx = (indices || CX_SHARE_INDICES.slice(0, n)).split('');
  if (idx.length !== n) throw new Error('need exactly ' + n + ' share indices');
  if (new Set(idx).size !== n) throw new Error('share indices must be distinct');
  if (idx.some(c => c === 's')) throw new Error("'s' is reserved for the secret");

  const secret = cxSecretString(seedBytes, String(k), id);
  const payloadLen = cxDecode(secret).payload.length;
  const t = CX_CHARSET.indexOf(String(k));
  const idv = [...id].map(c => CX_CHARSET.indexOf(c));

  // k-1 shares with random payloads
  const seeded = [];
  for (let i = 0; i < k - 1; i++) {
    const body = [t, ...idv, CX_CHARSET.indexOf(idx[i]), ...cxRandomSymbols(payloadLen)];
    seeded.push(cxEncode(body.concat(ms32CreateChecksum(body))));
  }

  const basis = [secret, ...seeded];
  const shares = idx.map((c, i) => i < k - 1 ? seeded[i] : cxDeriveShare(basis, c));

  // Self-check before any of this is shown: recover from every k-subset (or a
  // sample of them) and confirm the seed comes back byte for byte. A GF bug
  // that survives to the user costs them the coins, and this costs microseconds.
  const target = Array.from(seedBytes).join(',');
  const subsets = cxSubsets(n, k, 200);
  for (const sub of subsets) {
    const got = cxRecover(sub.map(i => shares[i]));
    if (Array.from(got.seed).join(',') !== target) {
      throw new Error('self-check failed for subset ' + sub.join('+') + ' — refusing to output shares');
    }
  }
  return { secret: secret, shares: shares, indices: idx, checked: subsets.length };
}

// All k-subsets of n, capped at `limit` (C(31,9) is far too many to enumerate).
function cxSubsets(n, k, limit) {
  const out = [], cur = [];
  (function walk(start) {
    if (out.length >= limit) return;
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < n && out.length < limit; i++) {
      cur.push(i); walk(i + 1); cur.pop();
    }
  })(0);
  return out;
}

// Derive the share at `indexChar` from exactly `threshold` known shares.
function cxDeriveShare(shareStrings, indexChar) {
  const x = CX_CHARSET.indexOf(indexChar.toLowerCase());
  if (x < 0) throw new Error('bad share index');
  const decs = shareStrings.map(cxDecode);
  const out = ms32Interpolate(decs.map(d => d.data), x);
  return cxEncode(out);
}

window.CODEX32 = {
  cxSplit: cxSplit, cxRecover: cxRecover, cxDecode: cxDecode,
  cxSecretString: cxSecretString, cxSeedFromData: cxSeedFromData,
  CX_SHARE_INDICES: CX_SHARE_INDICES, CX_CHARSET: CX_CHARSET
};

export const CODEX32 = window.CODEX32;
