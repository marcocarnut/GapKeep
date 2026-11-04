// Runs the Authenticator's self-test (apps/totp/lib/selftest.js) under Node,
// with Node's SHA-256 in place of zg:crypto's:
//   node --experimental-default-type=module tests/totp/run_node.mjs
// (the flag: apps/totp has no package.json saying its .js files are modules)
import { createHash } from "node:crypto";
import { setSha256 } from "../../apps/totp/lib/hotp.js";
import { runSelfTest } from "../../apps/totp/lib/selftest.js";

setSha256((data) => new Uint8Array(createHash("sha256").update(data).digest()));
const { passed, failed } = await runSelfTest();
console.log(`totp selftest: ${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("FAIL", f);
process.exit(failed.length ? 1 : 0);
