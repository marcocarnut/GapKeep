// A stand-in for gk:crypto under Node, for tests only: hashes, HMAC and
// PBKDF2 from node:crypto, and secp256k1 in BigInt, ported from the
// pure-Python reference in tools/check_secp.py (SEC 1, RFC 6979 as
// libsecp256k1 applies it, Bitcoin Core's low-R grinding, BIP-340, BIP-341's
// tweaks). Slow and not constant-time: never for real keys.
//
// Same function names, arguments, return types and errors (TypeError,
// RangeError) as gk:crypto (docs/API.md).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const enc = new TextEncoder();
const bytesOf = (d) => {
  if (typeof d === "string") return enc.encode(d);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  throw new TypeError("bytes expected");
};
const binary = (d, what) => {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  throw new TypeError(`${what}: a typed array or ArrayBuffer expected`);
};
const need = (b, n, what) => {
  if (b.length !== n) throw new RangeError(`${what}: ${n} bytes expected`);
  return b;
};

const hashName = (h) => ({ "SHA-1": "sha1", "SHA-256": "sha256", "SHA-512": "sha512" })[h];
const digest = (name) => (data) => new Uint8Array(createHash(name).update(bytesOf(data)).digest());

export const sha1 = digest("sha1");
export const sha256 = digest("sha256");
export const sha512 = digest("sha512");
export const ripemd160 = digest("ripemd160");
export const hash160 = (d) => ripemd160(sha256(d));
export const hmac = (hash, key, data) => new Uint8Array(createHmac(hashName(hash), bytesOf(key)).update(bytesOf(data)).digest());
export const pbkdf2 = (hash, password, salt, iterations, length) =>
  new Uint8Array(pbkdf2Sync(bytesOf(password), bytesOf(salt), iterations, length, hashName(hash)));

// --- field and group ---------------------------------------------------------

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};
function inv(a, m = P) {
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return mod(x0, m);
}
function powmod(b, e, m) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

// Jacobian points [X, Y, Z]; null is infinity.
function jdouble(p) {
  if (!p) return null;
  const [X, Y, Z] = p;
  if (Y === 0n) return null;
  const YY = (Y * Y) % P, S = (4n * X * YY) % P, M = (3n * X * X) % P;
  const X3 = mod(M * M - 2n * S), Y3 = mod(M * (S - X3) - 8n * YY * YY), Z3 = (2n * Y * Z) % P;
  return [X3, Y3, Z3];
}
function jadd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = (Z1 * Z1) % P, Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P, U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2 * Z2Z2) % P, S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? jdouble(p) : null;
  const H = mod(U2 - U1), R = mod(S2 - S1), HH = (H * H) % P, HHH = (H * HH) % P, V = (U1 * HH) % P;
  const X3 = mod(R * R - HHH - 2n * V), Y3 = mod(R * (V - X3) - S1 * HHH), Z3 = (Z1 * Z2 * H) % P;
  return [X3, Y3, Z3];
}
function affine(p) {
  if (!p) return null;
  const zi = inv(p[2]), zi2 = (zi * zi) % P;
  return [(p[0] * zi2) % P, (p[1] * zi2 * zi) % P];
}
// k·G with a table of 2^i·G; k·P by double-and-add.
const GTABLE = (() => {
  const t = [];
  let p = [GX, GY, 1n];
  for (let i = 0; i < 256; i++) {
    t.push(p);
    p = jdouble(p);
  }
  return t;
})();
function mulG(k) {
  let r = null;
  for (let i = 0; k > 0n; i++, k >>= 1n) if (k & 1n) r = jadd(r, GTABLE[i]);
  return affine(r);
}
function mul(k, pt) {
  let r = null, p = [pt[0], pt[1], 1n];
  for (; k > 0n; k >>= 1n) {
    if (k & 1n) r = jadd(r, p);
    p = jdouble(p);
  }
  return affine(r);
}
const addAffine = (a, b) => affine(jadd(a && [a[0], a[1], 1n], b && [b[0], b[1], 1n]));

