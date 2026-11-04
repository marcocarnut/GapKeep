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
| Pi Camera driver | Not yet. See below. |

The builds (`sim/Makefile`, `src/Makefile` with `lib/quirc/Makefile`, and
`tools/fuzz_qr.sh`) apply `patches/quirc/` (`tools/apply_patches.sh`) and use
the decoder when the submodule is checked out.

### The Pi Camera

Circle's author maintains [libcamera for Circle](https://github.com/rsta2/libcamera):
it drives Camera Module 1 (OV5647) and 2 (IMX219) directly, without the
GPU's camera firmware, on the Zero v1.3 and later (the Zero needs its own,
narrower cable). It delivers raw 10-bit Bayer frames. For QR codes, the
average of each 2×2 block is a good grey picture at half the resolution;
Module 2 has no automatic exposure, so the kernel would adjust exposure and
gain from the picture's brightness.

Open question: its files say GPL-2.0 only, and zerogap (with Circle) is
GPLv3, so the two can't be combined in a kernel we distribute. Its author
can't simply relicense it either: the sensor and Unicam code is ported from
Linux drivers (`imx219.c`, `bcm2835-unicam.c`, Raspberry Pi Ltd and
others, GPL-2.0 only), and the sensor's mode tables were recorded from the
Raspberry Pi firmware's I2C traffic. Camera Modules 3 and the HQ camera aren't supported by it.

## Testing without a camera

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
  camera module.
- **Scenarios:** `camera qr <text>` works on all three (`tools/qemu_harness.py`
  sends it the right way). `tests/qrscan.txt` reads codes with `apps/qrscan`.
- **Fuzzing:** `tools/fuzz_qr.sh [rounds] [seed]` feeds the decoder
  thousands of images under AddressSanitizer and UBSan (with float-to-int
  overflow checks): noise, real codes
  damaged in random ways and cropped, fields of finder patterns, odd sizes
  (`tests/fuzz/fuzz_qr.cpp`).
