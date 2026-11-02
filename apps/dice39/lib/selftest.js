// dice39 self-test: published test vectors and invariants for the extracted
// dice39 logic. Runs in the app at startup (on zerogap's native SHA-256)
// and on the development machine under Node (tests/dice39/run_node.mjs).
//
// Needs a global `crypto` with subtle.digest and getRandomValues.

import { BIP39_WORDS } from "../vendor/wordlist.js";
import { buildMnemonic, importMnemonic, PHRASE_SIZES } from "../vendor/bip39core.js";
import { CODEX32 } from "../vendor/codex32.js";
import {
  diceTable, parseDiceCode, diceWordFor, isPartialDiceCode, sortedPairsSuspected,
  seedQrDigits, TABLE_WORDS, REROLL_CELLS,
} from "../vendor/dice.js";

const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// BIP-39 reference vectors (trezor/python-mnemonic vectors.json, English)
const BIP39_VECTORS = [
  ["00000000000000000000000000000000",
   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"],
  ["7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
   "legal winner thank year wave sausage worth useful legal winner thank yellow"],
  ["80808080808080808080808080808080",
   "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"],
  ["ffffffffffffffffffffffffffffffff",
   "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"],
  ["0000000000000000000000000000000000000000000000000000000000000000",
   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"],
  ["7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
   "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth " +
   "useful legal winner thank year wave sausage worth title"],
  ["8080808080808080808080808080808080808080808080808080808080808080",
   "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor " +
   "acoustic avoid letter advice cage absurd amount doctor acoustic bless"],
  ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
   "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote"],
  ["9e885d952ad362caeb4efe34a8e91bd2",
   "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic"],
  ["f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f",
   "void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing " +
   "screen patrol group space point ten exist slush involve unfold"],
];

// BIP-93 test vectors 1 and 2
const CODEX32_VECTORS = [
  { shares: ["ms10testsxxxxxxxxxxxxxxxxxxxxxxxxxx4nzvca9cmczlw"],
    secret: "318c6318c6318c6318c6318c6318c631" },
  { shares: ["MS12NAMEA320ZYXWVUTSRQPNMLKJHGFEDCAXRPP870HKKQRM",
             "MS12NAMECACDEFGHJKLMNPQRSTUVWXYZ023FTR2GDZMPY6PN"],
    secret: "d1808e096b35b209ca12132b264662a5" },
];

export async function runDice39SelfTest() {
  let passed = 0;
  const failed = [];
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed.push(name + ": " + (e && e.message ? e.message : e) + (e && e.stack ? "\n" + e.stack : ""));
    }
  }
  function eq(a, b, what) {
    if (a !== b) throw new Error((what || "value") + ": expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
  }

  await test("wordlist", () => {
    eq(BIP39_WORDS.length, 2048, "length");
    eq(BIP39_WORDS[0], "abandon");
    eq(BIP39_WORDS[2047], "zoo");
    eq(new Set(BIP39_WORDS.map((w) => w.slice(0, 4))).size, 2048, "unique 4-letter prefixes");
  });

  await test("BIP-39 vectors", async () => {
    for (const [hex, phrase] of BIP39_VECTORS) {
      const r = await importMnemonic(BIP39_WORDS, phrase.split(" "));
      eq(bytesToHex(r.entropyBytes), hex, phrase.split(" ")[0] + "...");
    }
  });

  await test("BIP-39 bad checksum refused", async () => {
    const words = BIP39_VECTORS[0][1].split(" ");
    words[11] = "abandon";
    let code = null;
    try {
      await importMnemonic(BIP39_WORDS, words);
    } catch (e) {
      code = e.code;
    }
    eq(code, "CHECKSUM");
  });

  await test("buildMnemonic", async () => {
    for (const total of [12, 24]) {
      const spec = PHRASE_SIZES[total];
      for (let n = spec.minUser; n <= spec.maxUser; n++) {
        const user = [];
        for (let i = 0; i < n; i++) user.push(BIP39_WORDS[(i * 389 + n * 7 + total) % 2048]);
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        const r = await buildMnemonic(BIP39_WORDS, user, seed, total);
        eq(r.finalWords.length, total, "length");
        for (let i = 0; i < n; i++) eq(r.finalWords[i], user[i], "verbatim word " + (i + 1));
        eq(r.userBits + r.deviceBits, spec.entropyBits, "bits");
        // the result must be a valid phrase with the same entropy
        const back = await importMnemonic(BIP39_WORDS, r.finalWords);
        eq(bytesToHex(back.entropyBytes), bytesToHex(r.entropyBytes), "round trip");
      }
    }
  });

  await test("detectors", async () => {
    const seed = new Uint8Array(32);
    const same = new Array(12).fill("zoo");
    eq((await buildMnemonic(BIP39_WORDS, same, seed, 24)).patternSuspected, "identical");
    const ordered = BIP39_WORDS.slice(100, 112);
    eq((await buildMnemonic(BIP39_WORDS, ordered, seed, 24)).patternSuspected, "ordered");
    const even = BIP39_WORDS.filter((w, i) => i % 2 === 0).slice(0, 12).reverse();
    eq((await buildMnemonic(BIP39_WORDS, even, seed, 24)).coinSkipSuspected, true, "coin skip");
  });

  await test("dice tables", () => {
    const seen = new Set();
    for (const parity of [0, 1]) {
      const cells = diceTable(parity);
      eq(cells.length, 1296, "cells");
      eq(cells.filter((c) => c === null).length, REROLL_CELLS, "rerolls");
      const words = cells.filter((c) => c !== null);
      eq(words.length, TABLE_WORDS, "words");
      for (const w of words) {
        eq(BIP39_WORDS.indexOf(w) & 1, parity, "parity of " + w);
        seen.add(w);
      }
    }
    eq(seen.size, 2048, "both tables cover the wordlist");
  });

  await test("dice codes", () => {
    const c = parseDiceCode("a1111");
    eq(c.parity, 0);
    eq(c.col, 0);
    eq(c.row, 0);
    eq(parseDiceCode("3526").parity, null, "no coin");
    eq(parseDiceCode("t 35-26").parity, 1, "separators");
    eq(parseDiceCode("3527"), null, "seven");
    eq(parseDiceCode("abandon"), null, "word");
    eq(isPartialDiceCode("a35"), true);
    eq(isPartialDiceCode("abc"), false);
    eq(diceWordFor(parseDiceCode("a1111")), diceTable(0)[0]);
  });

  await test("sorted pairs", () => {
    // words off cells whose pairs all read low-to-high
    const words = [];
    for (let k = 0; words.length < 8; k++) {
      const code = parseDiceCode("a" + "1234".slice(0, 2) + String(1 + (k % 6)) + String(1 + (k % 6)));
      const w = diceWordFor(code);
      if (w) words.push(w);
    }
    eq(sortedPairsSuspected(words), "up");
  });

  await test("SeedQR digits", () => {
    eq(seedQrDigits(["abandon", "zoo", "about"]), "000020470003");
  });

  await test("codex32 vectors", () => {
    // vector 1 is an unshared secret (threshold 0): decode it. (dice39's
    // cxRecover rejects threshold-0 strings with "checksum failed".)
    const v1 = CODEX32_VECTORS[0];
    eq(bytesToHex(CODEX32.cxSeedFromData(CODEX32.cxDecode(v1.shares[0]))), v1.secret, "vector 1");
    const v2 = CODEX32_VECTORS[1];
    eq(bytesToHex(CODEX32.cxRecover(v2.shares.map((s) => s.toLowerCase())).seed), v2.secret, "vector 2");
  });

  await test("codex32 split and recover", () => {
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    for (const [k, n] of [[2, 3], [2, 4], [3, 5]]) {
      const { shares } = CODEX32.cxSplit(seed, k, n, "zgap");
      eq(shares.length, n, "share count");
      const r = CODEX32.cxRecover(shares.slice(n - k));
      eq(bytesToHex(r.seed), bytesToHex(seed), k + "-of-" + n);
    }
  });

  return { passed, failed };
}