const toBig = (b) => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
};
const b32 = (x) => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--, x >>= 8n) out[i] = Number(x & 255n);
  return out;
};
const sec = (pt, compressed) => {
  if (compressed) return Uint8Array.of(2 + Number(pt[1] & 1n), ...b32(pt[0]));
  return Uint8Array.of(4, ...b32(pt[0]), ...b32(pt[1]));
};
function liftX(x) {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n), y = powmod(c, (P + 1n) / 4n, P);
  if ((y * y) % P !== c) return null;
  return [x, y & 1n ? P - y : y];
}
function parsePub(b) {
  if (b.length === 33 && (b[0] === 2 || b[0] === 3)) {
    const pt = liftX(toBig(b.subarray(1)));
    if (!pt) return null;
    return (pt[1] & 1n) === BigInt(b[0] - 2) ? pt : [pt[0], P - pt[1]];
  }
  if (b.length === 65 && b[0] === 4) {
    const x = toBig(b.subarray(1, 33)), y = toBig(b.subarray(33));
    if (x < P && y < P && mod(y * y - x * x * x - 7n) === 0n) return [x, y];
  }
  return null;
}

// --- keys ----------------------------------------------------------------------

const scalar = (k, what = "private key") => {
  const d = toBig(need(binary(k, what), 32, what));
  if (d === 0n || d >= N) throw new RangeError(`${what}: not a key`);
  return d;
};

export function isPrivateKey(k) {
  try {
    scalar(k);
    return true;
  } catch {
    return false;
  }
}
export const isPublicKey = (k) => {
  try {
    return parsePub(binary(k, "public key")) !== null;
  } catch {
    return false;
  }
};
export const publicKey = (k, compressed = true) => sec(mulG(scalar(k)), compressed);
export function publicKeyConvert(pub, compressed = true) {
  const pt = parsePub(binary(pub, "public key"));
  if (!pt) throw new RangeError("not a public key");
  return sec(pt, compressed);
}
export function privateKeyTweakAdd(k, tweak) {
  const d = scalar(k), t = toBig(need(binary(tweak, "tweak"), 32, "tweak"));
  if (t >= N) throw new RangeError("tweak out of range");
  const r = (d + t) % N;
  if (r === 0n) throw new RangeError("tweak gives zero");
  return b32(r);
}
export function publicKeyTweakAdd(pub, tweak, compressed = true) {
  const pt = parsePub(binary(pub, "public key"));
  if (!pt) throw new RangeError("not a public key");
  const t = toBig(need(binary(tweak, "tweak"), 32, "tweak"));
  if (t >= N) throw new RangeError("tweak out of range");
  const q = addAffine(pt, t ? mulG(t) : null);
  if (!q) throw new RangeError("tweak gives infinity");
  return sec(q, compressed);
}

// --- ECDSA -----------------------------------------------------------------------

const H = (key, data) => new Uint8Array(createHmac("sha256", key).update(data).digest());
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function rfc6979(seckey, msg32, extra) {
  const data = cat(seckey, b32(toBig(msg32) % N), extra || new Uint8Array(0));
  let k = new Uint8Array(32), v = new Uint8Array(32).fill(1);
  k = H(k, cat(v, [0], data));
  v = H(k, v);
  k = H(k, cat(v, [1], data));
  v = H(k, v);
  for (;;) {
    v = H(k, v);
    const t = toBig(v);
    if (t >= 1n && t < N) return t;
    k = H(k, cat(v, [0]));
    v = H(k, v);
  }
}

function derInt(x) {
  let b = x === 0n ? Uint8Array.of(0) : b32(x);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = cat([0], b);
  return cat([2, b.length], b);
}

// `grind`, test-only: start from that counter, for another valid signature
export function ecdsaSign(hash, k, grind = 0) {
  const msg = need(binary(hash, "hash"), 32, "hash"), key = binary(k, "private key");
  const d = scalar(key), z = toBig(msg) % N;
  for (let counter = grind; ; counter++) {
    let extra = null;
    if (counter) {
      extra = new Uint8Array(32);
      for (let c = counter, i = 0; c; c >>= 8, i++) extra[i] = c & 255;
    }
    const kk = rfc6979(key, msg, extra);
    const r = mulG(kk)[0] % N;
    let s = (inv(kk, N) * (z + r * d)) % N;
    if (s > N / 2n) s = N - s;
    if (r < 2n ** 255n) {
      const body = cat(derInt(r), derInt(s));
      return cat([0x30, body.length], body);
    }
  }
}

