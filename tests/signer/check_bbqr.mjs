// Checks the BBQr series the Signer showed in a tests/signer.txt run: every
// part is decoded from its screenshot with zbarimg, the parts are joined with
// lib/js/bbqr.js's Joiner, and the file's SHA-256 must be what the app logged
// for it. Every part must be at the series' one version, as logged.
//
//   node --experimental-default-type=module tests/signer/check_bbqr.mjs <screenshot-dir>
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Joiner } from "../../lib/js/bbqr.js";

const dir = process.argv[2];
const log = readFileSync(`${dir}/serial.log`, "utf8");
let failed = false;

function checkSeries(prefix, form, type) {
  const rx = new RegExp(`showing the signed ${form} as BBQr \\((\\d+) bytes, (\\d+) parts?, version (\\d+), encoding (.), SHA-256 ([0-9a-f]+), (\\d+) ms\\)`, "g");
  // the last: the scenario's big one, after a small one on request
  const m = [...log.matchAll(rx)].at(-1);
  if (!m) throw new Error(`no ${form} series in the log`);
  const [, size, total, version, encoding, hash, ms] = m;
  const j = new Joiner();
  let p = null;
  for (const f of readdirSync(dir).filter((x) => x.startsWith(prefix)).sort()) {
    let text = "";
    try {
      text = execFileSync("zbarimg", ["-q", "--raw", `${dir}/${f}`], { encoding: "utf8" }).trim();
    } catch { /* no code found: a shot between parts */ }
    if (text) p = j.add(text);
  }
  if (!p || !p.done) throw new Error(`${form}: ${p ? p.have : 0} of ${total} parts read`);
  const r = j.result();
  const got = createHash("sha256").update(r.bytes).digest("hex").slice(0, 16);
  const ok = r.type === type && p.total === +total && p.encoding === encoding && r.bytes.length === +size && got === hash;
  console.log(`${ok ? "ok  " : "FAIL"} ${form}: ${p.total} parts, version ${version}, encoding ${encoding}, ${r.bytes.length} bytes, split in ${ms} ms`);
  failed = failed || !ok;
  return { version: +version, total: +total };
}

// every "part i of n, M modules" line of these series: M is its one version
for (const { version, total } of [checkSeries("30-part-", "tx", "T"), checkSeries("31-part-", "psbt", "P")]) {
  const lines = [...log.matchAll(new RegExp(`signer: part \\d+ of ${total}, (\\d+) modules`, "g"))];
  const sizes = new Set(lines.map((l) => (+l[1] - 17) / 4));
  const ok = lines.length >= total && sizes.size === 1 && sizes.has(version);
  console.log(`${ok ? "ok  " : "FAIL"} ${lines.length} parts of ${total} logged, at version ${[...sizes].join(", ")}`);
  failed = failed || !ok;
}
process.exit(failed ? 1 : 0);
