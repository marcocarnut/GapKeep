# The camera and QR codes

GapKeep can read data off QR codes with a camera: the one way in for data
other than the keyboard. Apps use one widget, `ui.Scanner`: they say what
to look for, and get what the kernel found, nothing else:

```js
import * as ui from "gk:ui";

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
| `"qr"` | QR codes | `bytes`, `text` | [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp)'s QR code reader ([below](#the-qr-decoder)) |

Naming detectors after what they find (`"qr"`, not `"zxing"`) lets the
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
camera (camera.h) -> greyscale frames -> CGkScanner (scanner.cpp) -> onDetect({ kind, ... })
                                           |  preview, drawn by the widget
                                           |  detectors: "qr" = zxing-cpp (qrdecode.cpp)
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
- **The field** (`field` on the scanner) is what part of the camera's view
  the frames show. `"center"`, the default: the middle at full detail,
  640×480 grey (on the Pi camera the unbinned centre of the sensor, about
  26° across: about 19 cm wide at 40 cm). `"full"`: all of the camera's
  view, with less detail per degree (on the Pi, 820×616 grey over about
  62°), so a code must take up more of the picture to be read. The
  measurements behind the default are in
  [camera/IMPLEMENTATION.md](camera/IMPLEMENTATION.md). The simulator and
  the IDE do the same with pictures and webcam frames: the middle 640×480
  pixel for pixel, or the whole picture averaged down to fit 640×480.
- **The view** is the frame scaled to fit the widget (320×240 unless set), in
  grey, with a green outline around the code just read.
- **One scanner at a time** has the camera; another gets the error "the
  camera is in use by another scanner".
- **Logs** never contain what a code holds: it may be a secret, and test
  builds log to the serial port. `apps/qrscan` logs lengths and the start of
  the SHA-256.

## The QR decoder

The `"qr"` detector is zxing-cpp's QR code reader
(`third_party/zxing-cpp`, called by `src/runtime/qrdecode.cpp`). It
replaced [quirc](https://github.com/dlbeer/quirc), which read far fewer
codes: on BoofCV's QR code benchmark images scaled down to 320 px, zxing-cpp found a code in 211 of 536 images and quirc
in 122 (at 640 px: 349 and 216), and it was faster too.

- **What it reads:** QR codes (model 2, the ones printed and shown today),
  any way up, mirrored, and light on dark. Not the old model 1, micro or
  rectangular (rMQR) codes, and none of zxing-cpp's other symbologies:
  they are not built (`lib/zxing/Version.h`, `lib/zxing/zxing.mk`).
- **What apps get:** the payload's bytes as encoded in the code, without
  character set conversion or ECI processing (zxing-cpp's `bytes()`, not
  `text()`); `text` is those bytes when they are UTF-8. The corners of
  the code are in the frame's pixels.
- **Settings**, chosen by measurement for the Pi camera's 320x240 frames on
  the Zero's 1 GHz ARM1176, which has no NEON, and where most frames show no
  code at all (host timings, per frame, synthetic camera, -O2):

  | | 640x480, no code | 640x480, 14-byte code | 320x240, no code | 320x240, 14 bytes | 320x240, 1000 bytes |
  | --- | --- | --- | --- | --- | --- |
  | quirc (before) | 3.7 ms | 2.2 ms | 0.70 ms | 1.6 ms | not read |
  | zxing-cpp, as set | 2.0 ms | 1.2 ms | 0.36 ms | 0.30 ms | 1.2 ms |

  - "try harder" off: on BoofCV's images it read no more codes at 320 px
    (one more of 536 at 640 px) and took 11% (at 640 px, 26%) longer;
  - "try invert" on: light-on-dark codes (screens in dark mode) for 20%
    more time on frames without a code;
  - downscaling only above 500 px: 320x240 frames are never scaled down;
    640x480 frames are also searched at a third of their size, which reads
    8% more codes;
  - the local-average binariser (zxing-cpp's default), at most as many
    codes as the scanner asks for (one).

  The Zero's own timings are in the scanner's log (`scanner: ... ms each on
  average`) and come from the rig.
- **Safety.** zxing-cpp is C++20 and throws exceptions; the kernel has no
  exception runtime. GapKeep's patches (`patches/zxing-cpp/`) make the QR
  payload decoder report malformed data as an error instead of throwing
  (a code is just not read), and turn every other throw into a call to
  `ZXing::Fatal()`, which stops the system with a message in the log, as a
  failed assertion does (so do the C++ library's own checks,
  `lib/zxing/cxxrt.cpp`). Those are internal errors, not reactions to input:
  the fuzzer (below) counts reaching one as a bug, and finds none.
- **Licence:** Apache-2.0, which combines with GapKeep's GPLv3. zxing-cpp has
  no NOTICE file. Its source stays as published, in the submodule; GapKeep's
  changes are the patch files, each saying what it changes and why. Copies of
  the kernel carry zxing-cpp's licence: `tools/make_sdcard.sh` puts it on the
  card as `LICENCE.zxing-cpp`.

### How it is built

- **Pinned** to zxing-cpp commit `390c4bd` (3 November 2026, library version
  3.1.1), not the v3.1.1 tag (29 July 2026): the 103 commits since include
  fixes for input it could get from a camera, a heap overflow on very wide
  images (`ca5314e`) and a hang in the finder pattern search (`a17fd9d`). It
  is also what was measured.
- **Patches** (`patches/zxing-cpp/`, applied by `tools/apply_patches.sh`):
  1. the QR payload decoder without exceptions: `BitSource` keeps a sticky
     error, and the decoder stops at the first one (worth sending upstream:
     upstream's unit and black box tests give the same results);
  2. builds without exceptions or `thread_local` (`ZX_THROW`, and
     `ZX_THREAD_LOCAL` settable; one core, so GapKeep makes it `static`);
  3. and 4. fixes for what the fuzzer found: no alignment pattern search
     around a point far outside the image (a float-to-int conversion of a
     huge value: undefined behaviour), and no line through two equal
     alignment pattern positions (a failed assertion: on the Pi, a stop
     caused by a crafted code). Worth sending upstream too.
- **The kernel:** `lib/zxing/Makefile`, C++20 and the C++ library's headers
  for those files only, Circle's ARM1176 flags. What it needs of the C++
  library that is not in headers comes from `lib/zxing/cxxrt.cpp` and two
  small, self-contained objects of the toolchain's `libstdc++.a` (`tree.o`,
  `list.o`), not from `libstdc++.a` itself, which would bring the exception
  runtime. Only what `GkDecodeQR` reaches is kept (`ld -r --gc-sections`):
  about 195 KiB of code, against quirc's 20 KiB; the production kernel grew
  from 1985 to 2161 KiB.
- **The simulator** (`sim/Makefile`, native and WebAssembly) and the fuzzer
  (`tools/fuzz_qr.sh`) build the same files with the same settings.
- Without the submodule, builds say "this build has no QR decoder".

## Status

| Piece | State |
| --- | --- |
| `ui.Scanner`, scanning, preview, permission | Done, in the runtime (Pi and simulator). |
| QR decoder | [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp)'s QR code reader (Apache-2.0), `third_party/zxing-cpp`, pinned, with GapKeep's patches in `patches/zxing-cpp/` ([The QR decoder](#the-qr-decoder)). Fuzzed; timed on the host; the Zero's timings still to be taken on the rig. It replaced quirc, which read fewer codes. |
| Simulated camera | Done: the simulator, the IDE (QR codes from text, pictures, the webcam) and test kernels (`#camera` on the serial line). |
| Pi Camera driver | Camera Module v2.1 (IMX219) on the Zero v1.3: `src/camera/`, kernel only. Checked on the rig: frames, colour bars, automatic exposure, and a printed code read within a second. |

