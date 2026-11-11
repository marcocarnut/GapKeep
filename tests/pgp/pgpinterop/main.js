// A small OpenPGP signer and decrypter on gk:crypto, for
// tests/pgp/run_gpg_interop.sh: reads GnuPG-exported secret keys
// (data/pgp-interop/*.key), unlocks them with the passphrase (S2K,
// AES-CFB, the SHA-1 check of RFC 9580, 5.5.3), makes v4 detached
// signatures of message.bin, logged as hex for the script to check with
// gpg --verify, and decrypts the messages gpg encrypted to the keys'
// encryption subkeys (*.msg: PKESK, then SEIPD v1), logging the plaintext's
// SHA-256. Also: a wrong passphrase must fail the check, a changed message
// must be refused. Logs no key material and no plaintext.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as data from "gk:data";
import * as crypto from "gk:crypto";
import * as zlib from "gk:zlib";

const FOLDER = "pgp-interop";
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const log = (s) => console.log(`pgpinterop: ${s}`);
const HASHES = { 2: "SHA-1", 8: "SHA-256", 9: "SHA-384", 10: "SHA-512", 11: "SHA-224" };
const HASH_IDS = { "SHA-256": 8, "SHA-512": 10 };
const AES_KEY = { 7: 16, 8: 24, 9: 32 };

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
const u16 = (n) => new Uint8Array([n >> 8, n & 255]);
const u32 = (n) => new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

function stripZeros(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}
function mpi(b) {
  const v = stripZeros(b);
  const bits = v[0] === 0 ? 0 : (v.length - 1) * 8 + (32 - Math.clz32(v[0]));
  return cat(u16(bits), v);
}

