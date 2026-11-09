// Test builds only: gk:session across runs, and gk:crypto's SHA-1,
// SHA-512 and HMAC (tests/session.txt). Each run counts itself in the
// session store and checks what the run before left there.

import * as ui from "gk:ui";
import * as session from "gk:session";
import * as crypto from "gk:crypto";

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else {
    failed++;
    console.log("sessiontest: FAIL " + name);
  }
}
function throws(name, fn, type) {
  try {
    fn();
    check(name + " (no exception)", false);
  } catch (e) {
    check(name + " (" + e + ")", e instanceof type);
  }
}
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// --- crypto: FIPS 180-4, RFC 2202 and RFC 4231 vectors ---
check("sha1 abc", hex(crypto.sha1("abc")) === "a9993e364706816aba3e25717850c26c9cd0d89d");
check("sha256 abc", hex(crypto.sha256("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
check("sha512 abc", hex(crypto.sha512(bytes("abc"))) ===
  "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
check("sha512 ArrayBuffer", hex(crypto.sha512(bytes("abc").buffer)).startsWith("ddaf35a1"));
check("sha1 view", hex(crypto.sha1(bytes("xabcx").subarray(1, 4))) === "a9993e364706816aba3e25717850c26c9cd0d89d");
check("hmac sha1 rfc2202 2", hex(crypto.hmac("SHA-1", "Jefe", "what do ya want for nothing?")) ===
  "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
check("hmac sha256 rfc4231 2", hex(crypto.hmac("SHA-256", bytes("Jefe"), "what do ya want for nothing?")) ===
  "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
check("hmac sha512 rfc4231 6", hex(crypto.hmac("SHA-512", new Uint8Array(131).fill(0xaa),
  "Test Using Larger Than Block-Size Key - Hash Key First")) ===
  "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598");
check("sha256 utf-8", hex(crypto.sha256("é")) === hex(crypto.sha256(new Uint8Array([0xc3, 0xa9]))));
throws("hmac unknown hash", () => crypto.hmac("MD5", "k", "m"), TypeError);
throws("hmac SHA1 spelling", () => crypto.hmac("SHA1", "k", "m"), TypeError);
throws("hmac no data", () => crypto.hmac("SHA-256", "k"), TypeError);
throws("sha1 number", () => crypto.sha1(42), TypeError);

// --- session: what the run before left ---
const runs = (session.get("runs") ?? 0) + 1;
const before = session.get("record");
if (runs > 1) {
  check("record kept", before !== undefined);
  check("record bytes", before.key instanceof Uint8Array && hex(before.key) === "00017f80ff");
  check("record nested", before.list[1].name === "bob" && before.list.length === 2);
  check("record date", before.when instanceof Date && before.when.getTime() === 1999999983000);
  check("record bigint", before.big === 12345678901234567890n);
  check("record unicode", before.text === "naïve ✓");
  check("record run", before.run === runs - 1);
  check("keys order", session.keys().join() === "runs,record");
} else {
  check("empty at first", before === undefined && session.keys().length === 0);
}

// copies, not references
const record = {
  run: runs,
  key: new Uint8Array([0, 1, 127, 128, 255]),
  list: [{ name: "alice" }, { name: "bob" }],
  when: new Date(1999999983000),
  big: 12345678901234567890n,
  text: "naïve ✓",
};
session.set("runs", runs);
session.set("record", record);
record.key[0] = 9;
check("stored a copy", session.get("record").key[0] === 0);
const a = session.get("record"), b = session.get("record");
check("get gives copies", a !== b && a.key !== b.key);

// what is refused, and leaves the store as it was
throws("function", () => session.set("f", { f() {} }), TypeError);
const cyc = {}; cyc.self = cyc;
throws("cycle", () => session.set("c", cyc), TypeError);
throws("map", () => session.set("m", new Map()), TypeError);
throws("empty key", () => session.set("", 1), RangeError);
throws("long key", () => session.set("k".repeat(65), 1), RangeError);
throws("number key", () => session.set(1, 1), TypeError);
throws("too big", () => session.set("big", new Uint8Array(70000)), RangeError);
check("refusals stored nothing", session.keys().join() === "runs,record");

// remove, undefined, usage, clear (on a scratch key)
session.set("scratch", "x".repeat(1000));
const used = session.usage();
check("usage", used.limit === 65536 && used.used > 1000 && used.used < 2000);
check("remove", session.remove("scratch") === true && session.remove("scratch") === false);
session.set("scratch", 1);
session.set("scratch", undefined);
check("set undefined removes", session.get("scratch") === undefined && session.keys().length === 2);
check("usage after", session.usage().used < used.used - 900);

console.log(`sessiontest: run ${runs}, ${passed} passed, ${failed} failed`);
new ui.Label({ text: `sessiontest run ${runs}: ${passed} passed, ${failed} failed` });
new ui.Button({
  text: "Clear",
  onClick: () => {
    session.clear();
    console.log(`sessiontest: cleared, ${session.keys().length} keys, used ${session.usage().used}`);
  },
}).focus();
