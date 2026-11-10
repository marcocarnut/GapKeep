// Test builds only: logs the length and the start of the SHA-256 of every
// code it reads, and of its colour layer, so tests can check what the
// decoders return (tests/scan_digest.txt). The real apps (qrscan, colorqr)
// log lengths only: a code may hold a secret, and a test build's log
// leaves the device. This app reads only the test pictures.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import { sha256 } from "gk:crypto";

const digest = (bytes) => Array.from(sha256(bytes).subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
let count = 0;

new ui.Label({ text: "Scan digest (test builds only)" });
new ui.Scanner({
  detect: ["qr", "qr-color"],
  width: 320,
  height: 240,
  onDetect: ({ kind, bytes, status, colour }) => {
    if (kind === "qr") {
      count++;
      console.log(`scandigest: code ${count}, ${bytes.length} bytes, sha256 ${digest(bytes)}`);
    } else if (status === "ok") {
      console.log(`scandigest: colour layer of code ${count}, ${colour.length} bytes, sha256 ${digest(colour)}`);
    } else {
      console.log(`scandigest: colour layer of code ${count}: ${status}`);
    }
  },
  onError: ({ reason }) => console.log(`scandigest: error: ${reason}`),
});
console.log("scandigest ready");
