// zerogap.js - the zerogap simulator in the browser (or Node): a small
// wrapper around the WebAssembly build (sim/Makefile "make web").
//
//   import { Zerogap } from "./zerogap.js";
//   const zg = await Zerogap.create ({ onLog: (line) => ..., onHalt: () => ... });
//   zg.writeCard ({ "apps/hello/manifest.json": "...", "apps/hello/main.js": "..." });
//   zg.boot (640, 480);              // starts the launcher
//   zg.start ();                     // runs the main loop
//   zg.draw (canvas);                // paint the screen (call per animation frame)
//   zg.keyDown (event.key, mods); zg.keyUp ();
//   zg.type (text);                  // typed as key presses (pasting)
//   zg.pointer (x, y, pressed);
//   zg.wheel (notches);              // > 0 scrolls down, where the pointer is
//   zg.stop ();
//
// One instance is one boot of one machine. To run again, make a new one
// (Zerogap.create): nothing carries over, as on the device.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export const MOD_SHIFT = 1, MOD_CTRL = 2, MOD_ALT = 4;

let factory = null;     // createZerogap, loaded once

// Grey (one byte a pixel) from RGBA, or as is if already grey.
function toGrey (pixels, width, height) {
  if (pixels.length === width * height) return pixels;
  if (pixels.length !== width * height * 4) throw new RangeError ("pixels: width * height grey or RGBA bytes expected");
  const grey = new Uint8Array (width * height);
  for (let i = 0, o = 0; o < grey.length; i += 4, o++) {
    grey[o] = (pixels[i] * 77 + pixels[i + 1] * 150 + pixels[i + 2] * 29) >> 8;
  }
  return grey;
}

// The simulator's build date, from the server, goes into the URLs of
// zgsim.js and zgsim.wasm: the page loads them after it starts, so a hard
// reload doesn't refresh them, and Python's http.server sends no cache
// headers. Without it a browser can keep running an old build after
// "make web".
let buildTag = null;
const withTag = (url) => (buildTag ? url + (url.includes ("?") ? "&" : "?") + "build=" + buildTag : url);

async function buildDate (url) {
  if (!/^https?:/.test (url)) return null;
  try {
    const r = await fetch (url, { method: "HEAD", cache: "no-cache" });
    const date = r.ok && r.headers.get ("Last-Modified");
    return date ? String (Date.parse (date) / 1000) : null;
  } catch (e) {
    return null;
  }
}

// RGBA (an ImageData's data) -> RGB
function toRGB (rgba) {
  const rgb = new Uint8Array (rgba.length / 4 * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i];
    rgb[o + 1] = rgba[i + 1];
    rgb[o + 2] = rgba[i + 2];
  }
  return rgb;
}

export class Zerogap {
  // options: { onLog(line), onHalt(), moduleUrl } - moduleUrl: zgsim.js
  // (default: next to this file, as "make web" puts it in sim/build/web)
  static async create (options = {}) {
    if (!factory) {
      const url = options.moduleUrl || new URL ("../build/web/zgsim.js", import.meta.url).href;
      buildTag = await buildDate (url);
      factory = (await import (withTag (url))).default;
    }
    const zg = new Zerogap ();
    zg.onLog = options.onLog || ((line) => console.log (line));
    zg.onHalt = options.onHalt || (() => {});
    zg.halted = false;
    zg.m = await factory ({
      locateFile: (path, prefix) => withTag (prefix + path),
      onLog: (line) => zg.onLog (line),
      onHalt: () => { zg.halted = true; zg.stop (); zg.onHalt (); },
    });
    zg.timer = null;
    zg.lastSerial = -1;
    zg.image = null;
    return zg;
  }

  // The SD card's contents: { "apps/<id>/<path>": string or Uint8Array }.
  // Call before boot().
  writeCard (files) {
    this.m.FS.mkdirTree ("/card/apps");     // an empty card has the folder too
    for (const [path, data] of Object.entries (files)) {
      const full = "/card/" + path.replace (/^\/+/, "");
      this.m.FS.mkdirTree (full.slice (0, full.lastIndexOf ("/")));
      this.m.FS.writeFile (full, data);
    }
    this.hasCard = true;
  }

