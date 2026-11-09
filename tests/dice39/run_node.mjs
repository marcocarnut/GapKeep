// Runs the dice39 self-test on the development machine under Node:
//   node tests/dice39/run_node.mjs
// Checks the extracted modules independently of zerogap's own crypto.
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// the public key's BIP-39 and BIP-32 get the signer tests' stand-in for gk:crypto
const ref = await import("../signer/crypto_ref.mjs");
const { setCrypto } = await import("../../apps/dice39/lib/crypto.js");
setCrypto(ref);
const { runDice39SelfTest } = await import("../../apps/dice39/lib/selftest.js");
const { passed, failed } = await runDice39SelfTest();
console.log(`dice39 selftest (node): ${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL", f);
process.exit(failed.length ? 1 : 0);
