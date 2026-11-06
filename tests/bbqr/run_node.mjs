// Tests of lib/js/bbqr.js under Node:
//
//   node tests/bbqr/run_node.mjs
//
// The deflate stream is checked by zlib itself (Node's and Python's, both
// with a 1 KiB window, which refuse anything further back), the inflater
// against zlib's output (stored, fixed and dynamic blocks, 32 KiB windows),
// base32 against Python's base64 module, and splitting and joining in every
// encoding, order and size, with the faults a camera or a forger can bring.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { deflateRawSync, inflateRawSync, constants } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  split, Joiner, parsePart, isBBQr, BBQrError, partCapacity, deflateRaw, inflateRaw,
  toBase32, fromBase32, WINDOW, MAX_PARTS,
} from "../../lib/js/bbqr.js";

let passed = 0;
const failed = [];
function check(name, ok) {
  if (ok) passed++;
  else failed.push(name);
}
function throwsCode(name, code, fn) {
  try {
    fn();
  } catch (e) {
    check(`${name} (got ${e.code || e.name}: ${e.message})`, e instanceof BBQrError && e.code === code);
    return;
  }
  check(`${name} (no error)`, false);
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const py = (code, input) => execFileSync("python3", ["-I", "-c", code], { input, maxBuffer: 1 << 26 });

// a reproducible generator, so a failure can be run again
let seed = 12345;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return Math.floor((seed / 0x100000000) * n);
};
function sample(kind, n) {
  const a = new Uint8Array(n);
  if (kind === "random") for (let i = 0; i < n; i++) a[i] = rnd(256);
  if (kind === "text") for (let i = 0; i < n; i++) a[i] = "abcab cabbage, a b c "[rnd(21)].charCodeAt(0);
  if (kind === "zeros") a.fill(0);
  if (kind === "repeats") {
    // blocks that come back near and far: some within the window, some not
    const blocks = [];
    for (let b = 0; b < 8; b++) blocks.push(Uint8Array.from({ length: 40 + rnd(200) }, () => rnd(256)));
    let i = 0;
    while (i < n) {
      const b = blocks[rnd(blocks.length)];
      for (let k = 0; k < b.length && i < n; k++) a[i++] = b[k];
      if (rnd(3) === 0) for (let k = 0; k < 600 && i < n; k++) a[i++] = rnd(256);
    }
  }
  return a;
}
const KINDS = ["random", "text", "zeros", "repeats"];
const SIZES = [0, 1, 2, 3, 4, 5, 7, 8, 100, 257, 1023, 1024, 1025, 3000, 20000, 150000];

// --- deflate: zlib reads it, with a 1 KiB window -------------------------------
const pyChecks = [];
for (const kind of KINDS) {
  for (const n of SIZES) {
    const data = sample(kind, n), z = deflateRaw(data);
    let back = null;
    try {
      back = inflateRawSync(z, { windowBits: 10 });
    } catch (e) {
      back = null;
    }
    check(`deflate ${kind} ${n}: Node's zlib (windowBits 10) reads it`, back && eq(back, data));
    check(`deflate ${kind} ${n}: our inflater reads it`, eq(inflateRaw(z), data));
    if (n >= 1024) pyChecks.push({ data, z });
    if (kind === "zeros" && n >= 1000) check(`deflate zeros ${n}: compresses`, z.length < n / 50);
    // as good as zlib's best with the same window, give or take
    if (kind === "repeats" && n >= 3000) { // (zeros and random text need dynamic codes, which this deflate leaves out)
      const best = deflateRawSync(data, { level: 9, windowBits: 10 }).length;
      check(`deflate ${kind} ${n}: ${z.length} bytes, zlib ${best}`, z.length <= best * 1.15 + 16);
    }
  }
}
// Python's zlib, as Coldcard's firmware decodes (wbits -10)
{
  const hex = pyChecks.map(({ data, z }) => Buffer.from(z).toString("hex") + " " + createHash("sha256").update(data).digest("hex")).join("\n");
  const out = py(
    "import sys, zlib, hashlib\n" +
    "for line in sys.stdin.read().split('\\n'):\n" +
    "  z, h = line.split()\n" +
    "  print('ok' if hashlib.sha256(zlib.decompress(bytes.fromhex(z), -10)).hexdigest() == h else 'bad')\n", hex).toString();
  const lines = out.trim().split("\n");
  check(`Python's zlib (wbits -10) reads all ${pyChecks.length} streams`, lines.length === pyChecks.length && lines.every((l) => l === "ok"));
}
// nothing further back than the window, even when a better match lies there
{
  const block = sample("random", 300), filler = sample("random", 900);
  const data = new Uint8Array([...block, ...filler, ...block]);
  const z = deflateRaw(data);
  check("a match 1200 bytes back is not used", z.length > 1300);
  const middle = sample("random", 500);
  const near = new Uint8Array([...block, ...middle, ...block]);
  const none = new Uint8Array([...block, ...middle, ...sample("random", 300)]);
  check("a match 800 bytes back is used", deflateRaw(near).length < deflateRaw(none).length - 250);
  check(`WINDOW is 1024`, WINDOW === 1024);
}

