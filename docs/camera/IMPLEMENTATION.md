# Pi Camera driver: implementation record

The implementer's side of the clean-room process (see PROVENANCE.md for the
spec writer's): what was built from [SPEC.md](SPEC.md), what else was used,
the decisions where the spec left a choice or a gap, and what the hardware
showed.

## What was implemented

| File | What |
| --- | --- |
| `src/camera/imx219.*` | The sensor over I2C: chip ID, the LP-11 stream toggle, the mode (SPEC 4.3 A-E), exposure and gains, test patterns, standby. Five modes (decision 15): `detail`, the centre 1280x960 unbinned (default); `centre`, the spec's recommended binned 640x480; `full`, the binned full field (SPEC 6.7); `wide` and `mid`. |
| `src/camera/unicam.*` | Unicam1: power domain, CAM1 clock, lane clock gate, bring-up (SPEC 5.3) and stop (5.6), the frame interrupt, rotation over four DMA buffers, cache maintenance, error and frame counters. |
| `src/camera/picamera.*` | `CZgPiCamera`, the `CZgCamera`: power (GPIO 41, LED GPIO 32), probe, start/stop, 2x2 Bayer average to grey, automatic exposure, logging, errors ("no camera", "no frames from the camera", ...). |
| `src/kernel.*` | Production and sealed builds probe at boot and register the camera if found. |
| `src/testshot.*` | Test builds: `#camera pi`, `#camera synth`, `#camera pattern <n>`, `#camera mode centre|full`. |
| `tests/picamera.txt` | Rig-only scenario; `tools/run_tests.sh` and `tools/run_sim_tests.sh` skip files with a `# Rig only` line. |

## Sources used beyond SPEC.md

No camera driver code of any project was opened or searched (Linux, rsta2/libcamera or other); PROVENANCE.md's links were not followed.

- **Circle** (this repository, GPLv3), headers and sources:
  - `CI2CMaster` (`i2cmaster.h/.cpp`): device 0 config 1 = GPIO 28/29 ALT0
    with pull-ups; the constructor claims the pins, the destructor returns
    them to inputs. Its transfers poll for DONE without a timeout, which led
    to decision 8.
  - `CGPIOClock` (`gpioclock.h/.cpp`): `GPIOClockCAM1`,
    `GPIOClockSourcePLLD`, `Start (5, 0, 0)`.
  - `bcmpropertytags.h`: `PROPTAG_SET_DOMAIN_STATE`, `TPropertyTagDomainState`,
    `DOMAIN_ID_UNICAM1`.
  - `bcm2835int.h`: `ARM_IRQ_CAM1`.
  - `bcm2835.h`: `BUS_ADDRESS()`, `ARM_BSC0_BASE`, `ARM_BSC_DIV__OFFSET`.
  - `synchronize.h`: `CleanAndInvalidateDataCacheRange`, barriers,
    `EnterCritical`.
  - `alloc.h` / `heapallocator.h`: `memalign` aligns to at most
    `HEAP_BLOCK_ALIGN` (32 bytes on the Pi 1) and asserts otherwise (found
    on the hardware: decision 2).
  - `gpiopin.cpp`: `SetMode (GPIOModeOutput)` drives the pin low first.
- **BCM2835 ARM Peripherals**: the BSC registers (the DIV register, for
  decision 8).
- **ARM1176 general knowledge**: the data cache has 32-byte lines and does
  not fill lines speculatively, so a buffer the CPU only reads needs an
  invalidate before each read and nothing during DMA.

## Decisions and open questions

1. **Four buffers, not three** (SPEC 5.4 suggests three). The states are
   Free, Next, Writing, Ready and InUse (unicam.h). At FS, Next becomes
   Writing (a Writing without its FE is dropped), and a Free buffer becomes
   Next. At FE, Writing becomes Ready (an older, unread Ready goes back to
   Free). With four buffers one is always free at FS, so the receiver is
   never left without a valid buffer, and the consumer always gets the
   newest frame. No dummy buffer is needed. A fallback (reusing the unread
   Ready buffer) exists for the impossible case.
2. **32-byte buffer alignment**, not 4 KiB. SPEC 5.5 asks for at least 32
   bytes. Circle's `memalign` cannot do more, and 32 bytes works on the
   hardware. Strides are rounded up to 32 bytes (1640 becomes 1664 in the
   full mode).
3. **Cache:** each buffer is cleaned and invalidated once, before Unicam
   first gets it. `TakeFrame` invalidates it again (Circle's clean and
   invalidate, on lines that are clean) before the CPU reads it. The CPU
   never writes the buffers.
4. **I2C:** 400 kHz. Reads are a 2-byte index write, a STOP, then a read
   (SPEC 2.3 allows it). Circle's repeated-start path is not needed.
   Multi-byte values go in one transfer. Exposure, analogue gain and
   digital gain (0x0157-0x015B, adjacent registers) go in **one 7-byte
   transfer**, so they latch at the same V-sync. The access sequence in
   SPEC 4.3 A is written byte by byte, never merged.
