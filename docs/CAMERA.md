# The camera and QR codes

zerogap can read data off QR codes with a camera: the one way in for data
other than the keyboard. Apps use one widget, `ui.Scanner`: they say what
to look for, and get what the kernel found, nothing else:

```js
import * as ui from "zg:ui";

const scanner = new ui.Scanner({
  detect: ["qr"],                          // what to look for
  width: 320, height: 240,                 // where the camera's view shows
  onDetect: ({ kind, bytes, text }) => { ... },  // kind "qr"; text: null unless UTF-8
  onError: ({ reason }) => { ... },        // "no camera", ...
});
scanner.stop();                            // so do delete() and the app ending
```

The manifest must ask for it: `"permissions": ["camera"]`. The details are in
[API.md](API.md#scanner); `apps/qrscan` is a complete example.

## Detectors

`detect` lists the detectors to run on each frame, by **what they
recognise**, not by the library that does it:

| Name | Finds | Event fields | Engine |
| --- | --- | --- | --- |
| `"qr"` | QR codes | `bytes`, `text` | [quirc](https://github.com/dlbeer/quirc) |

Naming detectors after what they find (`"qr"`, not `"quirc"`) lets the
engine change (a faster decoder, a fix) without changing any app. New
detectors (ArUco markers for a dice scanner, say) come in under new names,
with their own fields in the `"detect"` event, tagged by `kind`. An unknown
name throws, listing the detectors the system has, so an app can tell
whether it runs on a system that has what it needs.

## Why apps never see the picture

The kernel turns the camera on, draws its view in the widget, and runs the
detectors. JavaScript gets their results, and only when something was found:

- **Security.** An app can't record what the camera sees (a room, a face, a
  screen nearby), so it can't show it or encode it into anything it displays.
  There is no API that returns pixels: not from the scanner, not from the
  screen.
- **Performance.** The Pi Zero's single core runs the detectors in C;
  frames never cross into the JavaScript engine.
- **One place to get right.** Image decoding is where parsers of untrusted
  input go wrong. It lives in a few C libraries, fuzzed (below), not in
  every app.

## How a scan works

```
camera (camera.h) -> greyscale frames -> CZgScanner (scanner.cpp) -> onDetect({ kind, ... })
                                           |  preview, drawn by the widget
                                           |  detectors: "qr" = quirc (qrdecode.cpp)
```

- **Frames** are 8-bit greyscale. The QR decoder needs nothing more, and a
  sensor's raw data turns into grey cheaply.
- **Decoding** takes at most half the time: a decode that took *D* waits *D*
  before the next, so the screen and the keyboard stay responsive on the
  Zero.
- **Reports.** A code is reported when it differs from the last one, or when
  it comes back after 2 s out of sight, or after `start()`. An app reading
  an animated code (several parts, shown in turn) gets each part once each
  time it comes round, and puts them together itself: that is data, not
  pixels.
- **The view** is the frame scaled to fit the widget (320×240 unless set), in
  grey, with a green outline around the code just read.
- **One scanner at a time** has the camera; another gets the error "the
  camera is in use by another scanner".
- **Logs** never contain what a code holds: it may be a secret, and test
  builds log to the serial port. `apps/qrscan` logs lengths and the start of
  the SHA-256.

## Status

| Piece | State |
| --- | --- |
| `ui.Scanner`, scanning, preview, permission | Done, in the runtime (Pi and simulator). |
| QR decoder | [quirc](https://github.com/dlbeer/quirc) (ISC licence), `third_party/quirc`, pinned; zerogap's fixes in `patches/quirc/`, both found by the fuzzer: an array index computed before its range check, and integer overflows on degenerate perspectives (huge coordinates). Worth sending upstream. Without the submodule, builds say "this build has no QR decoder". |
| Simulated camera | Done: the simulator, the IDE (QR codes from text, pictures, the webcam) and test kernels (`#camera` on the serial line). |
| Pi Camera driver | Camera Module v2.1 (IMX219) on the Zero v1.3: `src/camera/`, kernel only. Frames, colour bars and automatic exposure checked on the rig; reading a real printed code not yet (see below). |

The builds (`sim/Makefile`, `src/Makefile` with `lib/quirc/Makefile`, and
`tools/fuzz_qr.sh`) apply `patches/quirc/` (`tools/apply_patches.sh`) and use
the decoder when the submodule is checked out.

### The Pi Camera

`src/camera/` drives the Raspberry Pi Camera Module v2.1 (Sony IMX219) on
the Pi Zero v1.3's camera connector (with the Zero's narrower cable),
without the GPU's camera firmware. It was written clean-room, from the
specification in [camera/SPEC.md](camera/SPEC.md), not from other drivers'
code (whose licence, GPL-2.0 only, doesn't combine with zerogap's GPLv3).
[camera/IMPLEMENTATION.md](camera/IMPLEMENTATION.md) records the decisions
and the measurements.

- **The mode:** 640x480 RAW8 on two CSI-2 lanes, the centre 1280x960 of the
  sensor binned 2x2, 30 frame/s. The average of each 2x2 Bayer tile gives
  a 320x240 grey frame. It is a modest zoom: a code must be held in front
  of the lens. (Test builds also offer the full field, 1640x1232, for
  diagnosis.)
- **Exposure:** the sensor has no automatic exposure, so the kernel sets
  exposure time, analogue gain and digital gain from the picture's
  brightness. Exposure comes first, up to 13 ms against motion blur.
- **Power:** the module is powered only while a scanner runs. At boot,
  production builds power it for about 20 ms to read the sensor's chip ID,
  and register the camera if it is there. Otherwise scanners report
  "no camera".
- **Errors:** "no camera", "no frames from the camera" (nothing for 1 s),
  "the camera does not answer" (I2C), "the camera receiver does not start".
- **Logs:** the probe (chip ID), the mode, the frame rate measured from the
  receiver's interrupts, the frame counts at stop, exposure changes (at
  most every 2 s) and receiver errors. Never image data.

