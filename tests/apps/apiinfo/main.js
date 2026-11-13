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
import * as zlib from "gk:zlib";

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

// gk:crypto's objects: their prototypes' members. The RSA key is
// src/crypto/rsa.c's self-test key.
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)));
const rsaKey = {
  n: unhex("aed6cde9ccf7ae2d71234fb19de818fd17efef66176d31d89f89ef73db7f353b1aaad5a08e33087c9f7cd78904e8885b" +
    "5f75961a3d8bb1b5ab5bb8de6b72fa1ba3f5b999898fabe568b5a712a84da0793baf8c71388b7133afb04eb9d0931be7" +
    "e19dbe631bf81eaf379ff5d97c5eae92af8cd359cb76a1177f1eb2b4e2cf1c34a62834e5a5dcb699165e951c85bfa132" +
    "f1cf53efa1ef69a11498c915680f6f69e37ebecc4cef857199b4e4bfe39ed894f2360263e226166a92a034ba8efdaf01" +
    "5a426957ced27b0d55b95a9b2e755bc7a7493ccad7c37976a8ea520328558a1ea57b5fa8fd5d614824e3bc191f0dc354" +
    "00f095afa4f2faf2173bf82576f881c3"),
  e: unhex("010001"),
  d: unhex("1c200cdecbec99f5d069e44387c9d2df3fef067d4f4e6f02d06341844b2e72f32f8e84afffc000e0ff4cf76520c7814b" +
    "e596c64f31505c0583ebccd8e6c307add399cf41fe2980f6f5f9a6c72f10d1bc3ed83608ee962bdf2b277afa942d5e03" +
    "56bd67e78c93c4e7ddd45b19a1d29f55946cdc80e8e48bf47a2c078666a7f77ad1d7784e323f04d9cb5779dc431df300" +
    "6ce1ba87fbf8d16a6333c4ca708a940d979e203dc5ae41f906ae71343437779ef4117d1f53861f230f21675ee6951f9e" +
    "8ee329318b809bfb680749e17497a2ba2ba3a7c21db975f2d5d5d4870b6b22c5ade3808d2e8d9a89380c50b464e7bcef" +
    "e4b362b0813bca17e83798fa3dc57379"),
  p: unhex("b5c1125bc9d3eb8d5bff6531a997818834a34040169408693d617cb49ddde83b4d120741ec2e72993b0a599c3cd16fb1" +
    "16e281c7efcab574eaffe702f9cb7ad72421aa16fbc440a6bc3b52785980e447316cc195f77c0fbc819b0f4ca3d06f5b" +
    "89455d132ae6b3e3027d69ed30fb43d34570209c57e761876940afa0bd9177db"),
  q: unhex("f64295ffa11220a2753ea1a09aa947c2bba9b493d677d14713404879c4c40f3bce2c20e4b2ffb4ff7928cab849a66118" +
    "e5cb1d398687f217baa0d6783e1b11d32551a99cc417fd79a629c2d0b562a126ba1fc2467b3fc27f5583f82e2bfb2034" +
    "b99204c10af0294d39de38ff5e5d3e7247e8d6ca9ff38a13d33b27730a581639"),
};
const cryptoObjects = {
  Hash: crypto.createHash("SHA-256"),
  Ed25519PrivateKey: crypto.ed25519PrivateKey(new Uint8Array(32)),
  RsaPrivateKey: crypto.rsaPrivateKey(rsaKey),
  X25519PrivateKey: crypto.x25519PrivateKey(new Uint8Array(32)),
};
const cryptoMembers = {};
for (const [name, o] of Object.entries(cryptoObjects)) {
  cryptoMembers[name] = members(Object.getPrototypeOf(o));
  o.destroy();
}

// an e-paper panel's own members (gksim --epaper)
let epaperPanel = {};
try {
  const panel = ui.epaper.open();
  epaperPanel = members(Object.getPrototypeOf(panel));
  panel.close();
} catch (e) {
  epaperPanel = { error: String(e) };
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
    "gk:zlib": Object.keys(zlib).sort(),
  },
  base: members(ui.Widget.prototype),
  widgets,
  symbols: Object.keys(ui.symbols),
  fonts: ui.fonts,
  app: Object.keys(sys.app).sort(),
  kernel: Object.keys(sys.kernel).sort(),
  version: Object.keys(sys.version).sort(),
  cryptoObjects: cryptoMembers,
  epaper: Object.getOwnPropertyNames(ui.epaper).sort(),
  epaperPanel,
  globals: ["console", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "AbortController", "AbortSignal",
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
