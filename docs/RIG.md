# The hardware test rig

GapKeep is developed mostly in QEMU, but QEMU is not a Pi Zero. The rig lets
the same test scenarios run on a real Pi Zero with no person at the keyboard.
A second Raspberry Pi (here a Pi 5 called `five`) is wired to the Zero and:

- resets it, through its RUN pad;
- sends it kernels over the serial line, to Circle's serial bootloader on the
  Zero's SD card, so the card never changes;
- reads its log and takes screenshots over the same serial line (test builds
  only);
- acts as its USB keyboard and mouse (Linux USB gadget on the Pi 5's USB-C port).

## Wiring

| Pi 5 (rig) | Pi Zero |
| --- | --- |
| pin 6, GND | pin 6, GND |
| pin 8, GPIO14 (TXD) | pin 10, GPIO15 (RXD) |
| pin 10, GPIO15 (RXD) | pin 8, GPIO14 (TXD) |
| pin 11, GPIO17 | RUN pad (pulled low to reset; otherwise left floating) |
| pin 2, 5 V (optional) | pin 2, 5 V; then nothing in the Zero's PWR port |

USB: from the Pi 5's USB-C port (a USB-C plug to USB-A socket OTG adapter),
then a data A-to-micro-B cable into the Zero's "USB" port (not "PWR"). Tape
over the A plug's VBUS contact (pin 1, an outer one) so the two boards'
5 V supplies never meet. The Zero enumerates the gadget without VBUS, and a
plain cable is fine (no OTG ID wiring needed).

The Pi 5 then needs power from elsewhere (here PoE), since its USB-C port is
busy.

## SD card

`tools/make_sdcard.sh` fills `sdcard/` with the Pi firmware, Circle's serial
bootloader (921600 baud), a `config.txt` and the test card's `apps` folder
(`tests/sdcard`); copy all of it to a FAT32 card. This is done once.
Test kernels sent over serial read that `apps` folder like a real system;
`tests/sdapps.txt` checks it, and runs on the rig only with
`GK_RIG_SDAPPS=1` (cards made before the folder existed lack it).

## Setting up the rig

On the Pi 5 (Raspberry Pi OS, bookworm):

- `/boot/firmware/config.txt` gets `dtoverlay=uart0-pi5` (UART0 on GPIO14/15
  as `/dev/ttyAMA0`) and `dtoverlay=dwc2,dr_mode=peripheral` (USB-C as a
  gadget); then reboot.
- `python3-serial` and `python3-pil` are needed.
- The user running the tools must be in `dialout` (serial) and `gpio`
  (`pinctrl`).
- `sudo tools/rig/gadget.sh up` creates the keyboard and mouse (`/dev/hidg0`,
  `/dev/hidg1`). **Do this before resetting the Zero after every rig
  reboot**, or install `tools/rig/gapkeep-gadget.service` to do it at boot
  (instructions inside). See "Known issues".
- **If the Zero stops finding the keyboard** (its log: `dwhci: Control
  transfer timed out`, `Cannot get device descriptor`; the Pi 5's `dmesg`
  shows `new device is high-speed` but no `new address`), the gadget is
  wedged although its service says active: `sudo systemctl restart
  gapkeep-gadget` (or `sudo tools/rig/gadget.sh up`). Seen once, on
  2026-11-04, after the rig had been up for two days.
- **Camera:** a Pi Camera Module v2.1 is plugged into the Zero, looking
  at a printed QR code. `tests/picamera.txt` (rig only) uses it through
  `#camera pi` (docs/CAMERA.md). Other scenarios keep the synthetic
  camera, which test kernels start with. In this setup, no QR code was in
  the camera's view on 2026-11-04: it showed the ceiling
  (docs/camera/IMPLEMENTATION.md).
- Test commands on the serial line (`#camera ...`, `#crash ...`) are read
  by polling the UART's 16-byte FIFO from the main loop, so `gkrig.py`
  sends long lines in pieces of 12 bytes, 0.6 s apart.

## Using it

From the development machine:

```sh
tools/rig/run_hw_tests.sh                      # every scenario in tests/
tools/rig/run_hw_tests.sh tests/dice39.txt     # one scenario
GK_RIG=user@host tools/rig/run_hw_tests.sh     # another rig (default mac@five.local)
```

This builds a test kernel for the Pi (`tools/build.sh pi TEST=1`), copies it
with the rig tools to `~/gapkeep-rig` on the rig, plays each scenario and
fetches screenshots and logs. Each scenario starts with a reset and a fresh
upload (about 33 s).

**Aiming the camera:** `tools/rig/camview.py` shows the Pi Camera in a window
on the development machine, a 640x480 grey frame every 3.5 s or so, with lines
marking the middle. It builds and sends a test kernel and opens the scanner
(about a minute); `--no-flash` skips that when the scanner is already open.

On the rig itself, `gkrig.py` does the individual steps:

```sh
python3 gkrig.py reset                  # reset the Zero
python3 gkrig.py flash kernel.hex --log 20   # upload, run, print the log for 20 s
python3 gkrig.py log 10                 # print the serial log for 10 s
python3 gkrig.py shot screen.png        # screenshot (test builds)
python3 gkrig.py peek [kernel.hex]      # the camera's grey frames, as PGM on stdout
python3 gkrig.py run kernel.hex scenario.txt --out DIR
```

Scenarios are the same files QEMU runs (`tests/*.txt`, see
`tools/qemu_harness.py`). On the rig, `shot` and `serialshot` both take the
screenshot over the serial line. Positions for `moveto` can be given as a
percentage of the screen size, because the Zero's screen size depends on the
monitor (1824x984 on a 1080p monitor with the firmware's default overscan,
640x480 in QEMU).

Rig-only scenario commands and serial commands (test builds, `src/testshot.h`):

- `serialraw <name>`: the Pi camera's next raw frame (RAW8 Bayer, 13 s at
  921600 baud) as `<name>.raw`, with its size, exposure and gains in
  `<name>.raw.json`; `tests/camraw.txt` takes the colour bars and the scene
  in both of the scanner's modes.
