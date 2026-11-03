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
//   zg.pointer (x, y, pressed);
//   zg.stop ();
//
// One instance is one boot of one machine. To run again, make a new one
// (Zerogap.create): nothing carries over, as on the device.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export const MOD_SHIFT = 1, MOD_CTRL = 2, MOD_ALT = 4;

let factory = null;     // createZerogap, loaded once

export class Zerogap {
  // options: { onLog(line), onHalt(), moduleUrl } - moduleUrl: zgsim.js
  // (default: next to this file, as "make web" puts it in sim/build/web)
  static async create (options = {}) {
    if (!factory) {
      const url = options.moduleUrl || new URL ("../build/web/zgsim.js", import.meta.url).href;
      factory = (await import (url)).default;
    }
    const zg = new Zerogap ();
    zg.onLog = options.onLog || ((line) => console.log (line));
    zg.onHalt = options.onHalt || (() => {});
    zg.halted = false;
    zg.m = await factory ({
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

  // Boots with a screen of width x height (320x240 to 4096x4096). Without
  // writeCard(), there is no SD card.
  boot (width = 640, height = 480) {
    this.width = width;
    this.height = height;
    const card = this.hasCard ? this.m.stringToNewUTF8 ("/card") : 0;
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
