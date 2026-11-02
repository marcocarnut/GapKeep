# zerogap

**The minimalistic OS for air-gapped apps.**

zerogap is a tiny bare-metal system for the Raspberry Pi Zero (the plain one,
with no radio). It boots in about two seconds into a graphical app launcher.
Apps are written in JavaScript and run on [QuickJS](https://bellard.org/quickjs/),
with an [LVGL](https://lvgl.io) interface driven by a USB keyboard and mouse.
There is no Linux, no network stack, no file system for code and no radio:
a computer for creating and handling secrets that have no way out except
what you read off the screen.

Built on [Circle](https://github.com/rsta2/circle) (bare-metal C++ for the
Pi). Licensed under the GPLv3.

```js
import * as ui from "zg:ui";

const label = new ui.Label({ text: "Hello, air gap!", font: 28 });
new ui.Button({ text: "Click", onClick: () => (label.text = "Clicked!") });
```

## Documentation

- [Writing apps](docs/APPS.md): start here.
- [API reference](docs/API.md): `zg:ui`, `zg:sys`, `zg:apps`, globals.
- [Architecture and security model](docs/ARCHITECTURE.md)
- [Hardware test rig](docs/RIG.md)

## Building

Needs `arm-none-eabi-gcc` (tested 13.2.1; Circle recommends 15.2.Rel1),
`qemu-system-arm` (tested 8.2.2), Python 3, and Pillow for PNG screenshots.

```sh
git submodule update --init                              # Circle, QuickJS
git -C circle submodule update --init --depth 1 addon/lvgl/lvgl   # LVGL 9.4

tools/build.sh qemu          # -> src/kernel.img for QEMU
tools/build.sh pi            # -> src/kernel.img for a real Pi Zero
tools/build.sh pi TEST=1     # ... with the test-only apps and serial screenshots
```

`build.sh` applies zerogap's fixes to Circle (`patches/circle/`), configures
Circle for the target (QEMU lacks a few peripherals, so the two need
different Circle libraries) and builds Circle, LVGL, QuickJS and the kernel.
Switching targets rebuilds everything (about 40 s); otherwise builds are
incremental. zerogap needs Circle's 8 MB kernel limit and a 1 MB stack, which
`build.sh` sets.

Apps in `apps/` are bundled automatically. Test builds also bundle the
test-only apps in `tests/apps/`, listed after the real ones.

## Running and testing in QEMU

```sh
python3 tools/qemu_harness.py --interactive     # boot, print the serial log
tools/run_tests.sh                              # everything: QEMU scenarios, QuickJS's
                                                # own tests on the target, native and Node tests
```

The harness boots the kernel on QEMU's Pi Zero model with a USB keyboard and
mouse. It can type, click, take screenshots and wait for log lines, so most
development and testing needs no hardware.

## Running on a Pi Zero

`tools/build.sh pi` builds the kernel. Copy to a FAT32 SD card: the firmware
(`bootcode.bin`, `start.elf`, `fixup.dat`; run `make` in `circle/boot` to
download them), a `config.txt` with `arm_64bit=0`, and `kernel.img`. Logs go
to the serial port (GPIO 14/15, 921600 baud).

Keyboard and mouse connect to the Zero's "USB" port (not "PWR"), through an
OTG adapter, or a hub for both.

For development, a second Raspberry Pi can drive the Zero: reset it, send it
kernels over serial, act as its keyboard and mouse, and take screenshots.
The QEMU scenarios then run unchanged on real hardware; see
[docs/RIG.md](docs/RIG.md).

**Using it:** Tab and Shift+Tab move between widgets, Enter or Space
activates, and the Windows (Super) key always returns to the launcher.

## Status

- [x] Step 1: LVGL on the framebuffer, USB keyboard and mouse
- [x] Step 2: QuickJS app runtime, `zg:ui` widget API, launcher, docs, tests
- [x] Step 3: native SHA-256 and a health-checked hardware RNG, with test vectors (`zg:crypto`)
- [x] Step 4: dice39 logic extracted verbatim (`tools/extract_dice39.py`) and checked: BIP-39 and BIP-93 test vectors, under Node and on the target
- [x] Step 5: dice39 user interface: dice-code entry, results with verbatim proof, mistake detectors, SeedQR / Compact SeedQR / words QR, codex32 shares
- [x] Real hardware: every scenario passes on a Pi Zero (v1.3, 512 MB) through the rig ([docs/RIG.md](docs/RIG.md))
- [ ] Step 6: hardening (remove unused drivers, USB enumeration timeouts), reproducible builds

## Layout

| Path | What |
| --- | --- |
| `apps/` | Bundled apps: `launcher`, `dice39`, `hello`, `gallery` (all widgets plus a runtime self-test). |
| `src/` | Kernel (`kernel.*`, `kbdindev.*`) and runtime (`runtime/`). |
| `lib/` | Builds of LVGL (with `zg_lv_conf.h`) and QuickJS (with compat headers). |
| `circle/`, `third_party/quickjs/` | Pinned submodules. Circle gets the fixes in `patches/circle/`. |
| `tests/` | QEMU scenarios and test-only apps. |
| `tools/` | Build script, app bundler, QEMU harness, test runner; `tools/rig/` drives real hardware. |
| `docs/` | Guides and reference. |