  // Replacements for built-in apps: { "<id>/<path>": string or Uint8Array },
  // e.g. "launcher/main.js". Simulator only. Call before boot().
  writeBuiltin (files) {
    for (const [path, data] of Object.entries (files)) {
      const full = "/builtin/" + path.replace (/^\/+/, "");
      this.m.FS.mkdirTree (full.slice (0, full.lastIndexOf ("/")));
      this.m.FS.writeFile (full, data);
    }
    this.hasBuiltin = true;
  }

  // Boots with a screen of width x height (320x240 to 4096x4096). Without
  // writeCard(), there is no SD card.
  boot (width = 640, height = 480) {
    this.width = width;
    this.height = height;
    const card = this.hasCard ? this.m.stringToNewUTF8 ("/card") : 0;
    if (this.hasBuiltin) this.m._zg_sim_set_builtin_dir (this.m.stringToNewUTF8 ("/builtin"));
    if (this.m._zg_sim_boot (width, height, card) !== 0) {
      throw new Error ("zerogap did not boot (see the log)");
    }
  }

  // The main loop, every 4 ms (browsers don't go faster).
  start () {
    if (!this.timer && !this.halted) {
      this.timer = setInterval (() => this.step (), 4);
    }
  }

  stop () {
    clearInterval (this.timer);
    this.timer = null;
  }

  step () {
    if (this.halted) return;
    try {
      this.m._zg_web_run ();
    } catch (e) {
      // exit() (a halt) unwinds as an exception
      this.halted = true;
      this.stop ();
      if (!(e && e.name === "ExitStatus")) this.onLog ("(simulator error: " + e + ")");
      this.onHalt ();
    }
  }

  // Keys as the browser names them (KeyboardEvent.key), mods MOD_* bits.
  // Returns false for keys zerogap has no use for (Shift alone, dead keys).
  // The key auto-repeats, as Circle does, until keyUp(): ignore the
  // browser's own repeats (event.repeat).
  keyDown (key, mods = 0) {
    const p = this.m.stringToNewUTF8 (key);
    const ok = this.m._zg_sim_key_down_dom (p, mods) === 0;
    this.m._free (p);
    return ok;
  }

  keyUp () {
    this.m._zg_sim_key_up ();
  }

  // Types text as key presses (Ctrl+V on the IDE's screen): printable ASCII
  // and Latin-1 (á, ç, £), newlines as Enter, tabs as Tab; other characters
  // are skipped. Paced:
  // zerogap's key queue holds 64 keys and LVGL reads it every 33 ms or so.
  // Returns the number of keys it will type.
  type (text) {
    const keys = [];
    for (const c of text.replace (/\r\n?/g, "\n")) {
      if (c === "\n") keys.push ("Enter");
      else if (c === "\t") keys.push ("Tab");
      else if ((c >= " " && c < "\x7f") || (c >= "\xa0" && c <= "\xff")) keys.push (c);
    }
    this.typing = (this.typing || []).concat (keys);
    if (!this.typeTimer) {
      const batch = () => {
        if (this.halted || !this.typing.length) {
          clearInterval (this.typeTimer);
          this.typeTimer = null;
          this.typing = [];
          return;
        }
        for (const key of this.typing.splice (0, 16)) {
          this.keyDown (key);
          this.keyUp ();
        }
      };
      this.typeTimer = setInterval (batch, 50);
      batch ();
    }
    return keys.length;
  }

  // Starts the app with this id, as the launcher would (no id: the
  // launcher). False if there is no such app.
  launch (id) {
    const p = id ? this.m.stringToNewUTF8 (id) : 0;
    const ok = this.m._zg_sim_launch (p) === 0;
    if (p) this.m._free (p);
    return ok;
  }

  // Mouse at (x, y) in screen pixels, left button pressed or not.
  pointer (x, y, pressed) {
    this.m._zg_sim_pointer (Math.round (x), Math.round (y), pressed ? 1 : 0);
  }

  // The mouse wheel where the pointer is: notches > 0 scroll down.
  wheel (notches) {
    this.m._zg_sim_wheel (notches | 0);
  }

