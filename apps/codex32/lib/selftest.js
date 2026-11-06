// codex32 self-test: every BIP-93 test vector, valid and invalid, plus the
// app's own checks (set errors, typo suggestions, entropy to words). Runs in
// the app at start, after the first screen is up, and under Node
// (tests/codex32/run_node.mjs). Needs a global `crypto` with subtle.digest
// (the app's lib/cryptoshim.js, or Node's webcrypto) for the words.

import { VALID, ALTERNATIVES, INVALID } from "./vectors.js";
import { recover, recoverSeed, checkShare, findSubstitution, Codex32Error } from "./codex32.js";
import { cxDecode, cxSeedFromData } from "../vendor/codex32.js";
import { wordsFromEntropy, seedQrDigits, hex } from "../vendor/recover.js";

const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

export function subsets(n, k) {
  const out = [], cur = [];
  (function walk(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < n; i++) { cur.push(i); walk(i + 1); cur.pop(); }
  })(0);
  return out;
}

function eq(a, b, what) {
  if (a !== b) throw new Error((what || "value") + ": expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
}

function throwsCode(fn, code, what) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Codex32Error)) throw e;
    eq(e.code, code, what);
    return e;
  }
  throw new Error((what || "call") + ": did not throw");
}

// Replaces character i of s.
const swap = (s, i, c) => s.slice(0, i) + c + s.slice(i + 1);

export async function runCodex32SelfTest() {
  let passed = 0;
  const failed = [];
  async function test(name, fn) {
    await yieldToUI();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed.push(name + ": " + (e && e.message ? e.message : e));
    }
  }

  for (const v of VALID) {
    await test("BIP-93 " + v.name, () => {
      const r = recover(v.shares);
      eq(hex(r.seed), v.seed, "seed");
      eq(r.secret, v.secret, "secret");
      eq(hex(recoverSeed(v.shares)), v.seed, "recoverSeed");
      for (const s of v.shares) eq(checkShare(s).ok, true, "share valid");
    });
    if (v.derived) {
      await test("BIP-93 " + v.name + ", every " + v.k + " of its shares", async () => {
        const all = v.shares.concat(v.derived);
        for (const sub of subsets(all.length, v.k)) {
          await yieldToUI();
          eq(hex(recoverSeed(sub.map((i) => all[i]))), v.seed, "subset " + sub.join("+"));
        }
      });
    }
    await test("BIP-93 " + v.name + ", the secret alone", () => {
      eq(hex(recoverSeed([v.secret])), v.seed, "seed");
    });
  }

  await test("BIP-93 alternative encodings", () => {
    for (const a of ALTERNATIVES) {
      for (const s of a.secrets) eq(hex(recoverSeed([s])), a.seed, s.slice(0, 12));
    }
  });

  await test("BIP-93 invalid vectors (" + INVALID.length + ")", async () => {
    for (let i = 0; i < INVALID.length; i++) {
      if (i % 8 === 7) await yieldToUI();
      const [code, s] = INVALID[i];
      const r = checkShare(s, { suggest: false });   // the code is what is tested here
      eq(r.ok, false, "invalid vector " + (i + 1) + " accepted");
      eq(r.error.code, code, "invalid vector " + (i + 1));
    }
  });

  await test("sets of shares", () => {
    const [a, c] = VALID[1].shares;
    const other = VALID[2].shares[0];
    eq(throwsCode(() => recover([a]), "count").need, 2, "one share of two");
    throwsCode(() => recover([a, c, VALID[1].derived[0]]), "count", "three shares of two");
    eq(throwsCode(() => recover([a, a.toLowerCase()]), "duplicate").share, 2, "duplicate");
    eq(throwsCode(() => recover([a, other]), "mismatch").share, 2, "mismatch");
    eq(throwsCode(() => recover([a, swap(c, 20, "Q")]), "checksum").share, 2, "bad second share");
    throwsCode(() => recover([]), "none", "nothing");
    // spaces and line breaks are ignored
    eq(hex(recoverSeed([a.replace(/(.{4})/g, "$1 "), "\n" + c + " "])), VALID[1].seed, "grouped");
  });

  await test("typo suggestions", () => {
    const s = VALID[2].shares[0];   // ms13casha320...
    for (const i of [3, 9, 20, 40, 47]) {
      const typo = swap(s, i, s[i] === "q" ? "p" : "q");
      const r = checkShare(typo);
      eq(r.ok, false, "typo at " + (i + 1));
      if (i === 3) { eq(r.error.code, "threshold", "threshold typo"); continue; }
      eq(r.error.code, "checksum", "code at " + (i + 1));
      eq(r.error.position, i + 1, "position");
      eq(r.error.suggestion, s[i], "suggestion");
    }
    // upper case stays upper case
    const u = VALID[1].shares[1];
    eq(findSubstitution(swap(u, 30, "Q")).char, u[30].toLowerCase(), "upper");
    eq(checkShare(swap(u, 30, "Q")).error.suggestion, u[30], "upper suggestion");
    // a letter codex32 does not have, at a known place
    const b = checkShare(swap(s, 15, "b"));
    eq(b.error.code, "char", "b");
    eq(b.error.suggestion, s[15], "erasure filled");
    // long checksum
    const l = VALID[4].shares[0];
    eq(checkShare(swap(l, 100, l[100] === "Q" ? "P" : "Q")).error.suggestion, l[100], "long");
    // two typos: no single fix
    const two = swap(swap(s, 20, s[20] === "q" ? "p" : "q"), 30, s[30] === "q" ? "p" : "q");
    eq(checkShare(two).error.code, "checksum", "two typos");
    eq(checkShare(two).error.suggestion, undefined, "two typos: no suggestion");
    // missing character: a length message
    eq(checkShare(s.slice(0, 47)).error.code, "length", "short");
  });

  await test("vector 1 by decoding (the dice39 workaround)", () => {
    const v = VALID[0];
    eq(hex(cxSeedFromData(cxDecode(v.shares[0]))), v.seed, "cxDecode");
  });

  await test("entropy to BIP-39 words", async () => {
    const w12 = await wordsFromEntropy(new Uint8Array(16));
    eq(w12.join(" "), "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
      "abandon about", "16 zero bytes");
    const f = new Uint8Array(32).fill(0xff);
    eq((await wordsFromEntropy(f)).slice(-2).join(" "), "zoo vote", "32 ff bytes");
    // 15 and 18 words: the checksum is the top 5 and top 6 bits
    eq((await wordsFromEntropy(new Uint8Array(20).fill(0x7f))).slice(-2).join(" "), "sausage wise", "20 7f bytes");
    eq((await wordsFromEntropy(new Uint8Array(24).fill(0x7f))).slice(-2).join(" "), "legal will", "24 7f bytes");
    const v = new Uint8Array([0x9e, 0x88, 0x5d, 0x95, 0x2a, 0xd3, 0x62, 0xca, 0xeb, 0x4e, 0xfe, 0x34,
      0xa8, 0xe9, 0x1b, 0xd2]);
    eq((await wordsFromEntropy(v)).join(" "),
      "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic", "9e885d95...");
    eq(seedQrDigits(w12), "0000".repeat(11) + "0003", "SeedQR digits");
  });

  return { passed, failed };
}