// packets: [{ tag, body }], old and new formats, partial body lengths
// joined
function packets(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const ctb = bytes[i++];
    let tag, len;
    if (ctb & 0x40) {
      tag = ctb & 63;
      const parts = [];
      for (;;) {
        const o = bytes[i++];
        if (o >= 224 && o < 255) {			// partial: 2^(o & 31), more follow
          const n = 1 << (o & 31);
          parts.push(bytes.subarray(i, i + n));
          i += n;
          continue;
        }
        if (o < 192) len = o;
        else if (o < 224) len = ((o - 192) << 8) + bytes[i++] + 192;
        else { len = (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0; i += 4; }
        break;
      }
      if (parts.length > 0) {
        parts.push(bytes.subarray(i, i + len));
        out.push({ tag, body: cat(...parts) });
        i += len;
        continue;
      }
    } else {
      tag = (ctb >> 2) & 15;
      const lt = ctb & 3;
      if (lt === 0) len = bytes[i++];
      else if (lt === 1) { len = bytes[i] << 8 | bytes[i + 1]; i += 2; }
      else if (lt === 2) { len = (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0; i += 4; }
      else len = bytes.length - i;			// indeterminate: to the end
    }
    out.push({ tag, body: bytes.subarray(i, i + len) });
    i += len;
  }
  return out;
}

function readMpi(b, at) {
  const bits = b[at] << 8 | b[at + 1];
  const n = (bits + 7) >> 3;
  return [b.subarray(at + 2, at + 2 + n), at + 2 + n];
}

// A v4 secret key or subkey packet (RFC 9580, 5.5.3): RSA (1),
// EdDSALegacy (22) or ECDH (18, with its KDF parameters)
function parseSecretKey(body) {
  if (body[0] !== 4) throw new Error("not a v4 key");
  const algo = body[5];
  let at = 6;
  const pub = {};
  if (algo === 1) {
    [pub.n, at] = readMpi(body, at);
    [pub.e, at] = readMpi(body, at);
  } else if (algo === 22 || algo === 18) {
    const oidLen = body[at];
    pub.oid = body.subarray(at + 1, at + 1 + oidLen);
    at += 1 + oidLen;
    [pub.q, at] = readMpi(body, at);
    if (algo === 18) {
      pub.kdf = body.subarray(at, at + 1 + body[at]);	// 03 01 hash cipher
      at += pub.kdf.length;
    }
  } else {
    throw new Error(`algorithm ${algo}`);
  }
  const publicBody = body.subarray(0, at);
  const usage = body[at++];
  if (usage !== 254) throw new Error(`S2K usage ${usage}`);
  const cipher = body[at++];
  const type = body[at++];
  const hash = HASHES[body[at++]];
  if (type !== 3) throw new Error(`S2K type ${type}`);
  const salt = body.subarray(at, at + 8);
  const count = body[at + 8];
  at += 9;
  const iv = body.subarray(at, at + 16);
  const encrypted = body.subarray(at + 16);
  const fpr = crypto.sha1(cat(new Uint8Array([0x99]), u16(publicBody.length), publicBody));
  return { algo, pub, publicBody, cipher, hash, salt, count, iv, encrypted, fpr };
}

// the secret numbers, or null if the SHA-1 check fails (wrong passphrase)
async function unlock(key, passphrase) {
  const k = await crypto.openpgpS2k(3, key.hash, passphrase, key.salt, key.count, AES_KEY[key.cipher]);
  const plain = crypto.aesCfbDecrypt(k, key.iv, key.encrypted);
  k.fill(0);
  const body = plain.subarray(0, plain.length - 20), check = plain.subarray(plain.length - 20);
  if (hex(crypto.sha1(body)) !== hex(check)) { plain.fill(0); return null; }
  const out = { plain };
  let at = 0;
  for (const name of key.algo === 1 ? ["d", "p", "q", "u"] : ["seed"]) [out[name], at] = readMpi(body, at);
  return out;
}

async function signature(key, signer, hashName, message, time) {
  const hashed = cat(
    new Uint8Array([22, 33, 4]), key.fpr,               // issuer fingerprint
    new Uint8Array([5, 2]), u32(time));                 // creation time
  const head = cat(new Uint8Array([4, 0x00, key.algo, HASH_IDS[hashName]]), u16(hashed.length), hashed);
  const h = message.copy();
  h.update(head).update(cat(new Uint8Array([4, 0xff]), u32(head.length)));
  const digest = h.digest();
  const mpis = key.algo === 1
    ? mpi(await signer.sign(hashName, digest))
    : (() => { const s = signer.sign(digest); return cat(mpi(s.subarray(0, 32)), mpi(s.subarray(32))); })();
  const unhashed = cat(new Uint8Array([9, 16]), key.fpr.subarray(12));
  const body = cat(head, u16(unhashed.length), unhashed, digest.subarray(0, 2), mpis);
  const len = body.length < 192 ? new Uint8Array([body.length])
    : new Uint8Array([((body.length - 192) >> 8) + 192, (body.length - 192) & 255]);
  return cat(new Uint8Array([0xc2]), len, body);
}

const passphrase = data.readText(FOLDER, "passphrase.txt").trim();
const time = Number(data.readText(FOLDER, "time.txt").trim());
const message = crypto.createHash("SHA-256");
const message512 = crypto.createHash("SHA-512");
const m = data.read(FOLDER, "message.bin");
message.update(m);
message512.update(m);

for (const name of ["ed", "rsa"]) {
  try {
    const key = parseSecretKey(packets(data.read(FOLDER, `${name}.key`)).find((p) => p.tag === 5).body);
    log(`${name}: fingerprint ${hex(key.fpr)}, S2K ${key.hash} count ${key.count}, cipher ${key.cipher}`);
    log(`${name}: wrong passphrase ${(await unlock(key, passphrase + "x")) === null ? "refused" : "ACCEPTED"}`);
    const secret = await unlock(key, passphrase);
    if (secret === null) { log(`${name}: FAIL the right passphrase did not unlock`); continue; }
    log(`${name}: secret key decrypted, SHA-1 check passed`);
    let signer;
    if (key.algo === 22) {
      const seed = new Uint8Array(32);
      seed.set(secret.seed, 32 - secret.seed.length);
      signer = crypto.ed25519PrivateKey(seed);
      seed.fill(0);
      log(`${name}: public key ${hex(signer.publicKey) === hex(key.pub.q.subarray(1)) ? "matches" : "DIFFERS"}`);
    } else {
      signer = crypto.rsaPrivateKey({ n: key.pub.n, e: key.pub.e, d: secret.d, p: secret.p, q: secret.q, u: secret.u });
      log(`${name}: RSA-${signer.bits}, public key ${hex(signer.publicKey.n) === hex(key.pub.n) ? "matches" : "DIFFERS"}`);
    }
    secret.plain.fill(0);
    for (const [hashName, h] of [["SHA-256", message], ["SHA-512", message512]]) {
      log(`signature ${name}-${hashName} ${hex(await signature(key, signer, hashName, h, time))}`);
    }
    signer.destroy();
  } catch (e) {
    log(`${name}: FAIL ${e && e.name}: ${e && e.message}`);
  }
}
// --- decryption ---------------------------------------------------------------

const AES_IDS = { 7: 16, 8: 24, 9: 32 };

// the session key from the PKESK for this subkey: [algorithm, key bytes]
async function sessionKey(pkesk, sub, unlocker) {
  const body = pkesk.body;
  if (body[0] !== 3 || body[9] !== sub.algo) throw new Error("not a v3 PKESK for this key");
  let m;
  if (sub.algo === 1) {
    const [c] = readMpi(body, 10);
    const k = (unlocker.bits + 7) >> 3, padded = new Uint8Array(k);
    padded.set(c, k - c.length);
    m = await unlocker.decrypt(padded);		// implicit rejection: always bytes
  } else {
    // ECDH (RFC 9580, 11.5, legacy Curve25519): X25519, the KDF, key unwrap
    const [eph, at] = readMpi(body, 10);
    const wrapped = body.subarray(at + 1, at + 1 + body[at]);
    const z = unlocker.sharedSecret(eph.subarray(1));	// without its 0x40
    const hash = HASHES[sub.pub.kdf[2]], kekLen = AES_IDS[sub.pub.kdf[3]];
    const param = cat(new Uint8Array([sub.pub.oid.length]), sub.pub.oid, new Uint8Array([18]), sub.pub.kdf,
                      new Uint8Array([...("Anonymous Sender    ")].map((c) => c.charCodeAt(0))), sub.fpr);
    const h = crypto.createHash(hash).update(new Uint8Array([0, 0, 0, 1])).update(z).update(param).digest();
    const kek = h.subarray(0, kekLen);
    const padded = crypto.aesKeyUnwrap(kek, wrapped);
    kek.fill(0);
    z.fill(0);
    m = padded.subarray(0, padded.length - padded[padded.length - 1]);	// PKCS #5
  }
  const algo = m[0], key = m.subarray(1, m.length - 2);
  let sum = 0;
  for (const b of key) sum = (sum + b) & 0xffff;
  if (AES_IDS[algo] !== key.length || sum !== (m[m.length - 2] << 8 | m[m.length - 1])) {
    throw new Error("the session key's checksum failed");
  }
  return key;
}

async function decryptFile(file, sub, unlocker) {
  try {
    const all = packets(data.read(FOLDER, file));
    const pkesk = all.find((p) => p.tag === 1 && hex(p.body.subarray(1, 9)) === hex(sub.fpr.subarray(12)));
    const enc = all.find((p) => p.tag === 18 || p.tag === 20);
    if (!pkesk || !enc) throw new Error("not a PKESK and encrypted data");
    const key = await sessionKey(pkesk, sub, unlocker);
    let plain, how;
    if (enc.tag === 20 && enc.body[0] === 1) {
      plain = await crypto.ocbedDecrypt(key, enc.body.subarray(1));
      how = `GnuPG's OCB packet (chunk size octet ${enc.body[3]})`;
    } else if (enc.tag === 18 && enc.body[0] === 2) {
      plain = await crypto.seipdV2Decrypt(key, enc.body.subarray(1));
      how = "SEIPD v2";
    } else if (enc.tag === 18 && enc.body[0] === 1) {
      plain = await crypto.seipdV1Decrypt(key, enc.body.subarray(1));
      how = "SEIPD v1";
    } else {
      throw new Error(`packet ${enc.tag} version ${enc.body[0]}`);
    }
    key.fill(0);
    let inner = packets(plain)[0];
    if (inner.tag === 8) {
      // compressed: ZIP (1, raw DEFLATE) or ZLIB (2)
      const format = { 1: "raw", 2: "zlib" }[inner.body[0]];
      if (!format) throw new Error(`compression algorithm ${inner.body[0]}`);
      const out = await zlib.inflate(inner.body.subarray(1), { format, maxOutput: 16 << 20 });
      how += `, compressed (${format})`;
      inner = packets(out)[0];
    }
    if (inner.tag === 11) {
      const b = inner.body, at = 2 + b[1] + 4;		// format, name, date
      log(`decrypted ${file}: ${how}, literal data, sha256 ${hex(crypto.sha256(b.subarray(at)))}`);
    } else {
      log(`decrypted ${file}: FAIL packet ${inner.tag}`);
    }
  } catch (e) {
    log(`decrypted ${file}: refused (${e && e.name}: ${e && e.message})`);
  }
}

for (const name of ["ed", "rsa"]) {
  try {
    const sub = parseSecretKey(packets(data.read(FOLDER, `${name}.key`)).find((p) => p.tag === 7).body);
    const secret = await unlock(sub, passphrase);
    if (secret === null) { log(`${name}: FAIL the encryption subkey did not unlock`); continue; }
    log(`${name}: encryption subkey decrypted, algorithm ${sub.algo}`);
    let unlocker;
    if (sub.algo === 18) {
      // the legacy secret: a big-endian MPI of X25519's little-endian scalar
      const s = new Uint8Array(32);
      s.set(secret.seed, 32 - secret.seed.length);
      s.reverse();
      unlocker = crypto.x25519PrivateKey(s);
      s.fill(0);
      log(`${name}: X25519 public key ${hex(unlocker.publicKey) === hex(sub.pub.q.subarray(1)) ? "matches" : "DIFFERS"}`);
    } else {
      unlocker = crypto.rsaPrivateKey({ n: sub.pub.n, e: sub.pub.e, d: secret.d, p: secret.p, q: secret.q, u: secret.u });
    }
    secret.plain.fill(0);
    for (const file of name === "rsa" ? ["rsa-ocb.msg", "rsa-ocb-bad.msg", "rsa.msg", "rsa-bad.msg"]
         : ["ed-ocb.msg", "ed-ocb-small.msg", "ed-ocb-cut.msg", "ed-ocb-nolast.msg", "ed.msg", "ed-bad.msg"]) {
      await decryptFile(file, sub, unlocker);
    }
    unlocker.destroy();
  } catch (e) {
    log(`${name}: FAIL ${e && e.name}: ${e && e.message}`);
  }
}
log("done");