5. **Power-up wait: 20 ms** after GPIO 41 rises (SPEC says ≥ 6 ms, 10-20
   ms suggested). GPIO 0/1 are set to inputs before BSC0 is used on 28/29
   (SPEC 8.10).
6. **LCIE kept at 128**, as in the proven settings; line-count interrupts
   are ignored. Buffers are reprogrammed at FS only.
7. **Test-pattern window = the output size** (640x480 or 1640x1232),
   instead of SPEC 4.3 D's 1640x1232 in both modes. With 1640 in the
   640-wide mode, only the first three of eight bars showed (each bar was
   205 output pixels wide), so the window is in output pixels. With
   640x480, all eight bars span the picture. This register only affects
   the test pattern.
8. **No BSC0, no hang:** after `CI2CMaster::Initialize`, the BSC0 divider
   must read back non-zero. Otherwise (an emulator without the controller)
   the probe reports no camera instead of waiting forever in Circle's
   polling loop. Production QEMU tests run the boot probe, and QEMU 8.2's raspi0 has no
   BSC0: it logs `picamera: no I2C controller` (without the check, the
   boot would hang).
9. **Grey:** the average of each 2x2 tile, with the RAW8 black level (16)
   removed and the rest stretched to 0-255 (a 1021-entry table). Two tiles
   are summed per pair of 32-bit loads, in 16-bit lanes.
10. **Automatic exposure** (SPEC 7, in GetFrame after each new frame):
    - **Measurement:** the mean over the middle half of the grey frame,
      sub-sampled (about 5000 samples), and the fraction of samples
      ≥ 250. A clipped fraction stands in for the suggested
      95th-percentile histogram.
    - **Target:** mean 110 of 255, or 55 if more than 2 % of samples clip.
      The first version instead forced "darker" whenever more than 2 %
      clipped. A room lit by a lamp in view then converged to a mean of
      about 20, everything but the lamp black. Lowering the target, as the
      spec says, fixed it.
    - **Step:** target / mean, clamped to [0.5, 2], then square-rooted (half
      way in log terms). Changes under 5 % are skipped, and two frames are
      skipped after each write.
    - **Distribution:** exposure up to 700 lines (13.2 ms, against motion
      blur), then analogue gain to 8x, then exposure to the frame limit
      (1759), then digital gain to 4x. Going darker undoes these in reverse
      order. The values set are read back into the product.
    - **Test patterns:** while a pattern is on, the AE rests and the
      digital gain is 1.0x (the pattern comes before digital gain).
    - **Timing:** the writes come from the main loop, not exactly in frame
      blanking (SPEC 7 step 5). Because the values go in one transfer, the
      worst case is one frame with the old exposure.
11. **"No frames from the camera":** no frame end for 1 s while streaming.
    The camera then logs a Unicam register dump and its counters, and
    reports the error. The scanner stops the camera.
12. **Stop:** sensor standby, the Unicam stop sequence, one frame time
    (34 ms), then the power domain, the CAM1 clock and GPIO 41/32 go off,
    and I2C is released.
13. **Full-field mode** (SPEC 6.7, values from its table): one of the
    modes of decision 15.
14. **Production probe at boot:** powers the camera for about 20 ms, reads
    the chip ID and powers it down. The camera is registered only if the ID
    is 0x0219. Test builds keep the synthetic camera until `#camera pi`.

