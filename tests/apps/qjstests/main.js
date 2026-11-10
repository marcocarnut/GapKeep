// Runs QuickJS's own test scripts (third_party/quickjs/tests) on the
// target, unmodified, with the two host objects they expect: std.gc and
// os.setTimeout. Each suite throws on its first failed assertion.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as sys from "gk:sys";
import { suites } from "./suites.js";

globalThis.std = { gc: sys.gc };
globalThis.os = { setTimeout, platform: "gapkeep" };

let failed = 0;
for (const [name, source] of Object.entries(suites)) {
  const t0 = sys.uptime();
  try {
    (0, eval)(source);
    console.log(`qjstest ${name}: ok (${Math.round(sys.uptime() - t0)} ms)`);
  } catch (e) {
    failed++;
    console.log(`qjstest ${name}: FAIL ${e}\n${e && e.stack}`);
  }
}
// suites may queue timers and promise jobs: report after they ran
setTimeout(() => console.log(`qjstests done: ${failed} failed`), 2000);
