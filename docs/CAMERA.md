# The camera and QR codes

zerogap can read data off QR codes with a camera: the one way in for data
other than the keyboard. Apps scan with one widget, `ui.QRScanner`, and get
the **decoded contents** of the codes, nothing else:

```js
import * as ui from "zg:ui";

const scanner = new ui.QRScanner({
  width: 320, height: 240,                 // where the camera's view shows
  onCode: ({ bytes, text }) => { ... },    // text: null unless valid UTF-8
  onError: ({ reason }) => { ... },        // "no camera", ...
});
scanner.stop();                            // so do delete() and the app ending
```

The manifest must ask for it: `"permissions": ["camera"]`. The details are in
[API.md](API.md#qrscanner); `apps/qrscan` is a complete example.

## Why apps never see the picture

The kernel turns the camera on, draws its view in the widget, finds the QR
codes and decodes them. JavaScript gets bytes, and only when a code was read:

- **Security.** An app can't record what the camera sees (a room, a face, a
  screen nearby), so it can't show it or encode it into anything it displays.
  There is no API that returns pixels: not from the scanner, not from the
  screen.
- **Performance.** The Pi Zero's single core does the decoding in C; frames
  never cross into the JavaScript engine.
- **One place to get right.** Image decoding is where parsers of untrusted
  input go wrong. It lives in one C library, fuzzed (below), not in every app.

Recognising other things (another barcode format, say) would follow the same
rule: a new widget or option in the kernel, never pixels for JavaScript.

## How a scan works

```
camera (camera.h)  ->  greyscale frames  ->  CZgQRScanner (qrscan.cpp)  ->  onCode({ bytes, text })
                                              |  preview, drawn by the widget
                                              |  quirc (qrdecode.cpp)
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
| `ui.QRScanner`, scanning, preview, permission | Done, in the runtime (Pi and simulator). |
| QR decoder | [quirc](https://github.com/dlbeer/quirc) (ISC licence), as `third_party/quirc`. Until it is there, builds say "this build has no QR decoder". |
| Simulated camera | Done: the simulator, the IDE (QR codes from text, pictures, the webcam) and test kernels (`#camera` on the serial line). |
| Pi Camera driver | Not yet. See below. |

**Getting the decoder:** `git submodule add https://github.com/dlbeer/quirc
third_party/quirc`, then pin it to a release. The builds (`sim/Makefile`,
`src/Makefile`, `lib/quirc/Makefile`) pick it up when it is there.

### The Pi Camera

Circle's author maintains [libcamera for Circle](https://github.com/rsta2/libcamera):
it drives Camera Module 1 (OV5647) and 2 (IMX219) directly, without the
GPU's camera firmware, on the Zero v1.3 and later (the Zero needs its own,
narrower cable). It delivers raw 10-bit Bayer frames. For QR codes, the
average of each 2×2 block is a good grey picture at half the resolution;
Module 2 has no automatic exposure, so the kernel would adjust exposure and
gain from the picture's brightness.

Open question: its files say GPL-2.0 only, and zerogap (with Circle) is
GPLv3, so the two can't be combined in a kernel we distribute as things
stand. Camera Modules 3 and the HQ camera aren't supported by it.

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
  thousands of images under AddressSanitizer and UBSan: noise, real codes
  damaged in random ways and cropped, fields of finder patterns, odd sizes
  (`tests/fuzz/fuzz_qr.cpp`).
