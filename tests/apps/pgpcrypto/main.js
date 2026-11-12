// gk:crypto's OpenPGP primitives through the JavaScript API: known answers
// (RFC 8032, RFC 9580, Wycheproof, NIST CAVP: vectors.js, made by
// tools/make_pgp_vectors.py), the errors the API promises, and timings
// ("pgpcrypto: time ..."). Ends with "pgpcrypto: N passed, M failed".
// tools/check_pgp.py checks the same C code far more widely on the host.
// Logs no key material: only names, results and times.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as crypto from "gk:crypto";
import * as zlib from "gk:zlib";
import * as V from "./vectors.js";

const status = new ui.Label({ text: "Testing...", font: 20 });
let passed = 0, failed = 0;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((x) => parseInt(x, 16)));
const utf8 = (s) => unhex(Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
const keyOf = (k) => ({ n: unhex(k.n), e: unhex(k.e), d: unhex(k.d), p: unhex(k.p), q: unhex(k.q),
                        u: k.u === undefined ? undefined : unhex(k.u) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function ok(cond, what) {
  if (cond) passed++;
  else { failed++; console.log(`pgpcrypto: FAIL ${what}`); }
}
function throws(fn, type, what) {
  try { fn(); } catch (e) { ok(e instanceof type, `${what} (threw ${e && e.name}: ${e && e.message})`); return; }
  ok(false, `${what} (did not throw)`);
}
function time(what, fn) {
  const t0 = sys.uptime();
  const r = fn();
  console.log(`pgpcrypto: time ${what} ${(sys.uptime() - t0).toFixed(1)} ms`);
  return r;
}
async function rejects(promise, type, what) {
  try { await promise; } catch (e) { ok(e instanceof type, `${what} (rejected with ${e && e.name}: ${e && e.message})`); return; }
  ok(false, `${what} (resolved)`);
}

// A long job (a promise) timed, with what the person would see meanwhile:
// a timer every 5 ms and the progress on screen; the longest gap between
// the timer's ticks is how long the screen went without being drawn.
async function timeJob(what, start) {
  let last = sys.uptime(), gap = 0, ticks = 0, calls = 0, lastProgress = 0, monotonic = true;
  const timer = setInterval(() => {
    const now = sys.uptime();
    gap = Math.max(gap, now - last);
    last = now;
    ticks++;
  }, 5);
  const t0 = sys.uptime();
  const r = await start((f) => {
    calls++;
    if (!(f > lastProgress && f <= 1)) monotonic = false;
    lastProgress = f;
    status.text = `${what}: ${Math.round(f * 100)}%`;
  });
  const now = sys.uptime();
  gap = Math.max(gap, now - last);
  clearInterval(timer);
  console.log(`pgpcrypto: time ${what} ${(now - t0).toFixed(1)} ms, longest gap ${gap.toFixed(1)} ms, ` +
              `${ticks} timer ticks, ${calls} progress calls`);
  ok(monotonic, `${what}: progress rises, at most 1`);
  return r;
}

const groups = [];
const group = (name, fn) => groups.push([name, fn]);

group("hashes", () => {
  ok(hex(crypto.sha224("abc")) === "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7", "sha224");
  ok(hex(crypto.sha384("abc")) === "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed" +
     "8086072ba1e7cc2358baeca134c825a7", "sha384");
  ok(hex(crypto.hmac("SHA-384", "Jefe", "what do ya want for nothing?")) ===
     "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240ca5e69e2c78b3239ecfab21649", "hmac sha384");
  for (const [name, one] of [["SHA-1", crypto.sha1], ["SHA-224", crypto.sha224], ["SHA-256", crypto.sha256],
                             ["SHA-384", crypto.sha384], ["SHA-512", crypto.sha512]]) {
    const h = crypto.createHash(name);
    ok(h.algorithm === name, `${name} algorithm`);
    ok(h.update("ab").update(new Uint8Array([0x63])) === h, `${name} update returns the hash`);
    const c = h.copy();
    ok(hex(h.digest()) === hex(one("abc")), `${name} incremental`);
    c.update("def");
    ok(hex(c.digest()) === hex(one("abcdef")), `${name} copy continues alone`);
    throws(() => h.update("x"), TypeError, `${name} update after digest`);
    throws(() => h.digest(), TypeError, `${name} digest twice`);
    const d = crypto.createHash(name);
    d.destroy();
    d.destroy();
    throws(() => d.update("x"), TypeError, `${name} update after destroy`);
  }
  // a million 'a' in uneven pieces
  const h = crypto.createHash("SHA-384"), a = new Uint8Array(997).fill(0x61);
  let left = 1000000;
  while (left > 0) { const n = Math.min(left, 997); h.update(a.subarray(0, n)); left -= n; }
  ok(hex(h.digest()) === "9d0e1809716474cb086e834e310a4a1ced149e9c00f248527972cec5704c2a5b" +
     "07b8b3dc38ecc4ebae97ddd87f3d8985", "sha384 of a million a");
  throws(() => crypto.createHash("MD5"), TypeError, "createHash MD5");
  throws(() => crypto.createHash("SHA-256").update(42), TypeError, "update a number");
});

group("Ed25519 RFC 8032 and RFC 9580", () => {
  const v = [
    ["9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
     "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"],
    ["4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
     "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"],
    ["c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
     "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"],
    // RFC 9580, A.1 and A.2: an OpenPGP signature's SHA2-256 digest, signed as the message
    ["1a8b1ff05ded48e18bf50166c664ab023ea70003d78d9e41f5758a91d850f8d2",
     "3f098994bdd916ed4053197934e4a87c80733a1280d62f8010992e43ee3b2406",
     "f6220a3f757814f4c2176ffbb68b00249cd4ccdc059c4b34ad871f30b1740280",
     "56f90cca98e2102637bd983fdb16c131dfd27ed82bf4dde5606e0d756aed3366d09c4fa11527f038e0f57f2201d82f2ea2c9033265fa6ceb489e854bae61b404"],
  ];
  for (const [i, [seed, pub, msg, sig]] of v.entries()) {
    const k = crypto.ed25519PrivateKey(unhex(seed));
    ok(hex(k.publicKey) === pub, `Ed25519 ${i} public key`);
    ok(hex(k.sign(unhex(msg))) === sig, `Ed25519 ${i} signature`);
    ok(crypto.ed25519Verify(unhex(sig), unhex(msg), unhex(pub)), `Ed25519 ${i} verifies`);
    k.destroy();
    throws(() => k.sign(unhex(msg)), TypeError, `Ed25519 ${i} sign after destroy`);
    ok(hex(k.publicKey) === pub, `Ed25519 ${i} public key after destroy`);
  }
  const k = crypto.ed25519PrivateKey(new Uint8Array(32));
  throws(() => crypto.ed25519PrivateKey(new Uint8Array(31)), RangeError, "Ed25519 31-byte seed");
  throws(() => crypto.ed25519PrivateKey("x".repeat(32)), TypeError, "Ed25519 seed as a string");
  throws(() => k.sign("message"), TypeError, "Ed25519 message as a string");
  const sig = k.sign(new Uint8Array(0));
  ok(crypto.ed25519Verify(sig.buffer, new ArrayBuffer(0), k.publicKey.buffer), "Ed25519 ArrayBuffers");
  ok(!crypto.ed25519Verify(sig.subarray(0, 63), new Uint8Array(0), k.publicKey), "Ed25519 short signature: false");
  ok(!crypto.ed25519Verify(sig, new Uint8Array(0), k.publicKey.subarray(1)), "Ed25519 short key: false");
  throws(() => crypto.ed25519Verify(sig, "", k.publicKey), TypeError, "Ed25519 verify message as a string");
});

group("Ed25519 Wycheproof", () => {
  let n = 0;
  for (const [pk, msg, sig, result, id] of V.ed25519Wycheproof) {
    const got = crypto.ed25519Verify(unhex(sig), unhex(msg), unhex(pk));
    if (result !== "a") { ok(got === (result === "v"), `Wycheproof Ed25519 ${id}`); n++; }
  }
  console.log(`pgpcrypto: Wycheproof Ed25519: ${n} checked`);
});

group("RSA Wycheproof verify", () => {
  let n = 0;
  for (const [mod, e, digest, sig, result, id] of V.rsaVerifyWycheproof) {
    const got = crypto.rsaVerify(unhex(sig), "SHA-256", unhex(digest), { n: unhex(mod), e: unhex(e) });
    if (result !== "a") { ok(got === (result === "v"), `Wycheproof RSA verify ${id}`); n++; }
  }
  console.log(`pgpcrypto: Wycheproof RSA verify: ${n} checked`);
});

group("RSA Wycheproof sign", async () => {
  let last = null, key = null;
  for (const [k, digest, sig, id] of V.rsaSignWycheproof) {
    if (k !== last) { key?.destroy(); key = crypto.rsaPrivateKey(keyOf(k)); last = k; }
    ok(hex(await key.sign("SHA-256", unhex(digest))) === sig, `Wycheproof RSA sign ${id}`);
  }
  key?.destroy();
});

for (const size of [2048, 3072, 4096]) {
  group(`RSA-${size}`, async () => {
    const { key: k, sigs } = V.rsaKeys.find((x) => x.bits === size);
    const key = time(`RSA-${size} import`, () => crypto.rsaPrivateKey(keyOf(k)));
    ok(key.bits === size, `RSA-${size} bits`);
    ok(hex(key.publicKey.n) === k.n && hex(key.publicKey.e) === k.e, `RSA-${size} publicKey`);
    const pub = { n: unhex(k.n), e: unhex(k.e) };
    for (const [name, one] of [["SHA-224", crypto.sha224], ["SHA-256", crypto.sha256],
                               ["SHA-384", crypto.sha384], ["SHA-512", crypto.sha512]]) {
      const digest = one("GapKeep");
      const sig = name === "SHA-512"
        ? await timeJob(`RSA-${size} sign`, (onProgress) => key.sign(name, digest, { onProgress }))
        : await key.sign(name, digest);
      ok(hex(sig) === sigs[name], `RSA-${size} ${name} signature`);
      const v = name === "SHA-512" ? time(`RSA-${size} verify`, () => crypto.rsaVerify(sig, name, digest, pub))
        : crypto.rsaVerify(sig, name, digest, pub);
      ok(v, `RSA-${size} ${name} verifies`);
    }
    ok(crypto.rsaVerify(unhex(sigs["SHA-1"]), "SHA-1", crypto.sha1("GapKeep"), pub), `RSA-${size} SHA-1 verifies`);
    // without u, and with the primes swapped (u then no longer fits)
    const k2 = crypto.rsaPrivateKey({ ...keyOf(k), u: undefined, p: unhex(k.q), q: unhex(k.p) });
    ok(hex(await k2.sign("SHA-256", crypto.sha256("GapKeep"))) === sigs["SHA-256"], `RSA-${size} q < p, no u`);
    k2.destroy();
    throws(() => crypto.rsaPrivateKey({ ...keyOf(k), p: unhex(k.q), q: unhex(k.p) }), RangeError, `RSA-${size} u for swapped primes`);
    key.destroy();
    throws(() => key.sign("SHA-256", crypto.sha256("x")), TypeError, `RSA-${size} sign after destroy`);
  });
}

group("RSA errors", async () => {
  const { key: k, sigs } = V.rsaKeys[0];
  const key = crypto.rsaPrivateKey(keyOf(k)), pub = { n: unhex(k.n), e: unhex(k.e) };
  const digest = crypto.sha256("GapKeep"), sig = unhex(sigs["SHA-256"]);
  throws(() => key.sign("SHA-1", crypto.sha1("x")), TypeError, "RSA sign SHA-1");
  throws(() => key.sign("MD5", digest), TypeError, "RSA sign MD5");
  throws(() => key.sign("SHA-256", digest.subarray(1)), RangeError, "RSA sign short digest");
  throws(() => key.sign("SHA-256", "x".repeat(32)), TypeError, "RSA sign digest as a string");
  throws(() => crypto.rsaPrivateKey({ ...keyOf(k), d: undefined }), TypeError, "RSA no d");
  throws(() => crypto.rsaPrivateKey(), TypeError, "RSA no key");
  const bad = keyOf(k); bad.d[bad.d.length - 1] ^= 2;
  throws(() => crypto.rsaPrivateKey(bad), RangeError, "RSA inconsistent d");
  const bad2 = keyOf(k); bad2.n[5] ^= 1;
  throws(() => crypto.rsaPrivateKey(bad2), RangeError, "RSA n not pq");
  throws(() => crypto.rsaPrivateKey({ ...keyOf(k), e: new Uint8Array([3]) }), RangeError, "RSA wrong e");
  throws(() => crypto.rsaPrivateKey({ ...keyOf(k), n: new Uint8Array(1100) }), RangeError, "RSA too long a number");
  ok(!crypto.rsaVerify(sig, "SHA-256", crypto.sha256("GapKeeq"), pub), "RSA verify other digest: false");
  ok(!crypto.rsaVerify(sig, "SHA-512", crypto.sha512("GapKeep"), pub), "RSA verify wrong hash: false");
  ok(!crypto.rsaVerify(sig.subarray(1), "SHA-256", digest, pub), "RSA verify short signature: false");
  const flipped = sig.slice(); flipped[100] ^= 0x10;
  ok(!crypto.rsaVerify(flipped, "SHA-256", digest, pub), "RSA verify corrupted: false");
  ok(!crypto.rsaVerify(sig, "SHA-256", digest, { n: unhex(k.n).subarray(0, 64), e: pub.e }), "RSA verify 512-bit key: false");
  ok(!crypto.rsaVerify(sig.subarray(0, 120), "SHA-256", digest, { n: unhex(k.n).subarray(0, 120), e: pub.e }),
     "RSA verify 960-bit key: false");
  throws(() => crypto.rsaVerify(sig, "SHA-256", digest.subarray(1), pub), RangeError, "RSA verify short digest");
  throws(() => crypto.rsaVerify(sig, "SHA3-256", digest, pub), TypeError, "RSA verify unknown hash");
  throws(() => crypto.rsaVerify(sig, "SHA-256", digest, { n: pub.n }), TypeError, "RSA verify no e");
  throws(() => key.sign("SHA-256", digest, 42), TypeError, "RSA sign options a number");
  throws(() => key.sign("SHA-256", digest, { onProgress: 42 }), TypeError, "RSA sign onProgress a number");
  // destroyed while it signs: the promise rejects; signing after: throws
  const pending = key.sign("SHA-256", digest);
  ok(pending instanceof Promise, "RSA sign returns a promise");
  key.destroy();
  await rejects(pending, TypeError, "RSA key destroyed while signing");
  key.destroy();
  throws(() => key.sign("SHA-256", digest), TypeError, "RSA sign after destroy");
  // RSA-1024: verifies (weak, for old signatures), never imports
  const { key: k1, sig: s1, digest: d1 } = V.rsa1024;
  ok(crypto.rsaVerify(unhex(s1), "SHA-256", unhex(d1), { n: unhex(k1.n), e: unhex(k1.e) }), "RSA-1024 verifies");
  ok(!crypto.rsaVerify(unhex(s1), "SHA-256", crypto.sha256("x"), { n: unhex(k1.n), e: unhex(k1.e) }), "RSA-1024 other digest");
  throws(() => crypto.rsaPrivateKey(keyOf(k1)), RangeError, "RSA-1024 import refused");
});

group("RSA key limit", () => {
  const { key: k } = V.rsaKeys[0];
  const keys = [];
  try {
    for (let i = 0; i < 64; i++) keys.push(crypto.rsaPrivateKey(keyOf(k)));
    throws(() => crypto.rsaPrivateKey(keyOf(k)), RangeError, "RSA 65th key");
  } finally {
    keys.forEach((x) => x.destroy());
  }
  const again = crypto.rsaPrivateKey(keyOf(k));
  ok(again.bits === 2048, "RSA key after destroying 64");
  again.destroy();
});

group("AES-CFB", () => {
  for (const [mode, key, iv, plain, cipher] of V.aesCfbMmt) {
    const [from, to] = mode === "E" ? [plain, cipher] : [cipher, plain];
    const f = mode === "E" ? crypto.aesCfbEncrypt : crypto.aesCfbDecrypt;
    ok(hex(f(unhex(key), unhex(iv), unhex(from))) === to, `AES-CFB CAVP ${key.length * 4} ${mode}`);
  }
  // SP 800-38A F.3.13, cut short: not whole blocks
  const key = unhex("2b7e151628aed2a6abf7158809cf4f3c"), iv = unhex("000102030405060708090a0b0c0d0e0f");
  const p = unhex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51");
  const c = crypto.aesCfbEncrypt(key, iv, p.subarray(0, 21));
  ok(hex(c) === "3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0", "AES-CFB 21 bytes");
  ok(hex(crypto.aesCfbDecrypt(key, iv, c)) === hex(p.subarray(0, 21)), "AES-CFB 21 bytes back");
  ok(crypto.aesCfbEncrypt(key, iv, new Uint8Array(0)).length === 0, "AES-CFB nothing");
  throws(() => crypto.aesCfbEncrypt(new Uint8Array(20), iv, p), RangeError, "AES 20-byte key");
  throws(() => crypto.aesCfbEncrypt(key, iv.subarray(1), p), RangeError, "AES 15-byte IV");
  throws(() => crypto.aesCfbEncrypt(key, iv, "text"), TypeError, "AES data as a string");
  throws(() => crypto.aesCfbDecrypt("k".repeat(16), iv, p), TypeError, "AES key as a string");
  const mib = new Uint8Array(1 << 20);
  const e = time("AES-256-CFB encrypt 1 MiB", () => crypto.aesCfbEncrypt(new Uint8Array(32), iv, mib));
  ok(crypto.aesCfbDecrypt(new Uint8Array(32), iv, e).every((x) => x === 0), "AES-CFB 1 MiB round trip");
});

group("S2K", async () => {
  const salt = unhex("0102030405060708");
  ok(hex(await crypto.openpgpS2k(3, "SHA-1", "hello world", salt, 0x60, 32)) ===
     "3251cc71bbba6d556b738cd47f5070e3634833e818a6d2bafab4a582d1deba88", "S2K 3 SHA-1 two hashes");
  ok(hex(await crypto.openpgpS2k(1, "SHA-256", utf8("password"), salt, null, 32)) ===
     "401cee42f1e78e4ce02e01102870bd121c252c9f617db439352f749ceecaadfc", "S2K 1");
  ok(hex(await crypto.openpgpS2k(0, "SHA-512", "", null, null, 16)) === "cf83e1357eefb8bdf1542850d66d8007", "S2K 0");
  ok(hex(await crypto.openpgpS2k(0, "SHA-224", "abc", undefined, undefined, 40)) ===
     "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7a5b29b7d277ee5f8472f0c9f", "S2K 0 SHA-224 40 bytes");
  throws(() => crypto.openpgpS2k(2, "SHA-256", "p", salt, 0, 16), RangeError, "S2K type 2");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt.subarray(1), 0, 16), RangeError, "S2K 7-byte salt");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", null, 0, 16), TypeError, "S2K 3 without salt");
  throws(() => crypto.openpgpS2k(0, "SHA-256", "p", salt, null, 16), TypeError, "S2K 0 with a salt");
  throws(() => crypto.openpgpS2k(1, "SHA-256", "p", salt, 96, 16), TypeError, "S2K 1 with a count");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt, 256, 16), RangeError, "S2K count 256");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt, 1.5, 16), RangeError, "S2K count 1.5");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt, 0, 65), RangeError, "S2K length 65");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt, 0, 0), RangeError, "S2K length 0");
  throws(() => crypto.openpgpS2k(3, "MD5", "p", salt, 0, 16), TypeError, "S2K MD5");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p".repeat(65537), salt, 0, 16), RangeError, "S2K passphrase too long");
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt, 0, 16, { onProgress: "x" }), TypeError, "S2K onProgress a string");
  // the passphrase is copied: changing it afterwards changes nothing
  const pw = utf8("hello world"), pending = crypto.openpgpS2k(3, "SHA-1", pw, salt, 0x60, 32);
  pw.fill(0);
  ok(hex(await pending) === "3251cc71bbba6d556b738cd47f5070e3634833e818a6d2bafab4a582d1deba88", "S2K passphrase copied");
});

