# Experimental features

Features still being researched, off unless the SD card's `zerogap.txt` (the
file of [CLOCK.md](CLOCK.md), "zerogap.txt") says

```
experimental = yes
```

The log says so at boot (`settings: experimental features on`). Sealed builds
don't read the card, so they never have them. Off, they are absent rather than
refused: an experimental detector is an unknown name, an experimental app is
neither listed nor started.

For apps, a manifest's `"experimental": true` marks an app as one
([APPS.md](APPS.md)); `sys.app.experimental` and the `apps.list()` entries
say it too.

## Colour QR codes

A colour QR code is an ordinary QR code whose data modules are coloured so
that any reader still sees their dark and light: a phone reads its text as
usual. The colours carry more data, about 3.6 times the code's own capacity
in total (`lib/colorqr/FORMAT.md`). It comes from a research project of the
same author; the decoder is `lib/colorqr` (C, MIT), and zerogap reads such
codes but cannot draw them.

- **`ui.Scanner`'s `"qr-color"` detector** reads the colour layer of each code
  the QR decoder finds, on the same frame in colour ([API.md](API.md),
  Scanner). Its `"detect"` event is its own, never merged into `"qr"`:
  `{ kind: "qr-color", bytes, text, status, colour }`, with the code's own
  bytes and text, `status` `"ok"` and the colours' data in `colour`, or, after
  a second of trying, `"plain"` (no colour layer) or `"unreadable"`.
- **The Color QR app** (`apps/colorqr`) shows both parts apart: what any QR
  reader sees, and what only the colours hold.

### Showing colour codes to the camera

Measured on the rig's Pi camera on 2026-11-05: version 10 codes at rate 3/4
in both profiles, on one monitor at one distance, shown at several sizes;
colorqr scored each raw frame against the known payload. A guide, not a
specification: soft focus is untested.

| Profile | Field | Camera pixels a module: symbols wrong |
| --- | --- | --- |
| a4.50 (default) | `"center"` | 2.8: 0.08 %; 2.4: 2.6 %; 1.9: fails (code found in 6 of 34 decodes) |
| | `"full"` | 1.4: fails |
| a8.50 | `"center"` | 5.5: 0 %; 3.7: 0.08 %; 2.8: about 11 % (near the limit); 2.3: fails |
| | `"full"` | 2.8: 0.04 %; 1.9: about 9 %, but the code found in 2 of 50 decodes; 1.4: fails |

- **Prefer the default field for small or distant codes**: the same code
  covers twice the pixels there. The `"full"` field is for a wider view;
  pixel for pixel it is cleaner (it bins on the sensor), but codes are
  smaller in it.
- **Aim for at least 4 camera pixels a module in the default field, 3 in
  `"full"`**, for margin. The scanner's log gives the code's side in pixels
  (divide by the modules: 17 + 4 per version).
- **Profiles:** a4.50 at rate 3/4, the default to recommend, has much more
  margin near the limit, for its colours and for finding the code (likely
  because its colours keep dark and light further apart in grey, which the
  QR decoder works on). a8.50 at rate 3/4 carries about 50 % more data and
  suits steady, in-focus setups with codes well above the limit.
- Scaling the code on the screen (an image viewer at 67 % or 50 %) made no
  difference to the colours; whole-number zoom is tidy, not needed.
- A colour layer that can't be read costs more than one that can: about
  0.36 s a try on a Pi Zero for version 10, against 0.2-0.3 s.

### Why it is experimental

zerogap's premise is that data leaves the device only through what can be
read off its screen, and enters only through what the person shows its
camera. A colour code weakens both sides:

- **Leaving:** a person checking a displayed code with a phone sees only its
  black and white. The colours could carry anything, a key included, and
  the check would not show it. So zerogap has **no colour encoder**: apps
  can't draw colour codes (`ui.QRCode` is black and white), and adding one
  would be a decision of its own.
- **Entering:** a code someone checked with a phone may carry more than they
  saw. Apps get the colour layer only by asking for `"qr-color"` by name,
  and get it apart from the code's text, so they can show the two apart, as
  the Color QR app does.

Like everything the camera sees, colour codes are untrusted input: the
decoder is fuzzed (`tools/fuzz_colorqr.sh`, through the QR decoder as the
scanner calls it), and the log gets lengths and the start of SHA-256s,
never the contents.

### How it works

- **Colour frames.** The camera makes them only while a scanner asks for
  `"qr-color"`. On the Pi camera each 2x2 Bayer tile gives one RGB pixel,
  linear (black level removed, no white balance: the decoder calibrates from
  the symbol), as the grey frames are made from the same tiles. The
  sensor's tiles are BGGR with the flips zerogap uses, checked against a red
  object ([camera/IMPLEMENTATION.md](camera/IMPLEMENTATION.md)). The
  simulator's camera shows colour pictures and webcam frames in colour.
- **The base code.** zxing-cpp reads the code as usual, and also keeps the
  data codewords it corrected (`patches/zxing-cpp/0005`), so the colour
  decoder rebuilds the exact symbol instead of reading its modules again;
  if they don't match the frame, it reads them again.
- **Time.** The colour decoder runs on the main loop, once per new code
  until it reads the layer: on a Pi Zero about 0.14 s for a version 5 code
  and 0.3 s for version 10, and nothing for a plain code, which it tells
  apart first (measured, `tests/colorqr_hw.txt`; the log gives each
  stage's time), during which the screen doesn't change; decoding stays at most half the time, as for
  QR codes. Its scratch memory (up to 18 MB, for version 40 in the "full"
  field) is allocated for the code's version, and zeroed and freed when
  the scanner stops.

### Testing

- `tests/colorqr.txt` (simulator and QEMU): the Color QR app reads colour
  codes made by the colorqr project (`tests/colorqr`, with their payloads),
  and a plain code.
- `tests/colorqr_hw.txt` (the rig): the same on a Pi Zero, for its timing;
  test builds turn experimental features on with `#experimental on` on the
  serial line, as the rig's card never changes.
- `tests/experimental_off.txt`: without `zerogap.txt`, the app can't start.
- `tools/fuzz_colorqr.sh`: the decoder under AddressSanitizer and UBSan.
- `tests/camraw.txt`, `tests/camcolour.txt`, `tests/camcodes.txt` (the rig):
  raw frames from the Pi camera, for tuning the decoder on the real sensor;
  the last two through the Color QR app, so with colour frames and its
  exposure, and `camcodes` logs whether the code on a screen in view was
  read (on 2026-11-05 a version 5 code on a monitor, at 7 and 4 pixels a
  module, was read at the first try every time).
