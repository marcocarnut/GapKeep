# zerogap (working name)

A tiny bare-metal OS for the Raspberry Pi Zero (no W) meant to be used as an
air-gapped machine: no Linux, no network stack, no radio. Built on
[Circle](https://github.com/rsta2/circle) (GPLv3) with an LVGL user interface,
later driven by QuickJS. First application: the dice39 BIP-39 generator.

## Layout

| Path | What |
| --- | --- |
| `circle/` | Circle as a git submodule, pinned to 51.1.1. Not modified. |
| `src/` | Our kernel: `kernel.*` (startup, main loop), `kbdindev.*` (USB keyboard → LVGL keypad), `ui_test.*` (step 1 test screen). |
| `tools/qemu_harness.py` | Boots a kernel in QEMU (`-M raspi0`) with USB keyboard and mouse, runs a scripted scenario, takes screenshots, checks the serial log. |
| `tests/*.txt` | Scenarios for the harness. |

## Setup

Needs `arm-none-eabi-gcc` (tested 13.2.1; Circle recommends 15.2.Rel1),
`qemu-system-arm` (tested 8.2.2) and Python 3 with Pillow (for PNG screenshots).

```sh
git submodule update --init circle                      # Circle 51.1.1 (pinned)
cd circle
git submodule update --init --depth 1 addon/lvgl/lvgl   # LVGL 9.4
./configure -r 1 --qemu --keymap US -f   # drop --qemu for a real-hardware build
./makeall -j"$(nproc)"
make -C addon/lvgl -j"$(nproc)"
cd ../src && make -j"$(nproc)"
```

`--qemu` disables a few things QEMU doesn't emulate (SDHOST, DMA burst
length, physical counter). Kernels for the real Zero must be built without it:
reconfigure, `./makeall clean`, rebuild.

## Run and test

```sh
python3 tools/qemu_harness.py tests/step1_input.txt --out /some/dir   # scripted, PASS/FAIL
python3 tools/qemu_harness.py --interactive                            # just boot, show serial log
```

Logs go to the serial port (on the Pi: GPIO14/15, 115200 baud). Add
`logdev=tty1` to `cmdline.txt` to send them to the screen instead.

In QEMU, Circle's mouse handling multiplies movement by 1.8 and ignores moves
that would leave the screen. The harness's `moveto` takes care of both.

## Status

- [x] Step 1: LVGL on the framebuffer, USB keyboard and mouse, focus and Tab navigation. Passes in QEMU; not yet tried on real hardware.
- [ ] Step 2: QuickJS embedded, JS creating LVGL widgets
- [ ] Step 3: native SHA-256 and hardware RNG, with test vectors
- [ ] Step 4: dice39 logic extracted and checked against the web version
- [ ] Step 5: dice39 user interface in LVGL
- [ ] Step 6: hardening and reproducible builds

Known gaps: the keyboard uses Circle's "cooked" mode, so there's no Shift+Tab
(PageUp/PageDown move focus back/forward for now) and Ctrl shortcuts are
ignored. That will move to raw mode with our own key mapping later.