group("jobs", async () => {
  // they run one at a time, in order
  const salt = new Uint8Array(8), order = [];
  const all = [];
  for (let i = 0; i < 16; i++) all.push(crypto.openpgpS2k(3, "SHA-256", `p${i}`, salt, 0x40, 16).then(() => order.push(i)));
  throws(() => crypto.openpgpS2k(3, "SHA-256", "p", salt, 0x40, 16), RangeError, "a 17th job waiting");
  await Promise.all(all);
  ok(order.join() === Array.from({ length: 16 }, (_, i) => i).join(), "jobs end in order");
  // a handler that throws doesn't stop the job
  let n = 0;
  const k = await crypto.openpgpS2k(3, "SHA-256", "p", salt, 0xd0, 16, { onProgress: () => { n++; throw new Error("test: an onProgress that throws"); } });
  ok(k.length === 16 && n > 0, "a throwing onProgress");
});

// RFC 9580, A.9.1, A.10.1, A.11.1: SHA2-256, the largest count (65011712
// bytes) - each in its own turn, as each takes seconds on a Pi Zero
for (const [salt, key] of [["a5ae579d1fc5d82b", "154967e590aa1f923e1c0ac64c88f23d"],
                           ["56a298d2f5e36453", "e80de243a362d93b9dc607ede96a7356"],
                           ["e9d39785b2070008", "250281715bba7828ef71ef64c4784753"]]) {
  group(`S2K RFC 9580 ${salt}`, async () => {
    const k = await timeJob("S2K SHA-256 65011712 bytes",
      (onProgress) => crypto.openpgpS2k(3, "SHA-256", "password", unhex(salt), 255, 16, { onProgress }));
    ok(hex(k) === key, `S2K RFC 9580 ${salt}`);
  });
}