15. **Modes, and the default "detail"** (added after the first version,
    which used the spec's recommended binned 640x480). Each mode is a
    window, an output size and a binning (0 or 3 in BINNING_MODE_H/V_A).
    Every window is centred on the array centre (1640, 1232) and starts on
    an even pixel:

    | Mode | X | Y | Output | Binning | Grey |
    | --- | --- | --- | --- | --- | --- |
    | `centre` | 1000-2279 | 752-1711 | 640x480 | 3 | 320x240 |
    | `full` | 0-3279 | 0-2463 | 1640x1232 | 3 | 820x616 |
    | `detail` | 1000-2279 | 752-1711 | 1280x960 | 0 | 640x480 |
    | `wide` | 360-2919 | 272-2191 | 1280x960 | 3 | 640x480 |
    | `mid` | 820-2459 | 616-1847 | 1640x1232 | 0 | 820x616 |

    All modes keep LINE_LENGTH_A 3448 and FRM_LENGTH_A 1763, and all
    measured 30.0 frame/s. `detail` was chosen by measurement on the rig
    (docs/CAMERA.md, "Why detail", has the table). The unbinned modes give
    a small printed code twice the pixels (126 px against 62 px). quirc
    found it on about half the decodes, against 0-10 % for the binned
    modes. They read it 0.7-1.2 s after the start, and 0.2-0.3 s after
    it came back into view. `detail` beats `mid` (same detail, 28 % wider
    view) on cost: 10 ms of grey conversion and about 66 ms of decoding
    per frame, against 17 and 81 ms, and 4.7 MB of DMA buffers against
    7.8 MB.

    Spec gaps for these modes, and the choices made:
    - **Line length:** SPEC 4.3 gives LINE_LENGTH_A only for the binned
      mode. 3448 was kept for the unbinned ones. It suffices for a
      1280- or 1640-pixel line, and SPEC 6.7 lists 1763 frame lines (30
      frame/s) for unbinned 1920x1080 too.
    - **FRM_LENGTH_A units:** SPEC 4.5 says they are 2 lines in analogue
      binning. If so, the binned and unbinned modes would differ by a
      factor of 2. They don't: 1763 gives 30.0 frame/s in both. So one
      unit is one line time (18.9 µs) either way.
    - **Window alignment:** the spec does not say whether binned windows
      must start on even, or multiple-of-4, coordinates. The new windows
      start on even pixels (360, 272, 820, 616), like SPEC's own (1000,
      752, 0, 0). Every one produced a clean picture and colour bars.
    - **Test-pattern window:** set to the output size in every mode
      (decision 7).
    - **Field of view:** the "about 26 degrees" in docs/CAMERA.md comes
      from the module's published horizontal field of view (62.2 degrees,
      Raspberry Pi's camera module specifications), scaled by the window's
      share of the 3280-pixel width. It is not in SPEC.md.

16. **The scanner's field** (`ui.Scanner`'s `field`, through
    `CZgCamera::SetField` before each start): `center` uses `detail`
    (1280x960 unbinned, 640x480 grey) and `full` uses `full` (3280x2464
    binned, 820x616 grey). In test builds, `#camera mode <name>` overrides
    the field until `#camera mode auto` or `#camera synth`, so the rig can
    still try any mode. With zxing-cpp, `full` reads the printed code as
    reliably as `detail`, at half the size (64 px against 128). With quirc
    it never did (benchmark below).

Open questions:

- **Orientation** (0x0172 = 0x03, both flips, as specified): unconfirmed.
  On the rig the camera looks at the ceiling (a lamp and a curtain rail),
  and which way the module lies is unknown.
- **Power domain off:** after the domain was turned off and on again (about
  1.4 s apart), Unicam read ANA 0x778 and CLK 0xC0000005, its state from
  before. Either the firmware does not really power the block down, or not
  that quickly. The bring-up writes every register it uses, so this does
  not matter, but the reset-value check (SPEC 3.2) is only meaningful at
  the first power-up.

## Spec corrections and clarifications

- **4.5:** with FRM_LENGTH_A = 1763 in the analogue-binned modes, the
  measured rate is **30.0 frame/s** (both modes). One register unit is one
  line time of 18.9 µs; no halving is needed.
- **4.3 D / 6.4:** the TP_WINDOW registers count output pixels. 1640x1232
  in the 640x480 mode shows only 3 of the 8 bars (decision 7).
- **4.7:** the bar order seen in grey is consistent with white, yellow,
  cyan, green, magenta, red, blue, black. Grey values were 255, 187, 187,
  116, 116, 48, 48, 0. Bars of equal grey can't be told apart.
- **5.2 / 3.2:** at the first power-up CLK read **0x0D000002**, not
  0x00000002. The low bits match; bits 24, 26 and 27 were set (status,
  presumably). ANA read 0x777 as expected.
- **5.4:** IBWP at FE, minus the buffer's start, is the bytes written. The
  last line counts its width, not the stride (1231 strides + 1640 bytes in
  the full mode). Once the next FS has already been taken, IBWP points
  into the next buffer.

## Measurements on the hardware (Pi Zero v1.3, Camera Module v2.1, rig "five")

- **Stage a (power, I2C):** `picamera: IMX219 found (model 0219)`, in test
  builds (`#camera pi`) and at boot in a production build (with
  `LOG=serial`: 20 ms). Unicam powered: `ANA 777, CLK d000002`, VPU clock
  250 MHz.
- **Stage b (frames):** `90 frames in 2966 ms: 30.0 frame/s, 480 lines in
  the last` (640x480); `91 frames in 2999 ms: 30.0 frame/s` with 1232
  lines (1640x1232). No receiver errors were logged in any run. The only
  incomplete frame is the one in flight at Stop. Typical:
  `stopped: 257 frames started, 256 complete, 217 shown, 39 replaced
  unread, 1 incomplete`.
- **Stage c (colour bars):** five bands as expected (decision 7). The
  column counter (pattern 7) rises smoothly from 0 to 160 across the frame,
  so the byte order and stride are right. PN9 looks like noise.
