// The pgpcrypto test app (tests/apps/pgpcrypto) in the WebAssembly
// simulator (sim/build/web/gksim-test.js, make -C sim web TEST=1), under
// Node: gk:crypto's long operations (jobs) run there too, sliced by the
// browser's main loop. Skipped without the build.
//
//   node --experimental-default-type=module tests/web/pgpcrypto.mjs
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { Gapkeep } from "../../sim/web/gapkeep.js";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const build = fileURLToPath (new URL ("../../sim/build/web/gksim-test.js", import.meta.url));
if (!existsSync (build)) {
  console.log ("SKIP pgpcrypto (web): no sim/build/web/gksim-test.js (make -C sim web TEST=1)");
  process.exit (0);
}
const log = [];
const gk = await Gapkeep.create ({ moduleUrl: pathToFileURL (build).href, onLog: (line) => log.push (line) });
gk.boot (640, 480);
gk.start ();
const until = async (re, ms) => {
  for (const end = Date.now () + ms; Date.now () < end; await new Promise ((r) => setTimeout (r, 50))) {
    const line = log.find ((l) => re.test (l));
    if (line) return line;
  }
  return null;
};
let ok = !!(await until (/launcher ready/, 20000));
gk.launch ("pgpcrypto");
const result = await until (/pgpcrypto: \d+ passed, \d+ failed/, 300000);
gk.stop ();
for (const l of log.filter ((l) => /pgpcrypto: (FAIL|time S2K|time RSA-4096 sign)|jobs: S2K/.test (l))) console.log (l);
ok = ok && result !== null && / 0 failed/.test (result);
console.log (`pgpcrypto (web): ${result || "no result"}`);
process.exit (ok ? 0 : 1);