// what GnuPG 2.4 exports secret keys with: SHA-1, the largest count, AES-128
group("S2K SHA-1 timing", async () => {
  const k = await timeJob("S2K SHA-1 65011712 bytes",
    (onProgress) => crypto.openpgpS2k(3, "SHA-1", "password", new Uint8Array(8), 255, 16, { onProgress }));
  ok(k.length === 16, "S2K SHA-1 largest count");
});

group("pbkdf2Async", async () => {
  const words = "abandon ".repeat(11) + "about";
  const want = hex(crypto.pbkdf2("SHA-512", words, "mnemonicTREZOR", 2048, 64));
  ok(want.startsWith("c55257c360c07c72029aebc1b53c05ed"), "pbkdf2 BIP-39");
  let calls = 0;
  const got = await crypto.pbkdf2Async("SHA-512", words, "mnemonicTREZOR", 2048, 64, { onProgress: () => calls++ });
  ok(hex(got) === want, "pbkdf2Async = pbkdf2");
  ok(hex(await crypto.pbkdf2Async("SHA-1", "password", "salt", 2, 20)) === "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957",
     "pbkdf2Async RFC 6070");
  throws(() => crypto.pbkdf2Async("SHA-512", "p", "s", 0, 64), RangeError, "pbkdf2Async 0 iterations");
  throws(() => crypto.pbkdf2Async("SHA-512", "p", "s", 1, 1025), RangeError, "pbkdf2Async length 1025");
  throws(() => crypto.pbkdf2Async("MD5", "p", "s", 1, 16), TypeError, "pbkdf2Async MD5");
  await timeJob("pbkdf2Async SHA-512 100000 iterations",
    (onProgress) => crypto.pbkdf2Async("SHA-512", "p", "s", 100000, 64, { onProgress }));
});