- **Stage d (scene, AE):** a real, sharp picture of the room. The AE
  converges within about 2 s, e.g. `exposure 1759 lines (33.2 ms), gain
  8.00, digital 1.01, mean 104` in the dim centre view.
- **Stage e (QR decode):** first, no code was in view (the camera faced
  the ceiling). Once a printed code was put in front of the lens,
  `tests/picamera.txt` read it, in the binned 640x480 mode, about 1 s
  after the colour bars went off. With the `detail` default, it reads it
  in 0.2-0.3 s (below).

### The mode benchmark (Camera Module v2.1 looking at the printed code "Hello ZeroGap!")

Two rounds of `start, 15 s, colour bars 3 s, 12 s` per mode, plus an
earlier round with `expect`s for centre, detail and mid. Per run, from the
camera's and the scanner's stop lines (`grey in N us`, `N decoded`, `N
found, N px side`) and the log times of `streaming`, `test pattern 0` and
`qrscan: code N`:

| Run | Grey | Decodes, found | Decode avg/max | Side | First read | After bars |
| --- | --- | --- | --- | --- | --- | --- |
| centre, round 0 | 2525 µs | 304, 29 | 50/95 ms | 62 px | 6.8 s | 12.2 s |
| centre 1 | 2523 µs | 252, 17 | 52/96 ms | 62 px | 4.8 s | 5.9 s |
| centre 2 | 2520 µs | 639, 0 | 13/95 ms | - | never | never |
| full 1 | 16736 µs | 159, 0 | 92/131 ms | - | never | never |
| full 2 | 16697 µs | 222, 0 | 60/134 ms | - | never | never |
| detail, round 0 | 10058 µs | 166, 54 | 52/113 ms | 126 px | 1.2 s | 0.23 s |
| detail 1 | 10058 µs | 217, 111 | 68/117 ms | 126 px | 0.67 s | 0.17 s |
| detail 2 | 10056 µs | 229, 107 | 64/112 ms | 126 px | 0.68 s | 0.33 s |
| wide 1 | 10071 µs | 246, 0 | 60/112 ms | - | never | never |
| wide 2 | 10077 µs | 497, 0 | 29/114 ms | - | never | never |
| mid, round 0 | 16679 µs | 123, 34 | 69/131 ms | 126 px | 1.1 s | 0.22 s |
| mid 1 | 16684 µs | 189, 66 | 75/132 ms | 126 px | 0.77 s | 0.33 s |
| mid 2 | 16690 µs | 169, 79 | 87/130 ms | 126 px | 0.85 s | 0.21 s |

Every run: 30.0 frame/s, every line received. DMA buffers: 4 x 300 KiB
(centre), 4 x 1200 KiB (detail, wide), 4 x 2002 KiB (full, mid).

### The same benchmark with zxing-cpp (replacing quirc)

Same scenario and code. Two runs per mode, for `detail`, `mid` and `full`,
on the merged zxing-cpp decoder:

| Run | Grey | Decodes, found | Decode avg/max | Side | First read | After bars |
| --- | --- | --- | --- | --- | --- | --- |
| detail 1 | 10065 µs | 318, 279 (88 %) | 35/42 ms | 128 px | 0.57 s | 0.08 s |
| detail 2 | 10069 µs | 311, 241 (77 %) | 38/54 ms | 129 px | 0.48 s | 0.18 s |
| mid 1 | 16680 µs | 244, 213 (87 %) | 56/68 ms | 128 px | 0.71 s | 0.25 s |
| mid 2 | 16709 µs | 245, 215 (88 %) | 56/68 ms | 128 px | 0.74 s | 0.22 s |
| full 1 | 16698 µs | 253, 222 (88 %) | 51/68 ms | 64 px | 0.76 s | 0.21 s |
| full 2 | 16694 µs | 254, 223 (88 %) | 51/68 ms | 64 px | 0.72 s | 0.21 s |

Side by side, the averages of the two runs:

| Mode | Grey | quirc: found, decode, first read | zxing-cpp: found, decode, first read |
| --- | --- | --- | --- |
| detail (640x480) | 10.1 ms | 49 %, 66 ms, 0.68 s | 83 %, 37 ms, 0.53 s |
| mid (820x616) | 16.7 ms | 41 %, 81 ms, 0.81 s | 88 %, 56 ms, 0.73 s |
| full (820x616) | 16.7 ms | 0 %, 76 ms, never | 88 %, 51 ms, 0.74 s |

zxing-cpp's decode time hardly depends on whether a code is found (the
maximum stays at 42-68 ms), where quirc's ranged from 13 to 134 ms. It
reads the 64-pixel code in `full`, which quirc never did. `tests/picamera.txt`
therefore expects a read in the wide view as well. There it was read
0.25 s after the switch, on 26 of 27 decodes.
