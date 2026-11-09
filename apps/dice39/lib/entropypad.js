// The entropy pad's accounting: dice39's rules, with its constants copied
// verbatim (vendor/dice.js). The pad itself (DOM code in dice39) is
// rewritten for gk:ui in main.js.
//
// A mouse press scores BITS_PER_TAP, a drag point BITS_PER_DRAG_POINT, and a
// drag counts only if it moved far enough, late enough after the last
// accepted point. Space or Enter on the focused pad is a press without a
// position, so it scores only the clock part of a tap. (GapKeep never
// delivers auto-repeated Enter to widgets: holding the key counts once.)

import { BITS_PER_DRAG_POINT, BITS_PER_TAP, MIN_DRAG_DISTANCE_PX, MIN_SAMPLE_INTERVAL_MS, SAMPLE_CAP }
  from "../vendor/dice.js";

export const BITS_PER_KEY_TAP = BITS_PER_TAP - BITS_PER_DRAG_POINT;

// Same formula as dice39's ENTROPY_BITS_TARGET(): the most the device can be
// asked for (entropy minus the fewest words you may roll), rounded up to a
// whole 32. 128 bits at 24 words, 96 at 18 and 15, 64 at 12.
export function entropyBitsTarget(spec) {
  return Math.ceil((spec.entropyBits - spec.minUser * 11) / 32) * 32;
}

export function newPad() {
  return { samples: [], bits: 0, last: null, lastTime: -Infinity };
}

// ev: a gk:ui press or drag event ({ pointer, x, y, time }). kind: "tap" or
// "drag". Returns whether the sample was accepted.
export function addPadSample(pad, ev, kind) {
  if (pad.samples.length >= SAMPLE_CAP) return false;
  const t = ev.time;
  if (kind === "drag") {
    // reject anything that isn't a genuine, deliberate movement: too soon
    // after the last accepted point, or too close to it
    if (t - pad.lastTime < MIN_SAMPLE_INTERVAL_MS) return false;
    if (pad.last) {
      const dx = ev.x - pad.last.x, dy = ev.y - pad.last.y;
      if (dx * dx + dy * dy < MIN_DRAG_DISTANCE_PX * MIN_DRAG_DISTANCE_PX) return false;
    }
  }
  pad.lastTime = t;
  if (ev.pointer) pad.last = { x: ev.x, y: ev.y };
  // every sample is hashed in full (samplesToBytes), however it is scored
  pad.samples.push({ x: ev.pointer ? ev.x : -1, y: ev.pointer ? ev.y : -1, t, ms: Date.now() });
  pad.bits += kind === "drag" ? BITS_PER_DRAG_POINT : ev.pointer ? BITS_PER_TAP : BITS_PER_KEY_TAP;
  return true;
}