The builds (`sim/Makefile`, `src/Makefile` with `lib/zxing/Makefile`, and
`tools/fuzz_qr.sh`) apply `patches/zxing-cpp/` (`tools/apply_patches.sh`) and
use the decoder when the submodule is checked out.

### The Pi Camera

`src/camera/` drives the Raspberry Pi Camera Module v2.1 (Sony IMX219) on
the Pi Zero v1.3's camera connector (with the Zero's narrower cable),
without the GPU's camera firmware. It was written clean-room, from the
specification in [camera/SPEC.md](camera/SPEC.md), not from other drivers'
code (whose licence, GPL-2.0 only, doesn't combine with GapKeep's GPLv3).
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
  | `#camera grey` | the running Pi Camera's last grey frame, over the serial line, for aiming it (`tools/rig/camview.py`) |
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
  overflow checks), built as the kernel builds it (C++20, no exceptions), so
  that a fatal error is a finding too: noise, real codes damaged in random
  ways and cropped, fields of finder patterns, odd sizes, and crafted codes:
  correct error correction around random bit streams or random segments
  (modes, counts, ECI designators, FNC1, structured append, valid or not),
  drawn at random sizes and angles, mirrored, inverted, damaged, as an
  attacker could print them, so that they reach the payload decoder (about
  40% do). Some rounds call zxing-cpp's QR decoder on module matrices and its
  payload decoder on bytes directly, for every symbol type and version
  (`tests/fuzz/fuzz_qr.cpp`).
