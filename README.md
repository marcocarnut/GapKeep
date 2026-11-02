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

## Building

Needs `arm-none-eabi-gcc` (tested 13.2.1; Circle recommends 15.2.Rel1),
`qemu-system-arm` (tested 8.2.2), Python 3, and Pillow for PNG screenshots.

```sh
git submodule update --init                              # Circle, QuickJS
git -C circle submodule update --init --depth 1 addon/lvgl/lvgl   # LVGL 9.4

cd circle
./configure -r 1 --qemu --keymap US --kernel-max-size 8 \
            -d KERNEL_STACK_SIZE=0x100000 -f            # see below
./makeall -j"$(nproc)"
cd ..

make -C lib/lvgl -j"$(nproc)"
make -C lib/quickjs -j"$(nproc)"
make -C src -j"$(nproc)"                                 # -> src/kernel.img
```

`--qemu` disables a few things QEMU doesn't emulate. For the real Pi Zero,
configure without it, then `./makeall clean`, rebuild Circle, `lib/lvgl` and
`src`. The other options are required: zerogap needs an 8 MB kernel limit and
a 1 MB stack.

Apps in `apps/` are bundled automatically. `make -C src TEST=1` also
bundles the test-only apps in `tests/apps/`.

## Running and testing in QEMU

```sh
python3 tools/qemu_harness.py --interactive     # boot, print the serial log
tools/run_tests.sh                              # all scenarios in tests/
```

The harness boots the kernel on QEMU's Pi Zero model with a USB keyboard and
mouse. It can type, click, take screenshots and wait for log lines, so most
development and testing needs no hardware.

## Running on a Pi Zero

Copy to a FAT32 SD card: the firmware (`bootcode.bin`, `start.elf`,
`fixup.dat`; run `make` in `circle/boot` to download them), a `config.txt`
(see `circle/boot/config32.txt`), and `kernel.img`. Logs go to the serial
port (GPIO 14/15, 115200 baud). Add `logdev=tty1` to `cmdline.txt` to send
them to the screen instead.

Keyboard and mouse connect through the Zero's USB OTG port, via an OTG
adapter and a hub.

**Using it:** Tab and Shift+Tab move between widgets, Enter or Space
activates, and the Windows (Super) key always returns to the launcher.

## Status

- [x] Step 1: LVGL on the framebuffer, USB keyboard and mouse
- [x] Step 2: QuickJS app runtime, `zg:ui` widget API, launcher, docs, tests
- [x] Step 3: native SHA-256 and a health-checked hardware RNG, with test vectors (`zg:crypto`)
- [ ] Step 4: dice39 logic extracted and checked against the web version
- [ ] Step 5: dice39 user interface
- [ ] Step 6: hardening (remove unused drivers), reproducible builds, real-hardware tests

So far everything has run under QEMU only, not on a real Pi Zero.

## Layout

| Path | What |
| --- | --- |
| `apps/` | Bundled apps: `launcher`, `hello`, `gallery` (all widgets plus a runtime self-test). |
| `src/` | Kernel (`kernel.*`, `kbdindev.*`) and runtime (`runtime/`). |
| `lib/` | Builds of LVGL (with `zg_lv_conf.h`) and QuickJS (with compat headers). |
| `circle/`, `third_party/quickjs/` | Pinned submodules, unmodified. |
| `tests/` | QEMU scenarios and test-only apps. |
| `tools/` | App bundler, QEMU harness, test runner. |
| `docs/` | Guides and reference. |