// --- inflate: zlib's streams ---------------------------------------------------
for (const kind of KINDS) {
  for (const n of [0, 1, 100, 5000, 70000]) {
    const data = sample(kind, n);
    for (const [label, opts] of [
      ["level 9, 32 KiB window", { level: 9 }],
      ["level 0 (stored)", { level: 0 }],
      ["fixed codes", { level: 6, strategy: constants.Z_FIXED }],
      ["Huffman only", { level: 6, strategy: constants.Z_HUFFMAN_ONLY }],
      ["windowBits 10", { level: 9, windowBits: 10 }],
    ]) {
      const z = deflateRawSync(data, opts);
      let back = null;
      try {
        back = inflateRaw(new Uint8Array(z));
      } catch (e) {
        back = null;
      }
      check(`inflate ${kind} ${n}, ${label}`, back && eq(back, data));
    }
  }
}
// malformed and hostile streams
{
  const z = deflateRawSync(sample("text", 3000), { level: 9 });
  throwsCode("a stream cut short", "deflate", () => inflateRaw(new Uint8Array(z.subarray(0, z.length - 5))));
  throwsCode("block type 3", "deflate", () => inflateRaw(new Uint8Array([0x07, 0, 0])));
  throwsCode("a stored block with a bad length", "deflate", () => inflateRaw(new Uint8Array([1, 5, 0, 5, 0, 1, 2, 3, 4, 5])));
  throwsCode("a distance before the start", "deflate", () => {
    // fixed codes: length 3 (code 257), distance 1, at the very start
    const w = [];
    let acc = 0, bits = 0;
    const put = (v, k) => { acc |= v << bits; bits += k; while (bits >= 8) { w.push(acc & 255); acc >>>= 8; bits -= 8; } };
    const code = (v, k) => { let r = 0; for (let i = 0; i < k; i++) r |= ((v >> i) & 1) << (k - 1 - i); put(r, k); };
    put(1, 1); put(1, 2); code(1, 7); code(0, 5); code(0, 7); put(0, 8);
    inflateRaw(new Uint8Array(w));
  });
  const bomb = deflateRawSync(new Uint8Array(1 << 22), { level: 9 });
  throwsCode(`a bomb (${bomb.length} bytes to 4 MiB) past maxBytes`, "size", () => inflateRaw(new Uint8Array(bomb), 1 << 20));
  check("the same bomb within maxBytes", inflateRaw(new Uint8Array(bomb), 1 << 22).length === 1 << 22);
  // random garbage: an error or some bytes, never a hang or a crash
  let ok = true;
  for (let t = 0; t < 2000; t++) {
    try {
      inflateRaw(sample("random", 1 + rnd(200)), 1 << 16);
    } catch (e) {
      if (!(e instanceof BBQrError)) ok = false;
    }
  }
  check("2000 random streams: only BBQrError", ok);
}

// --- base32: Python agrees ------------------------------------------------------
{
  const cases = [];
  for (let n = 0; n < 40; n++) cases.push(sample("random", n));
  const out = py("import sys, base64\nfor l in sys.stdin.read().split('\\n'): print(base64.b32encode(bytes.fromhex(l)).decode().rstrip('='))\n",
    cases.map((c) => Buffer.from(c).toString("hex")).join("\n")).toString().split("\n");
  check("base32 matches Python's for 0 to 39 bytes", cases.every((c, i) => toBase32(c) === out[i]));
  check("base32 reads back", cases.every((c) => eq(fromBase32(toBase32(c)), c)));
  throwsCode("base32 of an impossible length", "data", () => fromBase32("ABC"));
  throwsCode("base32 with a lower-case letter", "data", () => fromBase32("abcdefgh"));
  throwsCode("base32 with stray bits", "data", () => fromBase32("AB"));
}

