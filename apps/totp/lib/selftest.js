// The Authenticator's self-test: published vectors for the hashes, HMAC,
// HOTP and TOTP, and the parsers on known inputs. Runs in the app at start
// (after the first screen is up, yielding between tests) and under Node
// (tests/totp/run_node.mjs).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { SHA1, SHA512 } from "./sha.js";
import { makeHmac, hotp, totp, groupCode } from "./hotp.js";
import { base32Decode, parseCode, ParseError } from "./parse.js";

const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// RFC 4226, appendix D: HMAC-SHA1, secret "12345678901234567890", counters 0-9
const HOTP_VECTORS = ["755224", "287082", "359152", "969429", "338314",
  "254676", "287922", "162583", "399871", "520489"];

// RFC 6238, appendix B: 8 digits, 30 s, T0 = 0; the seeds are ASCII digits
// "1234567890" repeated to 20, 32 and 64 bytes
const SEEDS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
};
const TOTP_VECTORS = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

// HMAC with a key longer than the block: RFC 2202 test case 6 (SHA-1),
// RFC 4231 test case 6 (SHA-256, SHA-512)
const LONG_KEY_MESSAGE = "Test Using Larger Than Block-Size Key - Hash Key First";
const LONG_KEY_VECTORS = [
  ["SHA1", 80, "aa4ae5e15272d00e95705637ce8a3b55ed402112"],
  ["SHA256", 131, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
  ["SHA512", 131, "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352" +
                  "6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598"],
];

// a Google Authenticator export (made by tests/totp/make_migration.py):
// "Example" alice@example.com (SHA1, 8 digits) and "ACME Co:bob" (SHA256,
// 8 digits), with the RFC 6238 seeds
const MIGRATION_TWO = "otpauth-migration://offline?data=CjgKFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEhFhbGljZUBleGFtcGxlLmNvbRoHRXhhbXBsZSABKAIwAgo3CiAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMhILQUNNRSBDbzpib2IaACACKAIwAhABGAEgACi5YA%3D%3D";
// part 2 of 2, batch id -7: an HOTP key, an MD5 key, and a TOTP key with
// algorithm and digits unspecified (SHA1, 6)
const MIGRATION_MIXED = "otpauth-migration://offline?data=Ci0KFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEgVjYXJvbBoISG90cCBJbmMgASgBMAEKKwoUMTIzNDU2Nzg5MDEyMzQ1Njc4OTASBGRhdmUaB01kNSBJbmMgBCgBMAIKKAoUMTIzNDU2Nzg5MDEyMzQ1Njc4OTASBGVyaW4aBEdvb2QgACgAMAIQARgCIAEo%2Bf%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FAQ%3D%3D";

export async function runSelfTest() {
  let passed = 0;
  const failed = [];
  async function test(name, fn) {
    await yieldToUI();
    try {
      fn();
      passed++;
    } catch (e) {
      failed.push(name + ": " + (e && e.message ? e.message : e));
    }
  }
  function eq(a, b, what) {
    if (a !== b) throw new Error((what || "value") + ": expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
  }
  function refused(text, pattern) {
    try {
      parseCode(text);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      if (!pattern.test(e.message)) throw new Error("wrong message: " + e.message);
      return;
    }
    throw new Error("accepted: " + text.slice(0, 40));
  }

  await test("SHA-1", () => {
    eq(hex(SHA1.hash(ascii("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d", "abc");
    eq(hex(SHA1.hash(ascii("a".repeat(1000)))), "291e9a6c66994949b57ba5e650361e98fc36b1ba", "1000 a");
  });
  await test("SHA-512", () => {
    eq(hex(SHA512.hash(ascii("abc"))), "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
       "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", "abc");
    // FIPS 180-2's two-block message
    const m = "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
    eq(hex(SHA512.hash(ascii(m))), "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018" +
       "501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909", "two blocks");
  });
  await test("HMAC, long keys", () => {
    for (const [alg, n, want] of LONG_KEY_VECTORS) {
      eq(hex(makeHmac(alg, new Uint8Array(n).fill(0xaa)).mac(ascii(LONG_KEY_MESSAGE))), want, alg);
    }
  });
  await test("RFC 4226 HOTP", () => {
    const h = makeHmac("SHA1", ascii(SEEDS.SHA1));
    HOTP_VECTORS.forEach((want, counter) => eq(hotp(h, counter, 6), want, "counter " + counter));
  });
  for (const [i, alg] of ["SHA1", "SHA256", "SHA512"].entries()) {
    await test("RFC 6238 TOTP " + alg, () => {
      const h = makeHmac(alg, ascii(SEEDS[alg]));
      for (const v of TOTP_VECTORS) eq(totp(h, v[0] * 1000, 30, 8), v[i + 1], "T " + v[0]);
    });
  }
  await test("Base32", () => {
    // RFC 4648, section 10
    const v = [["", ""], ["MY======", "f"], ["MZXQ====", "fo"], ["MZXW6===", "foo"], ["MZXW6YQ=", "foob"],
      ["MZXW6YTB", "fooba"], ["MZXW6YTBOI======", "foobar"]];
    for (const [b32, text] of v.slice(1)) {
      eq(hex(base32Decode(b32)), hex(ascii(text)), b32);
      eq(hex(base32Decode(b32.replace(/=/g, "").toLowerCase())), hex(ascii(text)), b32 + " unpadded");
    }
    eq(hex(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")), hex(ascii(SEEDS.SHA1)), "spaces");
    for (const bad of ["MZXW6YQ1", "M", "MZX", "MZXW6Y", "MY=A", ""]) {
      let ok = false;
      try {
        base32Decode(bad);
      } catch (e) {
        ok = e instanceof ParseError;
      }
      if (!ok) throw new Error("accepted " + JSON.stringify(bad));
    }
  });
  await test("otpauth URIs", () => {
    let r = parseCode("otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example");
    eq(r.kind, "totp");
    eq(r.account.issuer, "Example");
    eq(r.account.name, "alice@google.com");
    eq(r.account.algorithm + r.account.digits + "/" + r.account.period, "SHA16/30", "defaults");
    r = parseCode("otpauth://totp/ACME%20Co:%20john+work@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" +
      "&issuer=ACME+Corp&algorithm=sha512&digits=8&period=60&image=x");
    eq(r.account.issuer, "ACME Corp", "the issuer parameter wins");
    eq(r.account.name, "john+work@example.com");
    eq(r.account.algorithm + r.account.digits + "/" + r.account.period, "SHA5128/60");
    r = parseCode("OTPAUTH://TOTP/bob?SECRET=jbswy3dpehpk3pxp");
    eq(r.account.issuer + "|" + r.account.name, "|bob", "no issuer");
    refused("otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=1", /HOTP/);
    refused("otpauth://totp/Example:alice?issuer=Example", /no secret/);
    refused("otpauth://totp/x?secret=JBSWY3DPEHPK3PX1", /Base32/);
    refused("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5", /algorithm/);
    refused("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7", /digits/);
    refused("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0", /period/);
    refused("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=3x", /period/);
    refused("otpauth://totp/%E0%A4?secret=JBSWY3DPEHPK3PXP", /%-escape/);
    refused("https://example.com/", /not an authenticator key/);
  });
  await test("Google Authenticator export", () => {
    let r = parseCode(MIGRATION_TWO);
    eq(r.kind, "migration");
    eq(r.accounts.length, 2, "accounts");
    eq(r.refused.length, 0, "refused");
    eq(r.batch.size + "/" + r.batch.index + "/" + r.batch.id, "1/0/12345", "batch");
    const [a, b] = r.accounts;
    eq([a.issuer, a.name, a.algorithm, a.digits, a.period].join("|"), "Example|alice@example.com|SHA1|8|30");
    eq([b.issuer, b.name, b.algorithm, b.digits].join("|"), "ACME Co|bob|SHA256|8", "issuer from the name");
    eq(totp(makeHmac(b.algorithm, b.secret), 2000000000 * 1000, 30, b.digits), "90698825", "code");
    r = parseCode(MIGRATION_MIXED);
    eq(r.accounts.length, 1, "accounts");
    eq(r.refused.length, 2, "refused");
    eq(r.batch.size + "/" + r.batch.index + "/" + r.batch.id, "2/1/-7", "batch");
    eq([r.accounts[0].issuer, r.accounts[0].algorithm, r.accounts[0].digits].join("|"), "Good|SHA1|6");
    if (!/HOTP/.test(r.refused[0]) || !/MD5/.test(r.refused[1])) throw new Error("reasons: " + r.refused);
    refused("otpauth-migration://offline?data=CjgKFDEy", /cut short/);
    refused("otpauth-migration://offline?data=%%%", /%-escape/);
    refused("otpauth-migration://offline?data=Cg", /cut short/);
    refused("otpauth-migration://offline", /export/);
  });
  await test("grouping", () => {
    eq(groupCode("123456"), "123 456");
    eq(groupCode("12345678"), "1234 5678");
  });

  return { passed, failed };
}