group("RSA decryption, implicit rejection (draft)", async () => {
  for (const { name, key, cases } of V.rsaDecryptDraft) {
    const k = crypto.rsaPrivateKey(keyOf(key));
    for (const { name: what, c, m } of cases) {
      ok(hex(await k.decrypt(unhex(c))) === m, `RSA decrypt draft ${name}: ${what}`);
    }
    k.destroy();
  }
});

group("RSA decryption, Wycheproof", async () => {
  let n = 0;
  for (const { key, tests } of V.rsaDecryptWycheproof) {
    const k = crypto.rsaPrivateKey(keyOf(key));
    for (const [c, want, id] of tests) {
      if (want === null) throws(() => k.decrypt(unhex(c)), RangeError, `Wycheproof RSA decrypt ${id} refused`);
      else ok(hex(await k.decrypt(unhex(c))) === want, `Wycheproof RSA decrypt ${id}`);
      n++;
    }
    k.destroy();
  }
  console.log(`pgpcrypto: Wycheproof RSA decryption: ${n} checked`);
});

group("RSA decryption errors and timing", async () => {
  const { key: kk } = V.rsaKeys.find((x) => x.bits === 4096);
  const k = crypto.rsaPrivateKey(keyOf(kk));
  const n = unhex(kk.n);
  throws(() => k.decrypt(n), RangeError, "RSA decrypt c = n");
  throws(() => k.decrypt(n.subarray(1)), RangeError, "RSA decrypt short");
  throws(() => k.decrypt("x"), TypeError, "RSA decrypt a string");
  const c = new Uint8Array(512);
  c[511] = 5;
  const m1 = await timeJob("RSA-4096 decrypt", (onProgress) => k.decrypt(c, { onProgress }));
  const m2 = await k.decrypt(c);
  ok(hex(m1) === hex(m2) && m1.length <= 512 - 11, "RSA decrypt bad padding: the same message each time");
  const pending = k.decrypt(c);
  k.destroy();
  await rejects(pending, TypeError, "RSA key destroyed while decrypting");
});