Camera Modules 1 (OV5647) and 3 (IMX708) and the HQ camera are not
supported: the probe finds no IMX219 and reports no camera.

## Testing with and without a camera

The **synthetic camera** (`src/runtime/synthcam.cpp`) films an empty scene,
a QR code made from bytes (slightly turned, blurred at the edges, with
noise), a picture, or frames pushed by the host. The scanner and decoder
are the same code as with a real camera.

- **Simulator** (stdin, and in scenarios): `camera qr <text>`,
  `camera qrhex <hex>`, `camera picture <file.pgm|.ppm>`, `camera scene`,
  `camera none`. See [SIMULATOR.md](SIMULATOR.md#the-camera).
- **IDE:** the Camera bar under the screen: a code from text (one per line
  for an animated code), a picture, your webcam, or no camera. See
  [IDE.md](IDE.md#the-camera).
- **Test kernels** (`make TEST=1`, QEMU and the rig): the synthetic camera,
  driven by `#camera qr <text>`, `#camera scene` and `#camera none` on the
  serial line. On the rig this times the decoder on a real Zero, without a
  camera module. Test kernels on a Zero with a camera module can switch to
  it:

  | Command | Does |
  | --- | --- |
  | `#camera pi` | the Pi Camera, if the probe finds one (logs `picamera: IMX219 found (model 0219)` and `camera: pi`) |
  | `#camera synth` | back to the synthetic camera (so do `qr`, `scene` and `none`) |
  | `#camera pattern <n>` | the sensor's test pattern: 0 off, 1 solid colour, 2 colour bars, 7 column counter, ... |
  | `#camera mode centre` / `full` | the Pi Camera's mode, from the next start: 640x480 (default) or the full field, 1640x1232 |

  A switch applies from the next scanner start: a running scanner keeps the
  camera it started with. In grey, the colour bars are five bands: white,
  yellow and cyan, green and magenta, red and blue, black.
- **Scenarios:** `camera qr <text>` works on all three (`tools/qemu_harness.py`
  sends it the right way). `tests/qrscan.txt` reads codes with `apps/qrscan`.
  `tests/picamera.txt` runs on the rig only (its `# Rig only` line makes
  the QEMU and simulator runners skip it): the real camera, colour bars
  in a serial screenshot, then a printed code in front of the lens.
- **Fuzzing:** `tools/fuzz_qr.sh [rounds] [seed]` feeds the decoder
  thousands of images under AddressSanitizer and UBSan (with float-to-int
  overflow checks): noise, real codes
  damaged in random ways and cropped, fields of finder patterns, odd sizes
  (`tests/fuzz/fuzz_qr.cpp`).
