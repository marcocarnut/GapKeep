// The e-paper panel in the WebAssembly simulator (sim/build/web/gksim-test.js,
// make -C sim web TEST=1), under Node, as the browser IDE uses it
// (sim/web/gapkeep.js): a 2.9" B/W/R panel, tests/apps/epapertest writes
// share 1 with the panel's real refresh time (18 s), the panel's picture
// as its pigments' physics has it then shows black and red; unplugged, a
// write fails. Skipped without the build.
//
//   node --experimental-default-type=module tests/web/epaper.mjs
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { Gapkeep } from "../../sim/web/gapkeep.js";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const build = fileURLToPath (new URL ("../../sim/build/web/gksim-test.js", import.meta.url));
if (!existsSync (build)) {
  console.log ("SKIP epaper (web): no sim/build/web/gksim-test.js (make -C sim web TEST=1)");
  process.exit (0);
}
const log = [];
const gk = await Gapkeep.create ({ moduleUrl: pathToFileURL (build).href, onLog: (line) => log.push (line) });
const problems = [];
if (!gk.hasEPaper ()) {
  console.log ("epaper (web): this build has no e-paper panel");
  process.exit (1);
}
gk.setEPaper ("weact-2.9-bwr");
gk.boot (640, 480);
gk.start ();
const until = async (re, ms) => {
  for (const end = Date.now () + ms; Date.now () < end; await new Promise ((r) => setTimeout (r, 50))) {
    const line = log.find ((l) => re.test (l));
    if (line) return line;
  }
  return null;
};
const key = async (k) => {
  gk.keyDown (k);
  await new Promise ((r) => setTimeout (r, 60));
  gk.keyUp ();
};

// what the panel shows (gk_web_epaper_frame): counts of dark, red and light pixels
function look () {
  const w = gk.m._gk_web_epaper_width (), h = gk.m._gk_web_epaper_height ();
  const p = gk.m._gk_web_epaper_frame ();
  const rgb = gk.m.HEAPU8.subarray (p, p + w * h * 3);
  const n = { w, h, dark: 0, red: 0, light: 0 };
  for (let i = 0; i < rgb.length; i += 3) {
    const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
    if (r > 90 && r > 2 * g && r > 2 * b) n.red++;
    else if (r + g + b < 200) n.dark++;
    else n.light++;
  }
  return n;
}

if (!(await until (/launcher ready/, 20000))) problems.push ("no launcher");
if (gk.epaperPlugged !== "1") problems.push (`plugged: ${gk.epaperPlugged}`);
const before = look ();
if (before.w !== 296 || before.h !== 128 || before.dark || before.red) problems.push (`a new panel: ${JSON.stringify (before)}`);

gk.launch ("epapertest");
if (!(await until (/epapertest ready/, 10000))) problems.push ("epapertest did not start");
await key ("1");
let progress = -1;
for (const end = Date.now () + 5000; Date.now () < end && progress < 0; await new Promise ((r) => setTimeout (r, 50))) {
  progress = gk.epaperProgress;
}
if (!(progress >= 0 && progress <= 1)) problems.push (`no refresh in progress: ${progress}`);
if (!(await until (/epapertest wrote 1/, 30000))) problems.push ("share 1 not written");
const after = look ();
// the 296x128 picture: a QR code and text in black, a title in red
if (after.dark < 3000 || after.red < 100) problems.push (`after the refresh: ${JSON.stringify (after)}`);

gk.epaperUnplug ();
if (gk.epaperPlugged !== null) problems.push ("still plugged in");
await key ("2");
if (!(await until (/epapertest failed 2: Error: no panel answers/, 10000))) problems.push ("no error without a panel");
gk.stop ();

for (const l of log.filter ((l) => /epaper/.test (l))) console.log (l);
console.log (`epaper (web): ${problems.length ? "FAIL " + problems.join ("; ") : "ok"} (after: ${JSON.stringify (after)})`);
process.exit (problems.length ? 1 : 0);
