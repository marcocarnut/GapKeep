// Dumps the JavaScript API this runtime really has, as JSON log lines
// ("apiinfo <part>: ..."), for tools/check_api.py to compare with
// docs/api/gapkeep-api.yaml. Test builds only.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as crypto from "gk:crypto";
import * as apps from "gk:apps";
import * as clock from "gk:clock";
import * as session from "gk:session";
import * as i18n from "gk:i18n";
import * as data from "gk:data";
import * as usb from "gk:usb";

// own members of a prototype: methods, and accessors with get/set
function members(proto) {
  const out = {};
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    out[name] = typeof d.value === "function" ? "method"
      : d.get && d.set ? "readable" : d.get ? "readonly" : d.set ? "writeonly" : typeof d.value;
  }
  return out;
}

const widgets = {};
for (const [name, value] of Object.entries(ui)) {
  if (typeof value === "function" && value.prototype instanceof ui.Widget) {
    widgets[name] = members(value.prototype);
  }
}

const info = {
  modules: {
    "gk:ui": Object.keys(ui).sort(),
    "gk:sys": Object.keys(sys).sort(),
    "gk:crypto": Object.keys(crypto).sort(),
    "gk:apps": Object.keys(apps).sort(),
    "gk:clock": Object.keys(clock).sort(),
    "gk:session": Object.keys(session).sort(),
    "gk:i18n": Object.keys(i18n).sort(),
    "gk:data": Object.keys(data).sort(),
    "gk:usb": Object.keys(usb).sort(),
  },
  base: members(ui.Widget.prototype),
  widgets,
  symbols: Object.keys(ui.symbols),
  fonts: ui.fonts,
  app: Object.keys(sys.app).sort(),
  kernel: Object.keys(sys.kernel).sort(),
  version: Object.keys(sys.version).sort(),
  globals: ["console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "fetch", "XMLHttpRequest", "WebSocket", "localStorage", "require", "process",
            "document", "crypto"].filter((g) => typeof globalThis[g] !== "undefined"),
};
// one line per part: log lines are at most 2 KB
for (const [key, value] of Object.entries(info)) {
  if (key === "widgets") {
    for (const [name, m] of Object.entries(value)) console.log(`apiinfo widget ${name}: ${JSON.stringify(m)}`);
  } else {
    console.log(`apiinfo ${key}: ${JSON.stringify(value)}`);
  }
}
console.log("apiinfo done");
sys.exit();
