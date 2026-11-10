// Misbehaves on purpose, so tests can check that the system copes:
// exceptions are reported, runaway scripts are stopped, and leftovers
// (timers, handlers, widgets) are cleaned up when the app exits.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";

const actions = {
  "Throw in handler": () => {
    null.boom();
  },
  "Unhandled rejection": () => {
    Promise.reject(new Error("nobody catches this"));
  },
  "Infinite loop": () => {
    console.log("crashtest: looping");
    for (;;) {}
  },
  "Leak and exit": () => {
    // timers, a key handler, deep widget trees and closures referencing
    // widgets: all must be released when the app stops
    setInterval(() => console.log("crashtest: still here?"), 50);
    setTimeout(() => {}, 100000);
    ui.onKey(() => false);
    let parent = ui.screen;
    for (let i = 0; i < 50; i++) {
      const c = new ui.Container(parent);
      c.onClick = () => c.text;
      parent = c;
    }
    ui.alert("pending alert");
    sys.exit();
  },
  "Allocate 200 MB": () => {
    const keep = [];
    for (let i = 0; i < 200; i++) keep.push(new Uint8Array(1024 * 1024));
    console.log("crashtest: allocated", keep.length);
  },
};

ui.screen.set({ layout: "row-wrap", gap: 12 });
for (const [label, fn] of Object.entries(actions)) {
  new ui.Button({
    text: label,
    onClick: () => {
      console.log("crashtest: " + label);
      fn();
    },
  });
}
console.log("crashtest ready");
