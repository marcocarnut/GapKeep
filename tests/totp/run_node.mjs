// Runs the Authenticator's self-test (apps/totp/lib/selftest.js) under Node,
// with Node's HMAC in place of gk:crypto's:
//   node --experimental-default-type=module tests/totp/run_node.mjs
// (the flag: apps/totp has no package.json saying its .js files are modules)
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac } from "node:crypto";
import { setHmac } from "../../apps/totp/lib/hotp.js";
import { runSelfTest } from "../../apps/totp/lib/selftest.js";

const NODE_NAMES = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-512": "sha512" };
setHmac((hash, key, data) => new Uint8Array(createHmac(NODE_NAMES[hash], key).update(data).digest()));
const { passed, failed } = await runSelfTest();
console.log(`totp selftest: ${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("FAIL", f);
process.exit(failed.length ? 1 : 0);
