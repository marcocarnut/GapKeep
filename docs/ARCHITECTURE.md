# zerogap architecture

zerogap is a single-purpose, bare-metal system for the Raspberry Pi Zero
(BCM2835, one ARM1176 core, 512 MB). It boots straight into a JavaScript app
runtime with a graphical interface. There is no Linux, no network stack and
no radio; the SD card is read once at boot, for the apps, and never written.

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
   USB (keyboard and mouse are found by plug-and-play), reads the apps from
   the SD card (`CAppStore`), then brings up LVGL, the keyboard input device
   and the app host.
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
   on demand, permission-checked) and its own files (from memory).

Stopping an app (exit, Home, or launching another) deletes its screen, which
deletes every widget and releases its JS handlers; then its timers; then its
JS context and runtime. `JS_FreeRuntime` asserts that every object was
freed, so a leak in the runtime shows up as a crash in testing rather than
slow memory loss.

Apps come from two places (`src/runtime/appstore.*`), with the same checks
and the same description (`zg_app_t`):

- **Built in**, at build time (`tools/bundle_apps.py` →
  `src/generated/apps_bundle.c`): the launcher always; every app in sealed
  and test builds.
- **The SD card's `/apps` folder**, read once at boot into memory by
  read-only FatFs (`lib/fatfs`, configured with `FF_FS_READONLY`, so no
  write code is even compiled) over Circle's SD driver. Each app is checked
  (manifest, names, UTF-8, size limits) and hashed; refused apps are listed
  in the launcher with the reason. A card app cannot take a built-in app's
  id.

After boot nothing more is loaded: apps cannot read files or load code
other than their own modules, which are already in memory.

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
| USB host controller + HID parsing (Circle) | The only input from outside. Only the hub, keyboard and mouse (boot protocol) drivers are in the image; every other class driver is left out at build time (`EXCLUDE_USB_*` in `tools/build.sh`), including the generic-HID path and its report descriptor parser. Control transfers time out after 3 s (`patches/circle/0003`), so a device that never answers cannot hang the system. |
| HDMI output | Output only. CEC is ignored (`hdmi_ignore_cec` in `config.txt`). |
| Serial port (GPIO 14/15) | Production builds for the Pi contain no serial driver: the UART is never set up, its pins are made inputs, and the firmware's is off (`enable_uart=0`); the log goes nowhere. Test builds log to it and take test commands from it (`src/testshot.*`). |
| SD card | Read by the firmware at boot, then by zerogap, once, for `/apps` (FAT, read-only driver). Never written. Sealed builds don't contain the SD code. |
| VideoCore firmware | Closed. Shared by every Pi OS; out of our control. Pinned by hash (`tools/firmware.sha256`). |

**What is absent by design:** network stack, Wi-Fi and Bluetooth (the
plain Pi Zero has no radio at all), writing to storage, file access for
apps, code loading after boot, a clock you can trust, and any way for apps
to reach each other.

**Apps on the card** are as trustworthy as the card: whoever can write it
can replace `kernel.img` too, so loading apps from it does not move the
trust boundary. The launcher shows each app's SHA-256, to compare with a
published one. A sealed build (`make SEALED=1`) removes the SD and FAT code
from the trusted base.

**Isolation between apps:** each app has its own JS runtime, so apps cannot
reach each other's objects. They share an address space (everything runs
privileged, on one core), so this guards against mistakes and keeps app
code honest, not against native-code exploits. All native code is part of
the image and auditable.

**Memory protection** (`patches/circle/0004`, for the Pi Zero only): the
kernel is mapped with 4 KB pages, so that

- code is read-only (and the only executable memory),
- constants are read-only,
- data, heap and stacks are not executable,
- the exception vectors become read-only once they are set up,
- the unused memory below the kernel stack is unmapped, so a stack
  overflow faults instead of running into the data below it.

Every C and C++ file (Circle, LVGL, QuickJS, zerogap) is compiled with
`-fstack-protector-strong`, with the canary taken from the hardware RNG at
boot (`src/runtime/stackguard.cpp`). A violation of any of these stops the
system; `tests/memprotect.txt` makes each one happen on purpose
(`src/testcrash.cpp`, test builds only) and checks that it does.

**Secrets in memory:** both heaps that hold app data zero every block when
it is freed: the JS heap (`apphost.cpp`, which also makes `realloc` move so
the old block can be zeroed) and LVGL's heap (`lv_mem_wipe.c`; labels and
text areas keep copies of what they show). When an app exits, all its
memory is freed, so seed words do not linger after the app is closed, and
the screen is redrawn completely. Data still in use is of course in RAM; a
Pi Zero has no memory encryption.

**Trusted code** is the image (Circle, LVGL, QuickJS, FatFs, `src/`, the
built-in apps) and the apps on the card. Builds are reproducible: with the
pinned compiler (`tools/toolchain.sh`), the same commit gives the same
`kernel.img`, byte for byte, wherever it is built
(`tools/check_reproducible.sh`). The running kernel shows the SHA-256 of
its own code and constants (launcher, key `i`), which is the SHA-256 of the
start of `kernel.img`, so what runs can be checked against a published
build.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/` | The apps: built in (the launcher, or all in sealed builds) or copied to the card's `/apps`. |
| `circle/` | Circle (submodule) plus the fixes in `patches/circle/`, applied by `tools/build.sh`. Its LVGL submodule supplies the LVGL sources. |
| `third_party/quickjs/` | QuickJS (submodule, unmodified). |
| `lib/lvgl/` | Builds LVGL with `zg_lv_conf.h`. |
| `lib/quickjs/` | Builds the QuickJS engine; compat headers. |
| `lib/fatfs/` | Builds Circle's FatFs read-only (`ffconf.h`). |
| `src/` | Kernel and runtime. `src/generated/` is build output. |
| `tests/` | QEMU scenarios; `tests/apps/` holds test-only apps (`make TEST=1`); `tests/sdcard/` the test SD card; `tests/native`, `tests/dice39` host tests. |
| `tools/` | App bundler, QEMU harness, test runner. |
| `docs/` | This file, the API reference and the app guide. |