group("X25519", () => {
  const a = unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const b = unhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const ka = crypto.x25519PrivateKey(a), kb = crypto.x25519PrivateKey(b);
  ok(hex(ka.publicKey) === "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "X25519 RFC 7748 public");
  const s = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
  ok(hex(ka.sharedSecret(kb.publicKey)) === s && hex(kb.sharedSecret(ka.publicKey)) === s, "X25519 RFC 7748 shared");
  throws(() => ka.sharedSecret(new Uint8Array(32)), RangeError, "X25519 zero shared secret");
  throws(() => ka.sharedSecret(new Uint8Array(31)), RangeError, "X25519 short peer key");
  throws(() => crypto.x25519PrivateKey(new Uint8Array(33)), RangeError, "X25519 long secret");
  throws(() => crypto.x25519PrivateKey("x".repeat(32)), TypeError, "X25519 secret as a string");
  ka.destroy();
  throws(() => ka.sharedSecret(kb.publicKey), TypeError, "X25519 after destroy");
  ok(ka.publicKey.length === 32, "X25519 public key after destroy");
  kb.destroy();
  let n = 0;
  for (const [priv, pub, shared, id] of V.x25519Wycheproof) {
    const k = crypto.x25519PrivateKey(unhex(priv));
    if (shared === null) throws(() => k.sharedSecret(unhex(pub)), RangeError, `Wycheproof X25519 ${id} zero refused`);
    else ok(hex(k.sharedSecret(unhex(pub))) === shared, `Wycheproof X25519 ${id}`);
    k.destroy();
    n++;
  }
  console.log(`pgpcrypto: Wycheproof X25519: ${n} checked`);
  const k = crypto.x25519PrivateKey(new Uint8Array(32).fill(3));
  time("X25519 shared secret x20", () => { for (let i = 0; i < 20; i++) k.sharedSecret(ka.publicKey); });
});

group("AES key wrap", () => {
  const kek = unhex("000102030405060708090a0b0c0d0e0f"), key = unhex("00112233445566778899aabbccddeeff");
  const w = crypto.aesKeyWrap(kek, key);
  ok(hex(w) === "1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5", "RFC 3394 4.1 wrap");
  ok(hex(crypto.aesKeyUnwrap(kek, w)) === hex(key), "RFC 3394 4.1 unwrap");
  w[3] ^= 1;
  throws(() => crypto.aesKeyUnwrap(kek, w), Error, "key unwrap of a changed byte");
  try { crypto.aesKeyUnwrap(kek, w); } catch (e) { ok(!(e instanceof TypeError) && !(e instanceof RangeError), "key unwrap: an Error, not a TypeError or RangeError"); }
  throws(() => crypto.aesKeyUnwrap(kek, w.subarray(0, 20)), RangeError, "key unwrap 20 bytes");
  throws(() => crypto.aesKeyWrap(kek, key.subarray(0, 8)), RangeError, "key wrap 8 bytes");
  throws(() => crypto.aesKeyWrap(kek.subarray(1), key), RangeError, "key wrap 15-byte kek");
  let n = 0;
  for (const [k, msg, ct, result, id] of V.aesWrapWycheproof) {
    let got = null;
    try { got = hex(crypto.aesKeyUnwrap(unhex(k), unhex(ct))); } catch (e) { got = null; }
    if (result === "v") ok(got === msg && hex(crypto.aesKeyWrap(unhex(k), unhex(msg))) === ct, `Wycheproof key wrap ${id}`);
    else if (result === "i") ok(got === null, `Wycheproof key wrap ${id} refused`);
    n++;
  }
  console.log(`pgpcrypto: Wycheproof AES key wrap: ${n} checked`);
});

// an SEIPD v1 body as OpenPGP makes it (the prefix's last two bytes again,
// the MDC packet), encrypted with aesCfbEncrypt and a zero IV
function seipd(key, plain, { quickCheck = true, mdcOk = true } = {}) {
  const prefix = crypto.randomBytes(16);
  const body = cat(prefix, quickCheck ? prefix.subarray(14) : new Uint8Array(2), plain, new Uint8Array([0xd3, 0x14]));
  const mdc = crypto.sha1(body);
  if (!mdcOk) mdc[0] ^= 1;
  return crypto.aesCfbEncrypt(key, new Uint8Array(16), cat(body, mdc));
}
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

group("SEIPD v1", async () => {
  // made with Python's cryptography (src/crypto/seipd.c's self-test)
  const key = new Uint8Array(16).map((_, i) => i);
  const kat = unhex("a2c45d50efe631e90322ef0dd1b9aa0a04429abc84839f390526c3b005306eef" +
                    "8bd0d47e38e105f8f146aee5f8b6106d02cc7c4814bdabaf6445e18210e8f223");
  ok(hex(await crypto.seipdV1Decrypt(key, kat)) === "cb186200000000004761704b656570205345495044207631", "SEIPD known answer");
  for (const size of [16, 24, 32]) {
    const k = crypto.randomBytes(size), plain = crypto.randomBytes(1000);
    const c = seipd(k, plain);
    ok(hex(await crypto.seipdV1Decrypt(k, c)) === hex(plain), `SEIPD AES-${size * 8}`);
    ok(hex(await crypto.seipdV1Decrypt(k, seipd(k, plain, { quickCheck: false }))) === hex(plain), `SEIPD quick check ignored`);
    for (const at of [0, 17, 500, c.length - 21, c.length - 1]) {
      const bad = c.slice();
      bad[at] ^= 1;
      await rejects(crypto.seipdV1Decrypt(k, bad), Error, `SEIPD AES-${size * 8} changed at ${at}`);
    }
    await rejects(crypto.seipdV1Decrypt(k, c.subarray(0, c.length - 1)), Error, "SEIPD truncated");
    await rejects(crypto.seipdV1Decrypt(k, seipd(k, plain, { mdcOk: false })), Error, "SEIPD wrong MDC");
    const other = k.slice();
    other[0] ^= 1;
    await rejects(crypto.seipdV1Decrypt(other, c), Error, "SEIPD another key");
  }
  const k = crypto.randomBytes(16);
  ok((await crypto.seipdV1Decrypt(k, seipd(k, new Uint8Array(0)))).length === 0, "SEIPD empty plaintext");
  throws(() => crypto.seipdV1Decrypt(k, new Uint8Array(39)), RangeError, "SEIPD 39 bytes");
  throws(() => crypto.seipdV1Decrypt(k.subarray(1), new Uint8Array(40)), RangeError, "SEIPD 15-byte key");
  throws(() => crypto.seipdV1Decrypt(k, "x".repeat(40)), TypeError, "SEIPD data as a string");
  throws(() => crypto.seipdV1Decrypt(k, new Uint8Array(8 * 1024 * 1024 + 1)), RangeError, "SEIPD over 8 MiB");
  for (const size of [65536, 1 << 20]) {
    const plain = new Uint8Array(size).fill(0x5a), c = seipd(k, plain);
    const got = await timeJob(`SEIPD v1 ${size / 1024} KiB`, (onProgress) => crypto.seipdV1Decrypt(k, c, { onProgress }));
    ok(got.length === size && got.every((x) => x === 0x5a), `SEIPD ${size} bytes`);
  }
});

function base64(s) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = s.replace(/=+$/, ""), out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let bits = 0, acc = 0, n = 0;
  for (const ch of clean) {
    acc = (acc << 6) | abc.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
  }
  return out;
}

