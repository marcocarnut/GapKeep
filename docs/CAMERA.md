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
| Pi Camera driver | Camera Module v2.1 (IMX219) on the Zero v1.3: `src/camera/`, kernel only. Checked on the rig: frames, colour bars, automatic exposure, and a printed code read within a second. |

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

- **The mode:** "detail": the centre 1280x960 of the sensor, not binned,
  as RAW8 on two CSI-2 lanes at 30 frame/s. The average of each 2x2 Bayer
  tile gives a **640x480 grey frame**. The view is the central 39 % of the
  sensor's width, about 26 degrees: 19 cm wide at 40 cm, 28 cm at 60 cm.
  A code must be held in front of the lens, but it gets twice the pixels
  of the binned modes.
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

#### Why "detail": the modes measured

Resolution matters as much as the decoder, so the default was chosen by
measurement. On the rig, a printed code ("Hello ZeroGap!", a small code)
hangs in front of the camera, and each mode ran twice on the Zero with
quirc. Each run: start the scanner, 15 s of scanning, 3 s of colour bars
(the code out of sight), then 12 s more.

| Mode | Sensor window, binning | Grey | View (of the width) | Grey per frame | Decode per frame | Code side | Decodes that found it | First read after start | Read again after bars off | DMA buffers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `centre` (A) | 1280x960, binned | 320x240 | 39 % | 2.5 ms | 13-52 ms | 62 px | 7 % / 0 % | 4.8 s / never | 5.9 s / never | 1.2 MB |
| `full` (B) | 3280x2464, binned | 820x616 | 100 % | 16.7 ms | 60-92 ms | (62 px) | 0 % / 0 % | never | never | 7.8 MB |
| **`detail` (C)** | 1280x960, not binned | 640x480 | 39 % | 10.1 ms | 64-68 ms | 126 px | **51 % / 47 %** | **0.67 s / 0.68 s** | **0.17 s / 0.33 s** | 4.7 MB |
| `wide` (D) | 2560x1920, binned | 640x480 | 78 % | 10.1 ms | 29-60 ms | (62 px) | 0 % / 0 % | never | never | 4.7 MB |
| `mid` | 1640x1232, not binned | 820x616 | 50 % | 16.7 ms | 75-87 ms | 126 px | 35 % / 47 % | 0.77 s / 0.85 s | 0.33 s / 0.21 s | 7.8 MB |

All modes ran at 30.0 frame/s. "Decode per frame" is quirc's average (the
maximum was 95-134 ms). Under 15 ms means no code was in the picture
(quirc gives up early). The scanner decodes at most half the time, so
about half the frames are decoded. The code side in parentheses is what
the binned modes' scale implies: they found no code to measure.

- **The binned modes see too little of a small code.** The full field and
  the 2560-wide window cover more of the room, but at the same detail per
  degree as `centre`: 2-3 pixels per module, softened by the analogue
  binning. `centre` found the code on 7-10 % of decodes in two of its
  three runs, taking 5-7 s; `full` and `wide` never found it.
- **The unbinned modes read it at once.** At twice the detail (5-6
  pixels per module), `detail` and `mid` found it on about half the
  decodes. Each read it 0.7-1.2 s after the scanner started, and in
  0.2-0.3 s once it came back into view.
- **`detail` over `mid`:** the same detail, so the same success. `mid`'s
  view is 28 % wider, but it costs about 30 % more CPU per frame (17 ms of grey
  conversion and 75-87 ms of decoding, against 10 and 64-68 ms) and
  7.8 MB of buffers instead of 4.7. On the Zero's single core, the
  narrower view keeps the screen more responsive. For a paper code at
  30-50 cm or a phone at arm's length, the code is held in front of the
  lens anyway.

The other modes stay available in test builds: `#camera mode centre`,
`full`, `wide` or `mid` (below). The measurements are from quirc; another
decoder would shift the decode times, but not the pixels a code gets.

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
  | `#camera mode <name>` | the Pi Camera's mode, from the next start: `detail` (default), `centre`, `full`, `wide`, `mid` (see above) |

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