// --- capacities: the specification's figures -----------------------------------
check("version 27: 1062 bytes of hex", partCapacity(27, "H") / 2 === 1062);
check("version 40: 2144 bytes of hex", partCapacity(40, "H") / 2 === 2144);
check("version 40: 2680 bytes of base32", (partCapacity(40, "2") / 8) * 5 === 2680);

// --- split and join -------------------------------------------------------------
function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
let roundTrips = 0, roundOk = true, shapeOk = true;
for (const kind of KINDS) {
  for (const n of [0, 1, 5, 99, 1000, 4000, 30000]) {
    const data = sample(kind, n);
    for (const encoding of ["H", "2", "Z"]) {
      for (const maxVersion of [5, 11, 25, 40]) {
        let r;
        try {
          r = split(data, "P", { encoding, maxVersion });
        } catch (e) {
          if (!(e instanceof BBQrError && e.code === "size")) roundOk = false;
          continue;
        }
        roundTrips++;
        // each part fits its version, all but the last the same length
        const cap = partCapacity(r.version, r.encoding) + 8;
        const lens = r.parts.map((p) => p.length);
        if (lens.some((l) => l > cap)) shapeOk = false;
        if (lens.slice(0, -1).some((l) => l !== lens[0]) || lens[lens.length - 1] > lens[0]) shapeOk = false;
        if (r.parts.some((p) => !/^[0-9A-Z$%*+\-./: ]*$/.test(p))) shapeOk = false;
        if (encoding === "Z" && r.encoding !== "Z" && deflateRaw(data).length < n) shapeOk = false;
        // read in any order, with repeats
        const j = new Joiner();
        let last;
        for (const p of shuffle([...r.parts, ...r.parts.slice(0, 2)])) last = j.add(p);
        const back = j.result();
        if (!last.done || back.type !== "P" || back.encoding !== r.encoding || !eq(back.bytes, data)) roundOk = false;
      }
    }
  }
}
check(`${roundTrips} round trips: the same bytes back`, roundOk && roundTrips > 200);
check("parts fit their version, are even, and alphanumeric", shapeOk);

{
  const data = sample("random", 5000);
  const r = split(data, "P", { encoding: "H", maxVersion: 40 });
  const one40 = split(data, "P", { encoding: "H", maxParts: 5 });
  // 10000 hex digits, 2000 a part: version 27 holds 2124
  check("hex: 5000 bytes in at most 5 parts is version 27", one40.parts.length === 5 && one40.version === 27);
  check("the smallest version is chosen (5 by default)", split(data, "P", { encoding: "H" }).version === 5);
  const few = split(data, "P", { encoding: "H", maxParts: 4 });
  check("maxParts 4: a bigger version, at most 4 parts", few.parts.length <= 4 && few.version > 5);
  check("parts are even: the last isn't a runt", (() => {
    const l = few.parts.map((p) => p.length);
    return l[l.length - 1] > l[0] / 2;
  })());
  const h = r.parts[0];
  check("the header: B$HP, the count and the index in base 36", h.startsWith(`B$HP${r.parts.length.toString(36).toUpperCase().padStart(2, "0")}00`));
  const big = split(new Uint8Array(3000), "B", { encoding: "2", maxVersion: 5, minVersion: 1 });
  check("parts counted in base 36 past 9", big.parts.length > 36 && big.parts[37].slice(4, 8) === `${big.parts.length.toString(36).toUpperCase().padStart(2, "0")}11`);
  throwsCode("too big for the parts allowed", "size", () => split(sample("random", 3000), "P", { encoding: "H", maxVersion: 5, maxParts: 3 }));
  let threw = false;
  try {
    split(data, "p");
  } catch (e) {
    threw = e instanceof RangeError;
  }
  check("a lower-case file type is refused", threw);
  check(`MAX_PARTS is 1295 (ZZ)`, MAX_PARTS === 1295);
}