group("SEIPD v2 and GnuPG's OCB packet", async () => {
  // RFC 9580, A.10.3 and A.10.4 (OCB), A.9 (EAX), A.11 (GCM)
  const rfc = unhex("07020620a661f731fc9a3032b5623326027e3a5d8db5748ebeff0b0c5910d09ecdd641ff9fd38562758035" +
                    "bc49754ce1bf3fffa7dad0a3b8104f5133cf42a4100a83eef4ca1b4801a8846bf42bcda7c8ce9d65e212f301" +
                    "cbcd98fdcade694a877ad4247323f6e857");
  ok(hex(await crypto.seipdV2Decrypt(unhex("28e79ab82397d3c63de24ac217d7b791"), rfc)) ===
     "cb1362000000000048656c6c6f2c20776f726c6421d50eae6aa1649b56aa835b2613902bd2", "SEIPD v2 RFC 9580 A.10");
  ok(hex(await crypto.seipdV2Decrypt(unhex("3881bafe985412459b86c36f98cb9a5e"), unhex(
    "0701069ff90e3b321964f3a42913c8dcc6619325015227efb7eaeaa49f04c2e674175d4a3d226ed6afcb9ca9ac122c1470e11c" +
    "63d4c0ab241c6a938ad48bf99a5a99b90bba8325de61047540258ab7959a95ad051dda96eb15431dfef5f5e2255ca78261546e339a"))) ===
     "cb1362000000000048656c6c6f2c20776f726c6421d50eae5bf0cd6705500355816cb0c8ff", "SEIPD v2 RFC 9580 A.9 (EAX)");
  ok(hex(await crypto.seipdV2Decrypt(unhex("1936fc8568980274bb900d8319360c77"), unhex(
    "070306fcb94490bcb98bbdc9d106c6090266940f72e89edc21b5596b1576b101ed0f9ffc6fc6d65bbfd24dcd0790966e6d1e85" +
    "a30053784cb1d8b6a0699ef12155a7b2ad6258531b57651fd7777912fa95e35d9b40216f69a4c248db28ff4331f1632907399e6ff9"))) ===
     "cb1362000000000048656c6c6f2c20776f726c6421d50e1ce2269a9eddef81032172b7ed7c", "SEIPD v2 RFC 9580 A.11 (GCM)");
  const modes = {};
  for (const t of V.aeadPackets) {
    const f = t.packet === 18 ? crypto.seipdV2Decrypt : crypto.ocbedDecrypt;
    const what = `AEAD ${t.packet} ${["", "EAX", "OCB", "GCM"][t.mode]} ${t.plain.length / 2} bytes`;
    modes[what.split(" ").slice(0, 3).join(" ")] = true;
    const key = unhex(t.key), data = unhex(t.data);
    ok(hex(await f(key, data)) === t.plain, what);
    for (const at of [3, Math.floor(data.length / 2), data.length - 17, data.length - 1]) {
      const bad = data.slice();
      bad[at] ^= 4;
      await rejects(f(key, bad), Error, `${what}, changed at ${at}`);
    }
    await rejects(f(key, data.subarray(0, data.length - 16)), Error, `${what}, no final tag`);
    const other = key.slice();
    other[1] ^= 1;
    await rejects(f(other, data), Error, `${what}, another key`);
    if (t.mode === 3) {
      throws(() => crypto.ocbedDecrypt(key, data), RangeError, `${what}, as GnuPG's packet (no GCM there)`);
    } else {
      await rejects((t.packet === 18 ? crypto.ocbedDecrypt : crypto.seipdV2Decrypt)(key, data), Error, `${what}, the other packet`);
    }
  }
  console.log(`pgpcrypto: AEAD packets: ${Object.keys(modes).join(", ")}`);
  const k = new Uint8Array(16);
  throws(() => crypto.seipdV2Decrypt(k, unhex("070406" + "00".repeat(48))), RangeError, "SEIPD v2 AEAD mode 4");
  throws(() => crypto.ocbedDecrypt(k, unhex("070306" + "00".repeat(48))), RangeError, "OCB packet with GCM");
  throws(() => crypto.seipdV2Decrypt(k, unhex("070211" + "00".repeat(48))), RangeError, "SEIPD v2 chunk size 17");
  throws(() => crypto.seipdV2Decrypt(new Uint8Array(32), unhex("070206" + "00".repeat(48))), RangeError, "SEIPD v2 key for another cipher");
  throws(() => crypto.ocbedDecrypt(k, new Uint8Array(10)), RangeError, "OCB packet too short");
  throws(() => crypto.ocbedDecrypt(k, "x"), TypeError, "OCB packet data as a string");
  const big = V.aeadBig, data = base64(big.data);
  const plain = await timeJob(`OCB packet ${big.size / 1024} KiB`,
    (onProgress) => crypto.ocbedDecrypt(unhex(big.key), data, { onProgress }));
  ok(plain.length === big.size && plain.every((x) => x === 0), "OCB packet 256 KiB");
  for (const b of V.aeadBigOther) {
    const d = base64(b.data);
    const p = await timeJob(`SEIPD v2 ${b.name} ${b.size / 1024} KiB`,
      (onProgress) => crypto.seipdV2Decrypt(unhex(b.key), d, { onProgress }));
    ok(p.length === b.size && p.every((x) => x === 0), `SEIPD v2 ${b.name} ${b.size / 1024} KiB`);
  }
});