- `send #experimental on`: experimental features on, as `experimental = yes`
  in `gapkeep.txt` would (the rig's card never changes); the launcher lists
  the experimental apps from its next start (`tests/colorqr_hw.txt`).
- `camera picture <name>`: one of the colour codes of `tests/colorqr`, built
  into test kernels, for the synthetic camera.

After a `serialshot`, wait a second before the next `send`: the Zero reads
no commands while it sends the screenshot.

## How it works

- **Reset:** `pinctrl set 17 op dl`, 100 ms, then `pinctrl set 17 ip pn`
  (floating again: RUN has its own pull-up on the Zero).
- **Upload:** Circle's bootloader (`circle/tools/bootloader`) announces
  `IHEX-F`. `gkrig.py` first sends `R` (noise during reset can leave the
  bootloader in its error state, which only `R` leaves), then the kernel as
  the bootloader's binary records (`=` and the Intel HEX record's bytes: half
  the size of HEX text), waits for `#EOF:ok` and sends `g`.
- **Log:** the kernel logs at 921600 baud.
- **Screenshots:** `#shot` on the serial line, answered by test builds only
  (`src/testshot.*`, `tools/serialshot.py`).
- **Keyboard and mouse:** `tools/rig/gadget.sh` (configfs; boot-protocol
  keyboard with 8-byte reports and a 3-button mouse with relative 8-bit
  X/Y). `gkrig.py` translates the scenarios' QEMU key names to HID usage
  codes.

## Known issues

- A USB device that is connected but never answers used to hang Circle's
  USB enumeration, and with it the boot; the rig's USB controller is in that
  state between its driver loading and `gadget.sh up`. Control transfers
  now time out after 3 s (`patches/circle/0003-dwhci-control-transfer-timeout.patch`),
  so such a device no longer hangs the boot. The rig still brings the gadget
  up before it resets the Zero, so that the keyboard and mouse are found.
- Circle's mouse driver read uninitialized memory for report items a mouse
  doesn't have (a wheel, typically), which asserted on the first report.
  Fixed in `patches/circle/0001-usbmouse-zero-unused-report-items.patch`.