// a reader's faults: other files, conflicts, bad headers, bad lengths
{
  const a = split(sample("text", 4000), "P", { encoding: "2", maxVersion: 10 }).parts;
  const b = split(sample("random", 4000), "P", { encoding: "2", maxVersion: 10 }).parts;
  const t = split(sample("random", 4000), "T", { encoding: "2", maxVersion: 10 }).parts;
  check("several parts to test with", a.length >= 3 && b.length === a.length);
  let j = new Joiner();
  j.add(a[0]);
  throwsCode("a part of a file of another type", "series", () => j.add(t[1]));
  const forged = a[1].slice(0, 8) + b[1].slice(8);
  j.add(a[1]);
  throwsCode("the same part with other contents", "conflict", () => j.add(forged));
  check("a repeat of a part is not counted twice", j.add(a[1]).added === false && j.have === 2);
  throwsCode("the result before every part is in", "incomplete", () => j.result());
  j.reset();
  check("reset() starts over", j.add(t[0]).have === 1 && j.type === "T");
  throwsCode("not BBQr", "header", () => new Joiner().add("UR:CRYPTO-PSBT/1-3/LPADAX"));
  throwsCode("an unknown encoding", "header", () => parsePart("B$QP0100ABCD"));
  throwsCode("index past the total", "header", () => parsePart("B$HP0202ABCD"));
  throwsCode("a total of zero", "header", () => parsePart("B$HP0000"));
  throwsCode("a header cut short", "header", () => parsePart("B$HP01"));
  check("isBBQr", isBBQr("B$HP0100") && !isBBQr("b$HP0100") && !isBBQr(null));
  j = new Joiner();
  j.add(a[0]);
  throwsCode("a middle part shorter than the first", "length", () => j.add(a[1].slice(0, a[1].length - 8)));
  j = new Joiner();
  j.add(a[1]);
  const longLast = a[a.length - 1].slice(0, 8) + "A".repeat(a[1].length - 8 + 8);
  throwsCode("a last part longer than the others", "length", () => j.add(longLast));
  throwsCode("a middle part not a multiple of 8", "length", () => new Joiner().add(a[1].slice(0, a[1].length - 3)));
  j = new Joiner();
  j.add("B$HP0100ABC");
  throwsCode("hex with an odd digit", "data", () => j.result());
  j = new Joiner();
  j.add("B$HP0100abcd");
  check("lower-case hex is read", eq(j.result().bytes, [0xab, 0xcd]));
  j = new Joiner({ maxBytes: 1000 });
  for (const p of split(new Uint8Array(1 << 20), "B", { maxVersion: 40 }).parts) j.add(p);
  throwsCode("a compressed file past maxBytes", "size", () => j.result());
  // the last part first: it is held, and the rest still fit
  j = new Joiner();
  j.add(a[a.length - 1]);
  for (const p of a.slice(0, -1)) j.add(p);
  check("the last part first", j.result().bytes.length === 4000);
}

// one part, as Coldcard shows a small PSBT
{
  const data = sample("random", 200);
  const r = split(data, "P", { encoding: "H", maxParts: 1 });
  check("a small file is one part, B$HP0100", r.parts.length === 1 && r.parts[0].startsWith("B$HP0100"));
  const j = new Joiner();
  check("one part is done at once", j.add(r.parts[0]).done && eq(j.result().bytes, data));
}

// a real series from the BBQr project (README.md): another encoder's zlib
{
  const lines = readFileSync(new URL("./real-scan.txt", import.meta.url), "utf8").split("\n").filter((l) => l.trim());
  const j = new Joiner();
  let last;
  for (const l of lines) last = j.add(l.trim());
  const r = j.result(), text = Buffer.from(r.bytes).toString("utf8");
  check("the real scan: 8 parts, type U, encoding Z, done", last.done && last.total === 8 && r.type === "U" && r.encoding === "Z");
  check("the real scan: the text BBQr's own tests look for", text.includes("Zlib compressed") && text.includes("PSBT"));
  const parts = [...new Set(lines.map((l) => l.trim()))].reverse();
  const k = new Joiner();
  for (const p of parts) k.add(p);
  check("the real scan backwards: the same bytes", eq(k.result().bytes, r.bytes));
  const ours = new Joiner();
  for (const p of split(r.bytes, "U").parts) ours.add(p);
  check("the real scan's text through our own split and join", eq(ours.result().bytes, r.bytes));
}

for (const f of failed) console.log("FAIL", f);
console.log(`bbqr: ${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