group("gk:zlib", async () => {
  for (const t of V.zlibSmall) {
    const out = await zlib.inflate(unhex(t.data), { format: t.format, maxOutput: Math.max(1, t.plain.length / 2) });
    ok(hex(out) === t.plain, `inflate ${t.format} ${t.plain.length / 2} bytes`);
  }
  const small = V.zlibSmall.find((t) => t.format === "zlib" && t.plain.length > 1000);
  const d = unhex(small.data);
  await rejects(zlib.inflate(d, { format: "zlib", maxOutput: small.plain.length / 2 - 1 }), RangeError, "inflate over maxOutput");
  await rejects(zlib.inflate(d.subarray(0, d.length - 1), { format: "zlib", maxOutput: 1 << 20 }), Error, "inflate cut");
  await rejects(zlib.inflate(d, { format: "raw", maxOutput: 1 << 20 }), Error, "inflate the other format");
  const bad = d.slice();
  bad[bad.length - 1] ^= 1;
  await rejects(zlib.inflate(bad, { format: "zlib", maxOutput: 1 << 20 }), Error, "inflate a wrong Adler-32");
  await rejects(zlib.inflate(new Uint8Array([...d, 0]), { format: "zlib", maxOutput: 1 << 20 }), Error, "inflate data after");
  throws(() => zlib.inflate(d, { format: "zlib" }), TypeError, "inflate without maxOutput");
  throws(() => zlib.inflate(d, { format: "gzip", maxOutput: 100 }), TypeError, "inflate gzip");
  throws(() => zlib.inflate(d, { format: "zlib", maxOutput: (32 << 20) + 1 }), RangeError, "inflate maxOutput over 32 MiB");
  throws(() => zlib.inflate(d, { format: "zlib", maxOutput: 0 }), RangeError, "inflate maxOutput 0");
  throws(() => zlib.inflate("x", { format: "zlib", maxOutput: 10 }), TypeError, "inflate a string");
  const mibData = unhex(V.zlibMiB.data), bomb = unhex(V.zlibBomb.data);	// not timed
  const mib = await timeJob("inflate 1 MiB", (onProgress) => zlib.inflate(mibData,
    { format: "zlib", maxOutput: 1 << 20, onProgress }));
  ok(hex(crypto.sha256(mib)) === V.zlibMiB.sha256, "inflate 1 MiB");
  await rejects(timeJob("inflate bomb, to the limit", (onProgress) => zlib.inflate(bomb,
    { format: "zlib", maxOutput: 32 << 20, onProgress })), RangeError, "inflate a bomb (33 MiB of zeros): refused at 32 MiB");
});