  // The camera (after boot). What it films: "none" (no camera) or
  // "scene" (nothing in particular, the default); a QR code of a string
  // (UTF-8) or of bytes; a picture or a live frame, as grey (one byte a
  // pixel) or RGBA (an ImageData's data). A picture stays until changed; a
  // live frame until the next one (push them at the camera's pace, e.g.
  // 15 a second, from a webcam). Return false if refused (too long, too
  // large).
  camera (mode) {
    const p = this.m.stringToNewUTF8 (mode);
    const ok = this.m._zg_sim_camera (p) === 0;
    this.m._free (p);
    return ok;
  }

  // quiet: not logged (for the parts of an animated code)
  cameraQR (data, quiet = false) {
    const bytes = typeof data === "string" ? new TextEncoder ().encode (data) : data;
    return this.withBytes (bytes, (p) => this.m._zg_sim_camera_qr (p, bytes.length, quiet ? 1 : 0) === 0);
  }

  // RGBA goes in colour (the experimental "qr-color" detector sees the
  // colours; the grey is (R + 2G + B) / 4), up to 2048 a side for a
  // picture; larger ones, and grey, go as grey.
  // An older simulator (sim/build/web, from before colour) has no RGB entry
  // points: such a page sends grey and says once that it needs a rebuild.
  hasColour () {
    if (typeof this.m._zg_sim_camera_push_rgb === "function") return true;
    if (!this.warnedColour) {
      this.warnedColour = true;
      console.warn ("zerogap: the simulator (zgsim.wasm) is older than this page: the camera sends grey;"
                    + " rebuild it (make -C sim web, or restart tools/zgide.sh) and reload");
    }
    return false;
  }

  cameraPicture (pixels, width, height) {
    if (pixels.length === width * height * 4 && width <= 2048 && height <= 2048 && this.hasColour ()) {
      const rgb = toRGB (pixels);
      return this.withBytes (rgb, (p) => this.m._zg_sim_camera_picture_rgb (p, width, height) === 0);
    }
    const grey = toGrey (pixels, width, height);
    return this.withBytes (grey, (p) => this.m._zg_sim_camera_picture (p, width, height) === 0);
  }

  cameraPush (pixels, width, height) {
    if (pixels.length === width * height * 4 && this.hasColour ()) {
      const rgb = toRGB (pixels);
      return this.withBytes (rgb, (p) => this.m._zg_sim_camera_push_rgb (p, width, height) === 0);
    }
    const grey = toGrey (pixels, width, height);
    return this.withBytes (grey, (p) => this.m._zg_sim_camera_push (p, width, height) === 0);
  }

  withBytes (bytes, fn) {
    const p = this.m._malloc (Math.max (1, bytes.length));
    this.m.HEAPU8.set (bytes, p);
    try {
      return fn (p);
    } finally {
      this.m._free (p);
    }
  }

  // Bumped whenever the screen changed.
  get frameSerial () {
    return this.m._zg_sim_frame_serial ();
  }

  // The screen as RGBA (an ImageData-compatible Uint8ClampedArray).
  pixels () {
    const w = this.width, h = this.height;
    const f = this.m._zg_web_frame () >> 1;
    const src = this.m.HEAPU16.subarray (f, f + w * h);
    const out = new Uint8ClampedArray (w * h * 4);
    for (let i = 0, o = 0; i < src.length; i++, o += 4) {
      const c = src[i];
      const r = c >> 11, g = (c >> 5) & 63, b = c & 31;
      out[o] = (r << 3) | (r >> 2);
      out[o + 1] = (g << 2) | (g >> 4);
      out[o + 2] = (b << 3) | (b >> 2);
      out[o + 3] = 255;
    }
    return out;
  }

  // Paints the screen on a canvas (width x height), if it changed.
  draw (canvas) {
    const serial = this.frameSerial;
    if (serial === this.lastSerial) return;
    this.lastSerial = serial;
    const ctx = canvas.getContext ("2d");
    if (!this.image || this.image.width !== this.width || this.image.height !== this.height) {
      this.image = ctx.createImageData (this.width, this.height);
    }
    this.image.data.set (this.pixels ());
    ctx.putImageData (this.image, 0, 0);
  }
}
