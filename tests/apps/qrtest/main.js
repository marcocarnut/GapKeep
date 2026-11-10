// Test builds only: ui.QRCode's rules (tests/qrtest.txt): the version
// chosen for the data, error correction, the smallest version (`version`,
// for series of codes such as BBQr's), and values refused without changing
// the code.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";

let failed = 0;
function check(name, ok) {
  if (!ok) failed++;
  console.log(`qrtest: ${ok ? "ok" : "FAIL"} ${name}`);
}
function throws(name, fn, Type = RangeError) {
  try {
    fn();
  } catch (e) {
    check(name, e instanceof Type);
    return;
  }
  check(name + " (no error)", false);
}
const version = (q) => (q.modules - 17) / 4;

const q = new ui.QRCode({ size: 400, ecc: "L" });
check("empty: 0 modules", q.modules === 0);
q.data = "HELLO";
check("5 alphanumeric characters: version 1", version(q) === 1);
q.version = 12;
check("version 12: version 12", version(q) === 12);
q.data = "HELLO WORLD";
check("new data keeps version 12", version(q) === 12);
q.data = "A".repeat(600);
check("data that needs more: version 13 (12 holds 535)", version(q) === 13);
q.version = 1;
check("version 1 again: the smallest that fits", version(q) === 13);
q.data = "HELLO";
check("back to version 1", version(q) === 1);
throws("version 0 is refused", () => (q.version = 0));
throws("version 41 is refused", () => (q.version = 41));
check("a refused version leaves the code", version(q) === 1);
// 400 px holds at most 400 / (n + 8) >= 1, n <= 392 modules: version 40 is 177
q.size = 100;
throws("version 40 in 100 px is refused", () => (q.version = 40));
check("... and leaves the code as it was", version(q) === 1);
q.size = 400;
q.version = 40;
check("version 40 in 400 px", q.modules === 177);
const b = new ui.QRCode({ data: new Uint8Array([1, 2, 3]), version: 5, ecc: "H" });
check("bytes, set with the constructor: version 5", version(b) === 5);
// a BBQr-sized series: every code the same version, the last shorter
const parts = ["B$2P0300" + "A".repeat(320), "B$2P0301" + "A".repeat(320), "B$2P0302" + "A".repeat(40)];
const seen = parts.map((p) => {
  const c = new ui.QRCode({ size: 300, ecc: "L", version: 9, data: p });
  return version(c);
});
check("a series at version 9: " + seen.join(", "), seen.every((v) => v === 9));
console.log(`qrtest done: ${failed} failed`);
