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
  time("AES-128-CFB decrypt 4 MiB", () => crypto.aesCfbDecrypt(new Uint8Array(16), new Uint8Array(16), mib));
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
