# zerogap architecture

zerogap is a single-purpose, bare-metal system for the Raspberry Pi Zero
(BCM2835, one ARM1176 core, 512 MB). It boots straight into a JavaScript app
runtime with a graphical interface. There is no Linux, no file system for
code, no network stack and no radio.

```
 ┌──────────────────────────────────────────────────────────────┐
 │  apps/*            JavaScript apps (launcher, dice39, ...)   │
 ├──────────────────────────────────────────────────────────────┤
 │  src/runtime       app host · zg:ui · zg:sys · zg:apps        │
 │                    QuickJS (third_party/quickjs)              │
 │                    LVGL (circle/addon/lvgl, lib/lvgl config)  │
 ├──────────────────────────────────────────────────────────────┤
 │  src/kernel.cpp    main loop · keyboard → LVGL glue           │
 │  Circle            USB host + HID, framebuffer, interrupts,   │
 │                    timers, serial log (circle/, GPLv3)        │
 ├──────────────────────────────────────────────────────────────┤
 │  VideoCore firmware: bootcode.bin, start.elf (closed blobs)  │
 └──────────────────────────────────────────────────────────────┘
```

## Boot

1. The GPU's boot ROM loads `bootcode.bin` from the SD card, which loads
   `start.elf`. Both are Broadcom's closed firmware; every OS on the Pi
   depends on them.
2. `start.elf` sets up HDMI, reads `config.txt`, and loads `kernel.img`
   (zerogap) to 0x8000 on the ARM core.
3. Circle's startup code sets up the stack (1 MB), MMU and caches, and calls
   `main()` → `CKernel` (`src/kernel.cpp`).
4. The kernel brings up the screen, the serial log, interrupts, the timer and
   USB (keyboard and mouse are found by plug-and-play), then LVGL, the
   keyboard input device and the app host.
5. The app host starts the launcher.

## Main loop

Everything runs in one loop on one core; there are no threads:

```
loop:
    USB plug-and-play     (new keyboard or mouse?)
    keyboard LEDs
    LVGL                  (read input, run timers, redraw)
      └─ input events and JS timers call into the running app's JS
    app host              (promise jobs, deferred widget deletion, app switch)
```

USB interrupts only queue key presses (`CKeyboardIndev`) and set the Home
flag; all JavaScript runs from the main loop.

## The app host (`src/runtime/apphost.*`)

Runs one app at a time. Starting an app:

1. A new **QuickJS runtime** with a 96 MB heap limit, a 512 KB stack limit, a
   module loader and an interrupt handler (watchdog and Home key).
2. A new **LVGL screen** and **focus group**; the keyboard is pointed at it.
3. The app's entry module is evaluated. It imports `zg:*` modules (created
   on demand, permission-checked) and its own files (from the bundle).

Stopping an app (exit, Home, or launching another) deletes its screen, which
deletes every widget and releases its JS handlers; then its timers; then its
JS context and runtime. `JS_FreeRuntime` asserts that every object was
freed, so a leak in the runtime shows up as a crash in testing rather than
slow memory loss.

Apps are **bundled into the kernel image** at build time
(`tools/bundle_apps.py` → `src/generated/apps_bundle.c`). There is no way to
load code at run time.

### Widgets (`src/runtime/js_ui.cpp`)

Each widget is a JS object linked to an LVGL object through a `TZgNode`.
While the LVGL object exists, the node keeps the JS object alive, so the same
JS object is returned every time (`label.parent === container`). LVGL's
delete event releases it. JS never deletes LVGL objects directly:
`widget.delete()` hides the widget and queues it, and the host deletes it
after event processing. That keeps "a button deletes itself in its click
handler" safe.

All properties are described by one table; constructors, `set()` and the
per-type property accessors all go through it, with strict validation.

### Cryptography (`src/crypto/`)