// Strict DER, low S (as libsecp256k1 with Bitcoin's normalisation check).
function parseDer(sig) {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30 || sig[1] !== sig.length - 2) return null;
  const readInt = (at) => {
    if (sig[at] !== 2) return null;
    const len = sig[at + 1];
    if (len === 0 || at + 2 + len > sig.length) return null;
    const b = sig.subarray(at + 2, at + 2 + len);
    if (b[0] & 0x80) return null;
    if (len > 1 && b[0] === 0 && !(b[1] & 0x80)) return null;
    return { v: toBig(b), end: at + 2 + len };
  };
  const r = readInt(2);
  if (!r) return null;
  const s = readInt(r.end);
  if (!s || s.end !== sig.length) return null;
  return [r.v, s.v];
}

export function ecdsaVerify(signature, hash, pub) {
  const rs = parseDer(binary(signature, "signature")), msg = binary(hash, "hash");
  const pt = parsePub(binary(pub, "public key"));
  if (!rs || !pt || msg.length !== 32) return false;
  const [r, s] = rs;
  if (r === 0n || s === 0n || r >= N || s >= N || s > N / 2n) return false;
  const z = toBig(msg) % N, w = inv(s, N);
  const R = addAffine(mulG((z * w) % N), mul((r * w) % N, pt));
  return R !== null && R[0] % N === r;
}

// --- BIP-340 and BIP-341 ------------------------------------------------------------

const tagged = (tag, data) => {
  const t = sha256(tag);
  return sha256(cat(t, t, data));
};

export const xOnlyPublicKey = (k) => b32(mulG(scalar(k))[0]);

export function schnorrSign(message, k, aux) {
  const msg = need(binary(message, "message"), 32, "message");
  if (aux === undefined) throw new Error("crypto_ref: pass aux explicitly in tests");
  const a = need(binary(aux, "aux"), 32, "aux");
  const d0 = scalar(k), pt = mulG(d0);
  const d = pt[1] & 1n ? N - d0 : d0;
  const ta = tagged("BIP0340/aux", a);
  const t = b32(d).map((x, i) => x ^ ta[i]);
  const k0 = toBig(tagged("BIP0340/nonce", cat(t, b32(pt[0]), msg))) % N;
  if (k0 === 0n) throw new Error("nonce zero");
  const R = mulG(k0);
  const kk = R[1] & 1n ? N - k0 : k0;
  const e = toBig(tagged("BIP0340/challenge", cat(b32(R[0]), b32(pt[0]), msg))) % N;
  return cat(b32(R[0]), b32((kk + e * d) % N));
}

export function schnorrVerify(signature, message, pub) {
  const sig = binary(signature, "signature"), msg = binary(message, "message"), pk = binary(pub, "public key");
  if (sig.length !== 64 || pk.length !== 32) return false;
  const P0 = liftX(toBig(pk));
  const r = toBig(sig.subarray(0, 32)), s = toBig(sig.subarray(32));
  if (!P0 || r >= P || s >= N) return false;
  const e = toBig(tagged("BIP0340/challenge", cat(sig.subarray(0, 32), pk, msg))) % N;
  const R = addAffine(mulG(s), mul(N - e, P0));
  return R !== null && !(R[1] & 1n) && R[0] === r;
}

export function taprootTweakPublicKey(pub, tweak) {
  const P0 = liftX(toBig(need(binary(pub, "public key"), 32, "public key")));
  if (!P0) throw new RangeError("not a public key");
  const t = toBig(need(binary(tweak, "tweak"), 32, "tweak"));
  if (t >= N) throw new RangeError("tweak out of range");
  const Q = addAffine(P0, t ? mulG(t) : null);
  if (!Q) throw new RangeError("tweak gives infinity");
  return { key: b32(Q[0]), parity: Number(Q[1] & 1n) };
}

export function taprootTweakPrivateKey(k, tweak) {
  const d0 = scalar(k), pt = mulG(d0);
  const d = pt[1] & 1n ? N - d0 : d0;
  const t = toBig(need(binary(tweak, "tweak"), 32, "tweak"));
  if (t >= N) throw new RangeError("tweak out of range");
  const r = (d + t) % N;
  if (r === 0n) throw new RangeError("tweak gives zero");
  return b32(r);
}

export function randomBytes() {
  throw new Error("crypto_ref: no randomness in tests");
}
