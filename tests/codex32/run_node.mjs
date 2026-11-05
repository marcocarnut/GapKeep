// The codex32 app's tests on the development machine, under Node:
//   node --experimental-default-type=module tests/codex32/run_node.mjs
// The app's self-test (every BIP-93 test vector, valid and invalid), then
// what is too slow for a Pi Zero at start-up: every single-character typo
// of every valid vector's shares must be refused, and pointed at.
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { runCodex32SelfTest } = await import("../../apps/codex32/lib/selftest.js");
const { VALID } = await import("../../apps/codex32/lib/vectors.js");
const { checkShare, recoverSeed, CX_CHARSET } = await import("../../apps/codex32/lib/codex32.js");
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

process.exit(failed.length || bad.length ? 1 : 0);