group("Argon2id", async () => {
  let n = 0;
  for (const v of V.argon2) {
    if (v.key || v.ad) continue;		// (the API has no secret or associated data)
    const got = await crypto.argon2id(unhex(v.password), unhex(v.salt),
      { passes: v.t, lanes: v.p, memoryKiB: v.m, length: v.length });
    ok(hex(got) === v.tag, `Argon2id t=${v.t} p=${v.p} m=${v.m} length=${v.length}`);
    n++;
  }
  console.log(`pgpcrypto: Argon2id: ${n} known answers`);
  // S2K type 4: the reference implementation's answer (src/crypto/argon2.c's self-test)
  ok(hex(await crypto.openpgpS2kArgon2("password", new Uint8Array(16).map((_, i) => i), 1, 4, 6, 16)) ===
     "637a25b4e2fd12a663f85ebbce4d8cc7", "S2K type 4");
  const salt = new Uint8Array(16);
  throws(() => crypto.openpgpS2kArgon2("p", salt, 1, 4, 21, 16), RangeError, "S2K type 4 with 2 GiB (RFC 9580's first option)");
  // a quarter of the board's memory: 128 MiB on the 512 MB Pi Zero (and QEMU's, and the simulator's)
  const cap = crypto.limits().argon2MemoryKiB;
  ok(cap === 128 * 1024, `Argon2 limit ${cap} KiB`);
  throws(() => crypto.openpgpS2kArgon2("p", salt, 1, 4, 18, 16), RangeError, "S2K type 4 with 256 MiB");
  throws(() => crypto.openpgpS2kArgon2("p", salt, 1, 4, 4, 16), RangeError, "S2K type 4 exponent below 3 + log2 p");
  throws(() => crypto.openpgpS2kArgon2("p", salt, 0, 4, 10, 16), RangeError, "S2K type 4 t = 0");
  throws(() => crypto.openpgpS2kArgon2("p", salt, 1, 0, 10, 16), RangeError, "S2K type 4 p = 0");
  throws(() => crypto.openpgpS2kArgon2("p", salt.subarray(1), 1, 4, 10, 16), RangeError, "S2K type 4 15-byte salt");
  throws(() => crypto.openpgpS2kArgon2("p", salt, 1, 4, 10, 3), RangeError, "S2K type 4 3-byte key");
  throws(() => crypto.argon2id("p", salt, { passes: 1, lanes: 1, memoryKiB: cap + 1, length: 16 }), RangeError,
         "Argon2id 128 MiB + 1 KiB");
  throws(() => crypto.argon2id("p", salt, { passes: 1, lanes: 4, memoryKiB: 31, length: 16 }), RangeError, "Argon2id m < 8p");
  throws(() => crypto.argon2id("p", salt, { passes: 1, lanes: 1, length: 16 }), TypeError, "Argon2id without memoryKiB");
  throws(() => crypto.argon2id("p", salt.subarray(0, 7), { passes: 1, lanes: 1, memoryKiB: 64, length: 16 }), RangeError,
         "Argon2id 7-byte salt");
  // RFC 9580's second option: 64 MiB, 3 passes, 4 lanes; then the most
  const k64 = await timeJob("Argon2id 64 MiB t=3 p=4", (onProgress) =>
    crypto.openpgpS2kArgon2("password", salt, 3, 4, 16, 32, { onProgress }));
  ok(k64.length === 32, "Argon2id 64 MiB");
  for (const round of [1, 2]) {
    const k = await timeJob(`Argon2id 128 MiB t=1 p=4 (${round})`, (onProgress) =>
      crypto.argon2id("password", salt, { passes: 1, lanes: 4, memoryKiB: cap, length: 32, onProgress }));
    ok(k.length === 32, `Argon2id 128 MiB (${round}: the memory again)`);
  }
});

group("AES-CFB limit", () => {
  const k = new Uint8Array(16), iv = new Uint8Array(16);
  ok(crypto.aesCfbEncrypt(k, iv, new Uint8Array(2 << 20)).length === 2 << 20, "AES-CFB 2 MiB");
  throws(() => crypto.aesCfbEncrypt(k, iv, new Uint8Array((2 << 20) + 1)), RangeError, "AES-CFB over 2 MiB");
});

group("timings", () => {
  const k = crypto.ed25519PrivateKey(new Uint8Array(32).fill(7)), m = crypto.sha256("m");
  let sig;
  time("Ed25519 sign x20", () => { for (let i = 0; i < 20; i++) sig = k.sign(m); });
  time("Ed25519 verify x20", () => { for (let i = 0; i < 20; i++) crypto.ed25519Verify(sig, m, k.publicKey); });
  time("Ed25519 key from seed x20", () => {
    for (let i = 0; i < 20; i++) crypto.ed25519PrivateKey(new Uint8Array(32).fill(i)).destroy();
  });
  k.destroy();
  const { key: rk, sigs } = V.rsaKeys.find((x) => x.bits === 4096);
  const pub = { n: unhex(rk.n), e: unhex(rk.e) }, digest = crypto.sha512("GapKeep");
  time("RSA-4096 verify x20", () => {
    for (let i = 0; i < 20; i++) crypto.rsaVerify(unhex(sigs["SHA-512"]), "SHA-512", digest, pub);
  });
  const mib = new Uint8Array(4 << 20);
  time("SHA-256 4 MiB", () => crypto.createHash("SHA-256").update(mib).digest());
  time("SHA-1 4 MiB", () => crypto.createHash("SHA-1").update(mib).digest());
  time("SHA-512 4 MiB", () => crypto.createHash("SHA-512").update(mib).digest());
  time("AES-128-CFB decrypt 2 MiB", () => crypto.aesCfbDecrypt(new Uint8Array(16), new Uint8Array(16), mib.subarray(0, 2 << 20)));
  const mem = sys.memory();
  console.log(`pgpcrypto: memory: JS heap ${mem.used} bytes`);
});

(async () => {
  console.log("pgpcrypto ready");
  for (const [name, fn] of groups) {
    status.text = name;
    await tick();
    try {
      await fn();
    } catch (e) {
      ok(false, `${name}: ${e && e.name}: ${e && e.message}`);
    }
  }
  status.text = `${passed} passed, ${failed} failed`;
  console.log(`pgpcrypto: ${passed} passed, ${failed} failed`);
  // a script the watchdog stops (10 s): the app's jobs end, rejected
  const cancelled = crypto.openpgpS2k(3, "SHA-1", "p", new Uint8Array(8), 255, 64);
  cancelled.catch(() => {});
  await new Promise((resolve) => setTimeout(() => { resolve(); while (true); }, 0));
  try {
    await cancelled;
    console.log("pgpcrypto: FAIL the job outlived the watchdog");
  } catch (e) {
    console.log(`pgpcrypto: job after the watchdog: ${e instanceof InternalError ? "cancelled" : "FAIL " + e}`);
  }
  // jobs left waiting for the Windows key (tests/pgpcrypto.txt): dropped
  // when the app stops, their promises never settled
  for (let i = 0; i < 4; i++) {
    crypto.openpgpS2k(3, "SHA-1", "p", new Uint8Array(8), 255, 64)
      .then(() => console.log("pgpcrypto: a long job ended before the Windows key"),
            () => console.log("pgpcrypto: FAIL a long job rejected"));
  }
  console.log("pgpcrypto: long jobs queued");
})();
