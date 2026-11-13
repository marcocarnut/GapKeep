// ui.epaper without "permissions": ["epaper"]: both functions refuse.
// tests/epaper.txt checks the log.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";

for (const name of ["info", "open"]) {
  try {
    ui.epaper[name]();
    console.log(`epapernoperm ${name}: not refused`);
  } catch (e) {
    console.log(`epapernoperm ${name}: ${e.name}: ${e.message}`);
  }
}
console.log("epapernoperm done");
