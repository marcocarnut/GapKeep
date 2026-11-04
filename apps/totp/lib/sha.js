// SHA-1 (FIPS 180-4, section 6.1) and SHA-512 (section 6.4) in plain
// JavaScript, for HMAC (lib/hotp.js). zg:crypto has SHA-256 only.
//
// Written for QuickJS on a 1 GHz ARM11: no BigInt (slow), 64-bit words as
// pairs of 32-bit halves, typed arrays, and no allocation per block. The
// API is block-level, so HMAC can hash its padded key once per account and
// start every code from that state (two blocks per code, not four).
//
//   alg.init()                  a new state (an Int32Array)
//   alg.compress(state, bytes, offset)   one block into the state
//   alg.finish(state, data, done)        data is the rest of the message,
//                               `done` the bytes already compressed (a
//                               multiple of the block size); returns the digest
//   alg.hash(bytes)             the whole thing
//
// SPDX-License-Identifier: GPL-3.0-or-later

// --- SHA-1 -------------------------------------------------------------------

const W1 = new Int32Array(80);

function sha1Compress(s, m, o) {
  const w = W1;
  for (let t = 0; t < 16; t++, o += 4) {
    w[t] = (m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3];
  }
  for (let t = 16; t < 80; t++) {
    const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
    w[t] = (x << 1) | (x >>> 31);
  }
  let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], t = 0, tmp;
  // four loops, one per round function: no branch in a round
  for (; t < 20; t++) {
    tmp = (((a << 5) | (a >>> 27)) + ((b & c) | (~b & d)) + e + 0x5a827999 + w[t]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
  }
  for (; t < 40; t++) {
    tmp = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + w[t]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
  }
  for (; t < 60; t++) {
    tmp = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e + 0x8f1bbcdc + w[t]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
  }
  for (; t < 80; t++) {
    tmp = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0xca62c1d6 + w[t]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0;
  s[3] = (s[3] + d) | 0; s[4] = (s[4] + e) | 0;
}

// --- SHA-512 -----------------------------------------------------------------

// K[t] as (high, low) pairs: the first 64 bits of the fractional parts of
// the cube roots of the first 80 primes (FIPS 180-4, 4.2.3)
const K512 = new Int32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);
const W512 = new Int32Array(160);

// One block. Words are (high, low) pairs; low halves are added as unsigned
// numbers (exact in a double) and the carry taken from the sum.
function sha512Compress(s, m, o) {
  const w = W512, K = K512;
  for (let i = 0; i < 32; i++, o += 4) {
    w[i] = (m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3];
  }
  for (let i = 32; i < 160; i += 2) {
    // sigma1(w[t-2]) + w[t-7] + sigma0(w[t-15]) + w[t-16]
    let h = w[i - 4], l = w[i - 3];
    const s1h = ((h >>> 19) | (l << 13)) ^ ((l >>> 29) | (h << 3)) ^ (h >>> 6);
    const s1l = ((l >>> 19) | (h << 13)) ^ ((h >>> 29) | (l << 3)) ^ ((l >>> 6) | (h << 26));
    h = w[i - 30]; l = w[i - 29];
    const s0h = ((h >>> 1) | (l << 31)) ^ ((h >>> 8) | (l << 24)) ^ (h >>> 7);
    const s0l = ((l >>> 1) | (h << 31)) ^ ((l >>> 8) | (h << 24)) ^ ((l >>> 7) | (h << 25));
    const lo = (s1l >>> 0) + (w[i - 13] >>> 0) + (s0l >>> 0) + (w[i - 31] >>> 0);
    const lo32 = lo >>> 0;
    w[i] = s1h + w[i - 14] + s0h + w[i - 32] + (lo - lo32) / 4294967296;
    w[i + 1] = lo32;
  }
  let ah = s[0], al = s[1], bh = s[2], bl = s[3], ch = s[4], cl = s[5], dh = s[6], dl = s[7];
  let eh = s[8], el = s[9], fh = s[10], fl = s[11], gh = s[12], gl = s[13], hh = s[14], hl = s[15];
  for (let i = 0; i < 160; i += 2) {
    // T1 = h + Sigma1(e) + Ch(e, f, g) + K[t] + W[t]
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    let lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (w[i + 1] >>> 0);
    const t1l = lo >>> 0;
    const t1h = hh + S1h + chh + K[i] + w[i] + (lo - t1l) / 4294967296;
    // T2 = Sigma0(a) + Maj(a, b, c)
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    lo = (dl >>> 0) + t1l;
    el = lo >>> 0;
    eh = (dh + t1h + (lo - el) / 4294967296) | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    lo = t1l + (S0l >>> 0) + (mjl >>> 0);
    al = lo >>> 0;
    ah = (t1h + S0h + mjh + (lo - al) / 4294967296) | 0;
  }
  const v = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
  for (let i = 0; i < 16; i += 2) {
    const lo = (s[i + 1] >>> 0) + (v[i + 1] >>> 0);
    s[i + 1] = lo;
    s[i] = s[i] + v[i] + (lo >= 4294967296 ? 1 : 0);
  }
}

// --- padding and output, shared ----------------------------------------------

// Merkle-Damgard padding: 0x80, zeros, the length in bits (big-endian, in
// the last 8 bytes; SHA-512's 16-byte length field is all zeros above that)
function finish(alg, state, data, done) {
  const bs = alg.blockSize;
  let o = 0;
  for (; o + bs <= data.length; o += bs) alg.compress(state, data, o);
  const rest = data.length - o;
  const tail = new Uint8Array(rest + 1 + alg.lengthBytes <= bs ? bs : 2 * bs);
  tail.set(data.subarray(o));
  tail[rest] = 0x80;
  const bits = (done + data.length) * 8;
  const n = tail.length;
  tail[n - 1] = bits & 0xff; tail[n - 2] = (bits >>> 8) & 0xff;
  tail[n - 3] = (bits >>> 16) & 0xff; tail[n - 4] = (bits >>> 24) & 0xff;
  const high = Math.floor(bits / 4294967296);
  tail[n - 5] = high & 0xff; tail[n - 6] = (high >>> 8) & 0xff;
  tail[n - 7] = (high >>> 16) & 0xff; tail[n - 8] = (high >>> 24) & 0xff;
  for (let i = 0; i < n; i += bs) alg.compress(state, tail, i);
  tail.fill(0);
  const out = new Uint8Array(alg.outSize);
  for (let i = 0; i < alg.outSize; i += 4) {
    const x = state[i >> 2];
    out[i] = x >>> 24; out[i + 1] = (x >>> 16) & 0xff; out[i + 2] = (x >>> 8) & 0xff; out[i + 3] = x & 0xff;
  }
  return out;
}

function makeAlg(name, blockSize, outSize, lengthBytes, iv, compress) {
  const alg = {
    name, blockSize, outSize, lengthBytes, compress,
    init: () => Int32Array.from(iv),
    finish: (state, data, done) => finish(alg, state, data, done),
    hash: (data) => finish(alg, alg.init(), data, 0),
  };
  return alg;
}

export const SHA1 = makeAlg("SHA1", 64, 20, 8,
  [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], sha1Compress);

export const SHA512 = makeAlg("SHA512", 128, 64, 16, [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
], sha512Compress);