SHA-256 written from FIPS 180-4, self-tested at boot and testable on the
development machine (`tests/native/test_sha256.c`). The hardware RNG wrapper
(`hwrng.*`) applies NIST SP 800-90B health tests to every raw byte and
conditions output through SHA-256; see `zg:crypto` in [API.md](API.md).

### C runtime

QuickJS is a hosted C program. zerogap provides only what it needs:

- Circle: `malloc`/`free`/`realloc`, `mem*`, `str*` basics.
- newlib (from the toolchain): `libm` math functions and headers.
- `src/runtime/libc_shim.c`: about 15 small functions (`snprintf` via LVGL's
  printf, logging `fprintf`, UTC-only `localtime_r`, clocks). Small enough
  to read in a few minutes.
- `lib/quickjs/compat/`: a no-op `pthread.h` (one core, no threads) and an
  `inttypes.h` fix for Debian's toolchain.

QuickJS's own OS layer (`quickjs-libc.c`: files, processes, sockets) is not
built.

QuickJS is compiled with `-fno-strict-aliasing`. On `arm-none-eabi`,
`uint32_t` is `unsigned long`, and QuickJS passes such variables through
`int *` in places; under strict aliasing GCC miscompiled the string
iterator (`for (const ch of "abc")` never ended). QuickJS's own test suite
(`test_language`, `test_builtin`, `test_bigint`, `test_closure`,
`test_loop`) runs on the target in test builds (`tests/qjstests.txt`) to
catch this class of problem.

## Security model

Goal: a machine on which secrets are created and handled without any channel
for them to leave, other than what a person reads off the screen.

**Attack surface that exists:**

| Surface | Notes |
| --- | --- |
| USB host controller + HID parsing (Circle) | The only external input. Keyboards and mice only; more drivers could be removed. |
| HDMI output | Output only. |
| Serial port (GPIO 14/15) | Log output only; zerogap never reads from it. Leave it unconnected in use. |
| SD card | Read by the firmware at boot. zerogap itself does not mount or write it. |
| VideoCore firmware | Closed. Shared by every Pi OS; out of our control. |

**What is absent by design:** network stack, Wi-Fi and Bluetooth (the
plain Pi Zero has no radio at all), file systems for code, dynamic code
loading, a clock you can trust, and any way for apps to reach each other.

**Isolation between apps:** each app has its own JS runtime, so apps cannot
reach each other's objects. They share an address space (there is no MMU
protection between apps), so this guards against mistakes and keeps app
code honest, not against native-code exploits. All native code is part of
the image and auditable.

**Secrets in memory:** both heaps that hold app data zero every block when
it is freed: the JS heap (`apphost.cpp`, which also makes `realloc` move so
the old block can be zeroed) and LVGL's heap (`lv_mem_wipe.c`; labels and
text areas keep copies of what they show). When an app exits, all its
memory is freed, so seed words do not linger after the app is closed. Data
still in use is of course in RAM; a Pi Zero has no memory encryption.

**Trusted code** is the image: Circle, LVGL, QuickJS, `src/` and `apps/`.
Builds should be reproducible (pinned submodules and toolchain) so a
published image hash can be checked; see the README.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/` | Apps bundled into the image. |
| `circle/` | Circle (submodule) plus the fixes in `patches/circle/`, applied by `tools/build.sh`. Its LVGL submodule supplies the LVGL sources. |
| `third_party/quickjs/` | QuickJS (submodule, unmodified). |
| `lib/lvgl/` | Builds LVGL with `zg_lv_conf.h`. |
| `lib/quickjs/` | Builds the QuickJS engine; compat headers. |
| `src/` | Kernel and runtime. `src/generated/` is build output. |
| `tests/` | QEMU scenarios; `tests/apps/` holds test-only apps (`make TEST=1`); `tests/native`, `tests/dice39` host tests. |
| `tools/` | App bundler, QEMU harness, test runner. |
| `docs/` | This file, the API reference and the app guide. |
