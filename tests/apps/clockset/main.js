// Test builds only: sets the wall clock to a fixed instant, so scenarios
// can check time-based apps against known values (tests/totp.txt).
//
// At start: 2033-05-18 03:33:03 UTC (1999999983 s), 3 s into the 30 s
// step 66666666, where RFC 6238's T = 2000000000 vectors apply, for the
// next 27 s. The button sets 2000000007 instead, 3 s before that step ends,
// to see a code change at the period mark.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as clock from "gk:clock";

function set(seconds) {
  const s = clock.set(seconds * 1000);
  const text = `clockset: set ${seconds} (${new Date(seconds * 1000).toISOString()}), set ${s.set}`;
  label.text = text.slice(10);
  console.log(text);
}

const label = new ui.Label({ text: "" });
const near = new ui.Button({ text: "Set 2000000007 (3 s before a mark)", onClick: () => set(2000000007) });
set(1999999983);
near.focus();
console.log("clockset ready");
