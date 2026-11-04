# Pi Camera driver: implementation record

The implementer's side of the clean-room process (see PROVENANCE.md for the
spec writer's): what was built from [SPEC.md](SPEC.md), what else was used,
the decisions where the spec left a choice or a gap, and what the hardware
showed.

## What was implemented

| File | What |
| --- | --- |
| `src/camera/imx219.*` | The sensor over I2C: chip ID, the LP-11 stream toggle, the mode (SPEC 4.3 A-E), exposure and gains, test patterns, standby. Two modes: the recommended 640x480 centre crop (default) and the 1640x1232 full field (SPEC 6.7). |
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
13. **Full-field mode** (SPEC 6.7, values from its table) is available in
    test builds (`#camera mode full`), for diagnosis. The default stays the
    recommended centre crop. The full mode's 820x616 grey takes about 35 ms
    per decode on the Zero, against 5 ms for 320x240.
14. **Production probe at boot:** powers the camera for about 20 ms, reads
    the chip ID and powers it down. The camera is registered only if the ID
    is 0x0219. Test builds keep the synthetic camera until `#camera pi`.

Open questions:

- **Orientation** (0x0172 = 0x03, both flips, as specified): unconfirmed.
  On the rig the camera looks at the ceiling (a lamp and a curtain rail),
  and which way the module lies is unknown.
- **QR decoding from the real camera: not verified** on the hardware, since
  no QR code was in the camera's view (see Measurements).
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
- **Stage e (QR decode): not reached.** The camera on the rig faces the
  ceiling, and no QR code is in its field of view in either mode. The
  scanner ran on every frame (about 5 ms each at 320x240) and found
  nothing. `tests/picamera.txt` therefore fails at its last step,
  `expect qrscan: code 1`; everything before it passes.
