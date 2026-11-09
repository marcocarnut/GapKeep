// The codex32 app's tests on the development machine, under Node:
//   node --experimental-default-type=module tests/codex32/run_node.mjs
// The app's self-test (every BIP-93 test vector, valid and invalid), then
// what is too slow for a Pi Zero at start-up: every single-character typo
// of every valid vector's shares must be refused, and pointed at. And the
// app's own wording of the errors (lib/messages.js, through gk:i18n): in
// English the library's, word for word; in pt-BR translated, nothing left out.
import { webcrypto } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { runCodex32SelfTest } = await import("../../apps/codex32/lib/selftest.js");
const { VALID } = await import("../../apps/codex32/lib/vectors.js");
const { checkShare, recoverSeed, recover, CX_CHARSET } = await import("../../apps/codex32/lib/codex32.js");
const { cxRecover } = await import("../../apps/codex32/vendor/codex32.js");

const { passed, failed } = await runCodex32SelfTest();
console.log(`codex32 selftest (node): ${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL", f);

const bad = [];

// recoverSeed refuses every invalid vector, with the code checkShare gives
// (with the typo search on, which the self-test leaves off for speed)
const { INVALID } = await import("../../apps/codex32/lib/vectors.js");
for (const [code, s] of INVALID) {
  try {
    recoverSeed([s]);
    bad.push(`invalid vector accepted by recoverSeed: ${s.slice(0, 12)}...`);
  } catch (e) {
    if (e.code !== code) bad.push(`invalid vector ${s.slice(0, 12)}...: ${e.code}, expected ${code}`);
  }
}
console.log(`codex32 invalid vectors through recoverSeed (node): ${INVALID.length}, ${bad.length} wrong`);

// Every substitution at every position after "ms1" of every share
let typos = 0, pointed = 0;
for (const v of VALID) {
  for (const share of v.shares.concat(v.derived || [])) {
    const upper = share === share.toUpperCase();
    for (let i = 3; i < share.length; i++) {
      for (const c of CX_CHARSET) {
        if (c === share[i].toLowerCase()) continue;
        const t = share.slice(0, i) + (upper ? c.toUpperCase() : c) + share.slice(i + 1);
        typos++;
        const r = checkShare(t);
        if (r.ok) { bad.push(`${v.name}: typo at ${i + 1} accepted`); continue; }
        if (r.error.code === "threshold" || r.error.code === "threshold0") { pointed++; continue; }
        if (r.error.code !== "checksum" || r.error.position !== i + 1 || r.error.suggestion !== share[i]) {
          bad.push(`${v.name}: typo at ${i + 1}: ${r.error.code} ${r.error.position} ${r.error.suggestion}`);
        } else pointed++;
      }
    }
  }
}
console.log(`codex32 typos (node): ${typos} single-character typos, ${pointed} refused and pointed at, ` +
  `${bad.length} wrong`);
for (const b of bad.slice(0, 10)) console.log("  FAIL", b);

// dice39's cxRecover and threshold 0 (BIP-93 test vector 1): the app works
// around it; this says whether the vendored copy still needs that.
let upstream;
try {
  cxRecover(VALID[0].shares);
  upstream = "fixed (cxRecover accepts vector 1)";
} catch (e) {
  upstream = `still there (cxRecover: ${e.message}); recoverSeed works around it: ` +
    Buffer.from(recoverSeed(VALID[0].shares)).toString("hex").slice(0, 8) + "...";
}
console.log(`codex32: dice39 threshold-0 bug ${upstream}`);

// --- the app's wording of the errors -------------------------------------------
//
// gk:i18n is the runtime's src/runtime/i18n.js with tests/i18n/fake_native.mjs
// (as tests/i18n/run_node.mjs runs it), and lib/messages.js imports it.
const dir = mkdtempSync(join(tmpdir(), "zg-codex32-"));
const native = new URL("../i18n/fake_native.mjs", import.meta.url);
writeFileSync(join(dir, "i18n.mjs"), readFileSync(new URL("../../src/runtime/i18n.js", import.meta.url), "utf8")
  .replace(`from "gk:i18n-native"`, `from ${JSON.stringify(native.href)}`));
const lib = new URL("../../apps/codex32/lib/", import.meta.url);
for (const name of ["messages", "strings"]) {
  writeFileSync(join(dir, `${name}.mjs`), readFileSync(new URL(`${name}.js`, lib), "utf8")
    .replace(`from "gk:i18n"`, `from ${JSON.stringify(join(dir, "i18n.mjs"))}`));
}
const i18n = await import(join(dir, "i18n.mjs"));
const { codex32Message } = await import(join(dir, "messages.mjs"));
const { S, PAGE_KEYS } = await import(join(dir, "strings.mjs"));
rmSync(dir, { recursive: true });
(await import(native.href)).config.app = "codex32";

// errors of every kind: the invalid vectors, typos in valid shares (one, two,
// characters codex32 lacks), cut and lengthened shares, and sets that don't
// go together
const errors = [];
const parseError = (text) => { const r = checkShare(text); if (!r.ok) errors.push(r.error); };
const recoverError = (shares) => { try { recover(shares); } catch (e) { errors.push(e); } };
for (const [, s] of INVALID) parseError(s);
for (const text of ["", "m", "MS", "Ms1", "xs1abc", "MS12NAMEA320zyxw"]) parseError(text);
const sub = (s, i, c) => s.slice(0, i) + c + s.slice(i + 1);
for (const v of VALID) {
  const s = v.shares[0];
  for (const c of ["b", "o", "i", "1", "B"]) parseError(sub(s, 10, c));
  parseError(sub(sub(s, 10, "b"), 20, "o"));
  parseError(sub(sub(sub(s, 10, "b"), 20, "o"), 30, "i"));
  parseError(sub(s, 12, s[12] === "q" ? "p" : "q"));
  parseError(sub(sub(s, 12, s[12] === "q" ? "p" : "q"), 25, s[25] === "q" ? "p" : "q"));
  parseError(sub(s, 3, "q"));
  parseError(sub(sub(s, 3, "0"), 8, s[8] === "s" ? "a" : s[8]));
  for (const n of [1, 2, 5, 9]) parseError(s.slice(0, -n));
  parseError(s + "q");
  parseError(s + "qqqqqqqqqq");
  if (v.shares.length > 1) {
    recoverError([v.shares[0], v.shares[0]]);
    recoverError([v.shares[0]]);
    recoverError(v.shares.concat(v.shares[0]));
    recoverError([v.shares[0], sub(v.shares[1], 12, v.shares[1][12] === "q" ? "p" : "q")]);
  }
}
recoverError([]);
for (const a of VALID) for (const b of VALID) if (a !== b) recoverError([a.shares[0], b.shares[0]]);
const codes = new Set(errors.map((e) => e.code));

let english = 0;
for (const e of errors) {
  const m = codex32Message(e);
  if (m === e.message) english++;
  else bad.push(`${e.code}: "${m}" is not the library's "${e.message}"`);
}
i18n.setLanguage("pt-BR");
let portuguese = 0;
for (const e of errors) {
  const m = codex32Message(e);
  if (m !== e.message && !/\{\w+\}/.test(m)) portuguese++;
  else bad.push(`${e.code} in pt-BR: "${m}"`);
}
i18n.setLanguage("en");
console.log(`codex32 messages (node): ${errors.length} errors of ${codes.size} kinds (${[...codes].sort().join(" ")}), ` +
  `${english} worded as the library does, ${portuguese} translated`);
for (const b of bad.slice(0, 10)) console.log("  FAIL", b);

// The page's strings in lib/strings.js are still codex32_recover.html's
// (vendor/recover.js), word for word once the HTML is out
const { STRINGS } = await import("../../apps/codex32/vendor/recover.js");
const plain = (html) => String(html).replace(/<[^>]+>/g, "");
let same = 0;
for (const k of PAGE_KEYS) {
  if (S[k] === plain(STRINGS.en[k])) same++;
  else bad.push(`lib/strings.js ${k} is not the page's: "${S[k]}"`);
}
console.log(`codex32 strings (node): ${same} of ${PAGE_KEYS.length} the page's own`);
for (const b of bad.slice(-10)) console.log("  FAIL", b);

process.exit(failed.length || bad.length ? 1 : 0);
