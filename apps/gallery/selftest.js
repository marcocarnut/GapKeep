// Runtime self-test. Exercises the gk:ui object model, timers, promises,
// modules and permissions. Returns { passed, failed: [names] }.

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as crypto from "gk:crypto";
import * as session from "gk:session";
import { double } from "./lib/util.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSelfTest(parent) {
  let passed = 0;
  const failed = [];

  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed.push(`${name}: ${e && e.message ? e.message : e}`);
    }
  }
  function eq(a, b, what) {
    if (a !== b) throw new Error(`${what || "value"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
  function throws(fn, type, what) {
    try {
      fn();
    } catch (e) {
      if (type && !(e instanceof type)) throw new Error(`${what}: wrong error type ${e}`);
      return;
    }
    throw new Error(`${what}: did not throw`);
  }

  const box = new ui.Container(parent, { hidden: true });

  await test("relative import", () => eq(double(21), 42));

  await test("label text", () => {
    const l = new ui.Label(box, { text: "abc" });
    eq(l.text, "abc");
    l.text = "def";
    eq(l.text, "def");
    l.set({ text: 12 });
    eq(l.text, "12", "number coerced");
  });

  await test("set() chains", () => {
    const l = new ui.Label(box);
    eq(l.set({ text: "x" }), l);
  });

  await test("unknown property throws", () => {
    throws(() => new ui.Label(box, { txet: "typo" }), TypeError, "constructor");
    throws(() => new ui.Label(box).set({ checked: true }), TypeError, "wrong widget");
  });

  await test("the camera needs its permission", () => {
    // the gallery doesn't ask for "camera" in its manifest
    throws(() => new ui.Scanner(box, { detect: ["qr"] }), TypeError, "Scanner");
  });

  await test("bad values throw", () => {
    const c = new ui.Container(box);
    throws(() => c.set({ width: "wide" }), TypeError, "size");
    throws(() => c.set({ bg: "red" }), TypeError, "color");
    throws(() => c.set({ font: 13 }), TypeError, "font");
    throws(() => c.set({ layout: "grid" }), TypeError, "enum");
    c.set({ width: "50%", height: "content", bg: "#123", color: 0xffffff, font: 20, layout: "row" });
  });

  await test("instanceof and type", () => {
    const b = new ui.Button(box, { text: "b" });
    eq(b instanceof ui.Button, true);
    eq(b instanceof ui.Widget, true);
    eq(b instanceof ui.Label, false);
    eq(b.type, "Button");
    eq(b.text, "b");
  });

  await test("subclassing", () => {
    class Big extends ui.Label {
      shout() {
        this.text = this.text.toUpperCase();
      }
    }
    const l = new Big(box, { text: "hi" });
    l.shout();
    eq(l.text, "HI");
    eq(l instanceof Big, true);
  });

  await test("tree identity", () => {
    const c = new ui.Container(box);
    const l = new ui.Label(c);
    eq(l.parent, c);
    eq(c.children.length, 1);
    eq(c.children[0], l);
  });

  await test("delete", async () => {
    const c = new ui.Container(box);
    const l = new ui.Label(c, { text: "x" });
    l.delete();
    eq(l.alive, false);
    throws(() => (l.text = "y"), TypeError, "use after delete");
    l.delete(); // twice is fine
    eq(c.children.length, 0, "children after delete");
    c.clear();
    await sleep(20);
    eq(c.alive, true);
  });

  await test("clear", () => {
    const c = new ui.Container(box);
    new ui.Label(c);
    new ui.Label(c);
    const kids = c.children;
    c.clear();
    eq(kids[0].alive || kids[1].alive, false);
  });

  await test("textarea", () => {
    const t = new ui.TextArea(box, { oneLine: true, accept: "0123456789", maxLength: 4 });
    t.text = "12";
    eq(t.text, "12");
  });

  await test("checkbox and switch", () => {
    const c = new ui.Checkbox(box, { checked: true });
    eq(c.checked, true);
    c.checked = false;
    eq(c.checked, false);
    const s = new ui.Switch(box);
    eq(s.checked, false);
  });

  await test("dropdown", () => {
    const d = new ui.Dropdown(box, { options: ["a", "b", "c"], selected: 2 });
    eq(d.selected, 2);
  });

  await test("slider and bar", () => {
    const s = new ui.Slider(box, { min: 10, max: 20, value: 15 });
    eq(s.value, 15);
    eq(s.min, 10);
    s.value = 99;
    eq(s.value, 20, "clamped");
    const b = new ui.Bar(box, { max: 50, value: 25 });
    eq(b.value, 25);
  });

  await test("table", () => {
    const t = new ui.Table(box, { data: [["a", "b"], ["c"]] });
    eq(t.rows, 2);
    eq(t.cols, 2);
    eq(t.getCell(0, 1), "b");
    eq(t.getCell(1, 1), "");
    t.setCell(1, 1, "d");
    eq(t.getCell(1, 1), "d");
    eq(t.getCell(9, 9), undefined);
  });

  await test("qrcode", () => {
    const step = (name, f) => { try { f(); } catch (e) { throw new Error(name + ": " + e.message); } };
    let q;
    step("create", () => (q = new ui.QRCode(box, { size: 200, data: "hello" })));
    step("words", () => (q.data = "abandon ".repeat(24)));
    throws(() => (q.data = "x".repeat(5000)), RangeError, "too long");
    eq(q.modules, 57, "rejected data leaves the code unchanged");
    // SeedQR: 96 digits, numeric mode, ECC L -> version 3 (29 modules)
    step("digits", () => q.set({ ecc: "L", data: "0".repeat(96) }));
    eq(q.modules, 29, "SeedQR 24 words");
    // Compact SeedQR: 32 bytes, byte mode, ECC L -> version 2 (25 modules)
    step("bytes", () => (q.data = new Uint8Array(32).fill(0xa5)));
    eq(q.modules, 25, "Compact SeedQR");
    // codex32 share, uppercase -> alphanumeric, ECC M -> 33 modules (dice39 README)
    step("codex32", () => q.set({ ecc: "M", data: "MS12NAMEA320ZYXWVUTSRQPNMLKJHGFEDCAXRPP870HKKQRMXXXXXXXXXXXXXXXXXXXXXXXXXX" }));
    eq(q.modules, 33, "codex32 share");
    throws(() => q.set({ size: 40 }), RangeError, "too small");
    eq(q.modules, 33, "rejected size leaves the code unchanged");
  });

  await test("tabview", () => {
    const t = new ui.TabView(box);
    const a = t.addTab("A");
    t.addTab("B");
    eq(a instanceof ui.Container, true);
    t.active = 1;
    eq(t.active, 1);
  });

  await test("handlers via on() and props", () => {
    const b = new ui.Button(box);
    const f = () => {};
    b.on("click", f);
    eq(b.onClick, f);
    b.onClick = null;
    eq(b.onClick, undefined);
    throws(() => b.on("hover", f), TypeError, "unknown event");
  });

  await test("timers", async () => {
    const order = [];
    setTimeout(() => order.push("b"), 30);
    setTimeout(() => order.push("a"), 10);
    const cancelled = setTimeout(() => order.push("x"), 20);
    clearTimeout(cancelled);
    let n = 0;
    const iv = setInterval(() => {
      if (++n === 3) clearInterval(iv);
    }, 5);
    await sleep(80);
    eq(order.join(""), "ab", "order");
    eq(n, 3, "interval count");
  });

  await test("promises and async", async () => {
    const v = await Promise.all([1, Promise.resolve(2), sleep(5).then(() => 3)]);
    eq(v.join(","), "1,2,3");
  });

  await test("sys", () => {
    eq(typeof sys.version.zerogap, "string");
    eq(sys.app.id, "gallery");
    const m = sys.memory();
    if (!(m.used > 0 && m.limit > m.used)) throw new Error("memory: " + JSON.stringify(m));
    const t0 = sys.uptime();
    if (!(t0 > 0)) throw new Error("uptime");
  });

  await test("permissions", async () => {
    let err = null;
    try {
      await import("gk:apps");
    } catch (e) {
      err = e;
    }
    if (!err || !/permission/.test(err.message)) throw new Error("gk:apps was importable: " + err);
  });

  await test("bare imports rejected", async () => {
    let err = null;
    try {
      await import("lodash");
    } catch (e) {
      err = e;
    }
    if (!err) throw new Error("bare import worked");
  });

  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  await test("sha256 vectors", () => {
    eq(hex(crypto.sha256("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty");
    eq(hex(crypto.sha256("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "abc");
    eq(hex(crypto.sha256(new Uint8Array([0x61, 0x62, 0x63]))), hex(crypto.sha256("abc")), "bytes");
    const buf = new Uint8Array([0, 0x61, 0x62, 0x63, 0]);
    eq(hex(crypto.sha256(buf.subarray(1, 4))), hex(crypto.sha256("abc")), "subarray");
    eq(hex(crypto.sha256(buf.buffer.slice(1, 4))), hex(crypto.sha256("abc")), "ArrayBuffer");
    eq(hex(crypto.sha256("\u00e9")), hex(crypto.sha256(new Uint8Array([0xc3, 0xa9]))), "UTF-8");
    throws(() => crypto.sha256(42), TypeError, "number");
  });

  await test("sha1, sha512, hmac vectors", () => {
    eq(hex(crypto.sha1("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d", "sha1 abc");
    eq(hex(crypto.sha512("abc")), "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
      "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", "sha512 abc");
    // FIPS 180-4's two-block message
    eq(hex(crypto.sha512("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")),
      "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018" +
      "501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909", "sha512 two blocks");
    // RFC 2202 case 2, RFC 4231 case 2 and 6
    eq(hex(crypto.hmac("SHA-1", "Jefe", "what do ya want for nothing?")), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79", "hmac sha1");
    eq(hex(crypto.hmac("SHA-256", "Jefe", "what do ya want for nothing?")),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "hmac sha256");
    eq(hex(crypto.hmac("SHA-512", new Uint8Array(131).fill(0xaa), "Test Using Larger Than Block-Size Key - Hash Key First")),
      "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352" +
      "6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598", "hmac sha512 long key");
    throws(() => crypto.hmac("MD5", "k", "m"), TypeError, "unknown hash");
    // how fast, for the log: a TOTP code is one HMAC of 8 bytes
    const key = new Uint8Array(64), msg = new Uint8Array(8);
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) crypto.hmac("SHA-512", key, msg);
    console.log(`selftest: 200 HMAC-SHA512 in ${Date.now() - t0} ms`);
  });

  await test("bitcoin crypto vectors", () => {
    const unhex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
    const u32 = (i) => new Uint8Array([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);
    const cat = (...a) => { const r = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { r.set(x, o); o += x.length; } return r; };
    // RIPEMD-160 (its authors' vectors), HASH160
    eq(hex(crypto.ripemd160("abc")), "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc", "ripemd160 abc");
    eq(hex(crypto.ripemd160("")), "9c1185a5c5e9fc54612808977ee8f548b2258d31", "ripemd160 empty");
    // BIP-39's first vector (passphrase "TREZOR"), then the seed of the BIP-84/86 vectors
    const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    eq(hex(crypto.pbkdf2("SHA-512", words, "mnemonicTREZOR", 2048, 64)).slice(0, 32), "c55257c360c07c72029aebc1b53c05ed", "bip39");
    const t0 = Date.now();
    const seed = crypto.pbkdf2("SHA-512", words, "mnemonic", 2048, 64);
    console.log(`selftest: BIP-39 seed (PBKDF2, 2048 iterations) in ${Date.now() - t0} ms`);
    // BIP-32, from HMAC-SHA512 and the tweaks
    const master = (s) => { const i = crypto.hmac("SHA-512", "Bitcoin seed", s); return { k: i.slice(0, 32), c: i.slice(32) }; };
    const child = (n, i) => {
      const data = i >= 0x80000000 ? cat([0], n.k, u32(i)) : cat(crypto.publicKey(n.k), u32(i));
      const I = crypto.hmac("SHA-512", n.c, data);
      return { k: crypto.privateKeyTweakAdd(n.k, I.slice(0, 32)), c: I.slice(32) };
    };
    const derive = (s, path) => path.reduce(child, master(s));
    const H = 0x80000000;
    let n = master(unhex("000102030405060708090a0b0c0d0e0f"));
    eq(hex(crypto.publicKey(n.k)), "0339a36013301597daef41fbe593a02cc513d0b55527ec2df1050e2e8ff49c85c2", "bip32 m");
    eq(hex(crypto.hash160(crypto.publicKey(n.k)).slice(0, 4)), "3442193e", "bip32 fingerprint");
    const t1 = Date.now();
    n = derive(unhex("000102030405060708090a0b0c0d0e0f"), [H, 1, H + 2, 2, 1000000000]);
    console.log(`selftest: BIP-32 derivation of 5 levels in ${Date.now() - t1} ms`);
    eq(hex(n.k), "471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8", "bip32 m/0'/1/2'/2/1000000000");
    eq(hex(n.c), "c783e67b921d2beb8f6b389cc646d7263b4145701dadd2161548a8b078e65e9e", "chain code");
    // public derivation agrees with private derivation (m/0'/1: non-hardened)
    const p = derive(unhex("000102030405060708090a0b0c0d0e0f"), [H]);
    const I = crypto.hmac("SHA-512", p.c, cat(crypto.publicKey(p.k), u32(1)));
    eq(hex(crypto.publicKeyTweakAdd(crypto.publicKey(p.k), I.slice(0, 32))), hex(crypto.publicKey(child(p, 1).k)), "public child");
    // BIP-84: m/84'/0'/0'/0/0, HASH160 of the key (the bc1q... address's program)
    n = derive(seed, [H + 84, H, H, 0, 0]);
    eq(hex(crypto.hash160(crypto.publicKey(n.k))), "c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2", "bip84");
    // BIP-86: m/86'/0'/0'/0/0, Taproot output key (key path only)
    n = derive(seed, [H + 86, H, H, 0, 0]);
    const internal = crypto.xOnlyPublicKey(n.k);
    eq(hex(internal), "cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115", "bip86 internal key");
    const tag = crypto.sha256("TapTweak"), tweak = crypto.sha256(cat(tag, tag, internal));
    const out = crypto.taprootTweakPublicKey(internal, tweak);
    eq(hex(out.key), "a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c", "bip86 output key");
    const tk = crypto.taprootTweakPrivateKey(n.k, tweak);
    eq(hex(crypto.xOnlyPublicKey(tk)), hex(out.key), "tweaked private key");
    const msg = crypto.sha256("taproot");
    eq(crypto.schnorrVerify(crypto.schnorrSign(msg, tk), msg, out.key), true, "key path signature");
    // BIP-340 vector 1; ECDSA with a fixed answer (tools/check_secp.py)
    eq(hex(crypto.schnorrSign(unhex("243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89"),
      unhex("b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef"), unhex("00".repeat(31) + "01"))),
      "6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a", "bip340");
    const sk = unhex("a21a34790d3f9500557103d4fa928af2d38f60f8aa6afffaeca13ade4dbebf6b");
    const h = unhex("16a953f4f7310ae79ca041f85b5517a4dfeb71ea22cf2589f5fde8d9f1a865dd");
    const t2 = Date.now();
    const sig = crypto.ecdsaSign(h, sk);
    console.log(`selftest: ECDSA signature in ${Date.now() - t2} ms`);
    eq(hex(sig), "3044022002425694db6e80cdfb7b4794b4aaa4fb02fe4767bac24111e11f37d4ee473ace02204639f435238b9d280f4434736c5698d57dd3e07926f3f2f5fc0bf293b2dec816", "ecdsa");
    const pub = crypto.publicKey(sk, false);
    eq(pub.length, 65, "uncompressed");
    eq(crypto.ecdsaVerify(sig, h, pub) && crypto.ecdsaVerify(sig, h, crypto.publicKeyConvert(pub)), true, "verify");
    h[0] ^= 1;
    eq(crypto.ecdsaVerify(sig, h, pub), false, "verify fails");
    // bad input
    eq(crypto.isPrivateKey(new Uint8Array(32)), false, "zero key");
    eq(crypto.isPrivateKey(unhex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")), false, "key = n");
    eq(crypto.isPublicKey(unhex("02" + "00".repeat(32))), false, "not on the curve");
    throws(() => crypto.publicKey(new Uint8Array(32)), RangeError, "publicKey(0)");
    throws(() => crypto.publicKey("secret"), TypeError, "a key as a string");
    throws(() => crypto.ecdsaSign(new Uint8Array(31), sk), RangeError, "short hash");
    throws(() => crypto.pbkdf2("SHA-512", "p", "s", 0, 64), RangeError, "0 iterations");
  });

  await test("session store", () => {
    const value = { bytes: new Uint8Array([1, 2, 255]), list: [1, "two", null], when: new Date(0) };
    session.set("selftest", value);
    const back = session.get("selftest");
    eq(back !== value && back.bytes instanceof Uint8Array, true, "a copy");
    eq(hex(back.bytes) + JSON.stringify(back.list) + back.when.getTime(), "0102ff[1,\"two\",null]0", "round trip");
    throws(() => session.set("selftest", { f() {} }), TypeError, "function");
    eq(session.remove("selftest"), true, "remove");
    eq(session.get("selftest"), undefined, "removed");
  });

  await test("random bytes", () => {
    eq(crypto.rngStatus().healthy, true, "healthy");
    const a = crypto.randomBytes(32), b = crypto.randomBytes(32);
    eq(a.length, 32);
    eq(a instanceof Uint8Array, true);
    if (hex(a) === hex(b)) throw new Error("two draws are equal");
    const big = crypto.randomBytes(4096);
    const seen = new Set(big);
    if (seen.size < 200) throw new Error("only " + seen.size + " distinct byte values in 4096");
    const u = new Uint32Array(4);
    eq(crypto.getRandomValues(u), u, "in place");
    if (u.every((x) => x === 0)) throw new Error("not filled");
    throws(() => crypto.randomBytes(70000), RangeError, "too many");
  });

  await test("modern JS", () => {
    const { a, ...rest } = { a: 1, b: 2, c: 3 };
    eq(Object.keys(rest).join(), "b,c");
    eq(10n ** 20n > 0n, true, "BigInt");
    eq([1, [2, [3]]].flat(Infinity).join(), "1,2,3");
    eq("x".padStart(3, "-"), "--x");
    eq(new Uint8Array([1, 2, 3]).reduce((s, v) => s + v), 6);
    // regression: miscompiled under strict aliasing on arm-none-eabi
    eq([..."héllo"].join("|"), "h|é|l|l|o", "string iteration");
  });

  box.delete();
  return { passed, failed };
}
