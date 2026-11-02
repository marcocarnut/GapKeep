# The hardware test rig

zerogap is developed mostly in QEMU, but QEMU is not a Pi Zero. The rig lets
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
bootloader (921600 baud) and a `config.txt`; copy those files to a FAT32
card. This is done once.

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
  reboot**, or install `tools/rig/zerogap-gadget.service` to do it at boot
  (instructions inside). See "Known issues".

## Using it

From the development machine:

```sh
tools/rig/run_hw_tests.sh                      # every scenario in tests/
tools/rig/run_hw_tests.sh tests/dice39.txt     # one scenario
ZG_RIG=user@host tools/rig/run_hw_tests.sh     # another rig (default mac@five.local)
```

This builds a test kernel for the Pi (`tools/build.sh pi TEST=1`), copies it
with the rig tools to `~/zerogap-rig` on the rig, plays each scenario and
fetches screenshots and logs. Each scenario starts with a reset and a fresh
upload (about 33 s).

On the rig itself, `zgrig.py` does the individual steps:

```sh
python3 zgrig.py reset                  # reset the Zero
python3 zgrig.py flash kernel.hex --log 20   # upload, run, print the log for 20 s
python3 zgrig.py log 10                 # print the serial log for 10 s
python3 zgrig.py shot screen.png        # screenshot (test builds)
python3 zgrig.py run kernel.hex scenario.txt --out DIR
```

Scenarios are the same files QEMU runs (`tests/*.txt`, see
`tools/qemu_harness.py`). On the rig, `shot` and `serialshot` both take the
screenshot over the serial line. Positions for `moveto` can be given as a
percentage of the screen size, because the Zero's screen size depends on the
monitor (1824x984 on a 1080p monitor with the firmware's default overscan,
640x480 in QEMU).

## How it works

- **Reset:** `pinctrl set 17 op dl`, 100 ms, then `pinctrl set 17 ip pn`
  (floating again: RUN has its own pull-up on the Zero).
- **Upload:** Circle's bootloader (`circle/tools/bootloader`) announces
  `IHEX-F`. `zgrig.py` first sends `R` (noise during reset can leave the
  bootloader in its error state, which only `R` leaves), then the kernel as
  the bootloader's binary records (`=` and the Intel HEX record's bytes: half
  the size of HEX text), waits for `#EOF:ok` and sends `g`.
- **Log:** the kernel logs at 921600 baud.
- **Screenshots:** `#shot` on the serial line, answered by test builds only
  (`src/testshot.*`, `tools/serialshot.py`).
- **Keyboard and mouse:** `tools/rig/gadget.sh` (configfs; boot-protocol
  keyboard with 8-byte reports and a 3-button mouse with relative 8-bit
  X/Y). `zgrig.py` translates the scenarios' QEMU key names to HID usage
  codes.

## Known issues

- A USB device that is connected but never answers hangs Circle's USB
  enumeration, and with it the boot. Five's USB controller is in that state
  between its driver loading and `gadget.sh up`. A real keyboard won't do
  this, but a broken device could; it should be fixed in Circle (a timeout on
  enumeration).
- Circle's mouse driver read uninitialized memory for report items a mouse
  doesn't have (a wheel, typically), which asserted on the first report.
  Fixed in `patches/circle/0001-usbmouse-zero-unused-report-items.patch`.
