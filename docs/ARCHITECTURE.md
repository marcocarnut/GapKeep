# GapKeep architecture

GapKeep is a single-purpose, bare-metal system for the Raspberry Pi Zero
(BCM2835, one ARM1176 core, 512 MB). It boots straight into a JavaScript app
runtime with a graphical interface. There is no Linux, no network stack and
no radio; the SD card is read once at boot, for the apps and their data, and
never written: once the launcher is up it can be removed.

```
 ┌──────────────────────────────────────────────────────────────┐
 │  apps/*            JavaScript apps (launcher, dice39, ...)   │
 ├──────────────────────────────────────────────────────────────┤
 │  src/runtime       app host · gk:ui · gk:sys · gk:apps        │
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
   (GapKeep) to 0x8000 on the ARM core.
3. Circle's startup code sets up the stack (1 MB), MMU and caches, and calls
   `main()` → `CKernel` (`src/kernel.cpp`).
4. The kernel brings up the screen, the serial log, interrupts, the timer and
   USB (keyboard and mouse are found by plug-and-play), reads the apps,
   `gapkeep.txt` and the data folders the apps list from the SD card
   (`CAppStore`) and unmounts it, then brings up LVGL, the keyboard input
   device and the app host.
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
3. The app's entry module is evaluated. It imports `gk:*` modules (created
   on demand, permission-checked) and its own files (from memory).

Stopping an app (exit, Home, or launching another) deletes its screen, which
deletes every widget and releases its JS handlers; then its timers; then its
JS context and runtime. `JS_FreeRuntime` asserts that every object was
freed, so a leak in the runtime shows up as a crash in testing rather than
slow memory loss.

Apps come from two places (`src/runtime/appstore.*`), with the same checks
and the same description (`gk_app_t`):

- **Built in**, at build time (`tools/bundle_apps.py` →
  `src/generated/apps_bundle.c`): the launcher always; every app in sealed
  and test builds.
- **The SD card's `/apps` folder**, read once at boot into memory by
  read-only FatFs (`lib/fatfs`, configured with `FF_FS_READONLY`, so no
  write code is even compiled) over Circle's SD driver. Each app is checked
  (manifest, names, UTF-8, size limits) and hashed; refused apps are listed
  in the launcher with the reason. A card app cannot take a built-in app's
  id. The data folders the apps list (`/data/<name>`) are read at the same
  time, whole, and hashed. Then the card is unmounted: every FatFs call
  goes through `GkCardGuard` (`src/runtime/cardfs.h`), which after boot
  refuses it and logs an error, so nothing can come to depend on the card
  staying in (`tests/card_removal.txt` takes it out).

After boot no code is loaded: apps cannot load code
other than their own modules, which are already in memory, and the only
files they read are the data folders their manifest names (`gk:data`,
read whole and hashed at boot, served from memory).

Apps never share code at run time: an app's hash covers every line of
JavaScript it runs, so one that builds on another's library carries a
byte-for-byte copy (`tools/share_libs.py`). Data, unlike code, is
shared by name: read-only folders on the card (`data/<name>/`, through
`gk:data`), listed in the manifest and outside the app hash. Suites
(`apps/<suite>/suite.json`) only group apps in the launcher. The reasons are in
[DESIGN.md](DESIGN.md#apps).

### Widgets (`src/runtime/js_ui.cpp`)

Each widget is a JS object linked to an LVGL object through a `TGkNode`.
While the LVGL object exists, the node keeps the JS object alive, so the same
JS object is returned every time (`label.parent === container`). LVGL's
delete event releases it. JS never deletes LVGL objects directly:
`widget.delete()` hides the widget and queues it, and the host deletes it
after event processing. That keeps "a button deletes itself in its click
handler" safe.

All properties are described by one table; constructors, `set()` and the
per-type property accessors all go through it, with strict validation.

The wall clock (`clock.cpp`, `gk:clock` in `js_clock.cpp`) is kept by the
kernel from the system timer, with a trim and a UTC offset; see
[CLOCK.md](CLOCK.md).

The session store (`session.cpp`, `gk:session` in `js_session.cpp`) keeps
values for each app across its runs, in the kernel's heap, until power-off.
Entries are filed under the app's id and hash; values are serialized by
QuickJS's object writer (plain data only: no bytecode, no references) and
copied in and out. Every byte is overwritten before it is freed.

Languages (`i18n.cpp`, `gk:i18n`): the language and number marks are the
system's (`gapkeep.txt`, or the Settings app until power-off). When an app
starts, its catalog (`lang/<language>.json`, with `lang/pt.json` under
`lang/pt-BR.json`) is parsed with `JSON.parse`, never evaluated, and each
translation checked (the same `{names}` as its key, no control or bidi
characters); what passes is kept in a null-prototype object. The module
itself is JavaScript, `src/runtime/i18n.js`, embedded by
`tools/embed_js.py` and compiled when an app imports it; its native half,
`gk:i18n-native`, can be imported by it alone. The launcher's catalogs are
the system's: they translate the module's own messages.

`ui.Scanner` is driven by `scanner.cpp` (camera frames, decoding with
`qrdecode.cpp`, the preview), polled by an LVGL timer; the camera is an
interface (`camera.h`) with a synthetic implementation (`synthcam.cpp`) for
the simulator and test builds, and a driver for the Pi Camera Module v2.1
(`src/camera/`, kernel only: the sensor over I2C, the CSI-2 receiver, grey
frames and automatic exposure). See [CAMERA.md](CAMERA.md).

### Cryptography (`src/crypto/`)

SHA-1, SHA-256 and SHA-512 written from FIPS 180-4, and HMAC from RFC 2104
(`hmac.*`, generic over the three through `gk_hash_t`), all plain C that
also builds on the development machine: `tests/native/test_sha256.c`, and
`tools/check_hashes.py`, which runs every self-test and compares thousands
of random inputs with Python's `hashlib`. SHA-256's self-test runs at boot;
HMAC's test vectors (RFC 2202, RFC 4231, which also check SHA-1 and
SHA-512) run before their first use, and disable them if they fail. Every
context and buffer that held key material is overwritten after use. The
hardware RNG wrapper (`hwrng.*`) applies NIST SP 800-90B health tests to
every raw byte and conditions output through SHA-256; see `gk:crypto` in
[API.md](API.md).

RIPEMD-160 (`ripemd160.*`, from its authors' paper, with HASH160) and
PBKDF2 (`pbkdf2.*`, RFC 8018, over `gk_hash_t`) are checked the same way
(`tools/check_hashes.py`). secp256k1 is Bitcoin Core's libsecp256k1
(`third_party/secp256k1`, pinned to a release; built by
`lib/secp256k1/secp256k1.mk` with the extrakeys and schnorrsig modules and
a 16 KiB verification table, about 100 KiB of code and tables in all).
`secp.*` turns its opaque structures into bytes for `gk:crypto`: ECDSA
with RFC 6979 nonces, low S and Bitcoin Core's low-R grinding, BIP-340,
and the BIP-32 and Taproot tweaks. Its context lives in a static buffer
(no allocation), is blinded with random bytes, and halts the system on an
illegal-argument or internal-error callback, which only a bug can reach.
`tools/check_secp.py` compares it with an independent pure-Python
implementation (SEC 1, RFC 6979, BIP-340, BIP-341) on random keys and edge
cases, runs BIP-340's test vectors, writes the known answers of the
kernel's self-test (`secp_kat.h`), and runs the library's own test suite
built as for the Zero (32-bit arithmetic); that suite also passes compiled
for ARMv6 under `qemu-arm`. RIPEMD-160, PBKDF2 and secp256k1 run their
self-tests before their first use. BIP-32, addresses and transactions are
left to apps, in JavaScript on these primitives.

### C runtime

QuickJS is a hosted C program. GapKeep provides only what it needs:

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
| USB host controller + HID parsing (Circle) | The only input from outside. Only the hub, keyboard (boot protocol) and mouse drivers are in the image; every other class driver is left out at build time (`EXCLUDE_USB_*` in `tools/build.sh`), including the generic-HID path and its report descriptor parser. The mouse driver keeps its own, smaller one: it uses the report protocol (for the wheel), so it parses the report descriptor the mouse sends. That parser is bounded, every length, index and offset checked, and a malformed descriptor gets the mouse refused (`patches/circle/0009`); it is fuzzed under AddressSanitizer and UBSan against random, mutated and crafted descriptors (`tools/fuzz_usbmouse.sh`). IN transfers receive whole packets into a bounce buffer, as Linux does, so that a device sending more than was asked for cannot have the controller write past the buffer (`0008`; on the rig, without it, a keyboard declaring 1024-byte packets had 1016 bytes written past its 8-byte report buffer, on every report); keyboards and mice declaring packets over 64 bytes are refused. Control transfers time out after 3 s (`0003`); a device whose control transfers time out twice gets no more until it is replugged, and long timeouts are budgeted across devices (3, then one a minute; beyond that 250 ms); keyboard LED requests get 100 ms, and none after a failure. So a device that never answers, or keeps reconnecting, cannot hang the system nor freeze it for long (`0010`). |
| Camera ([CAMERA.md](CAMERA.md)) | Input only: pictures of QR codes, from the Pi Camera (IMX219, `src/camera/`) or, in test builds and the simulator, a synthetic camera. Decoded in the kernel by zxing-cpp's QR code reader (C++20, about 195 KiB, `patches/zxing-cpp/`), built without exceptions: malformed codes are not read, and what zxing-cpp would throw on an internal error stops the system (a fatal error, as a failed assertion). Fuzzed under AddressSanitizer and UBSan with damaged and crafted codes that reach the payload decoder ([CAMERA.md](CAMERA.md#the-qr-decoder)). Apps get the decoded bytes, never pixels, and only with the `"camera"` permission. |
| HDMI output | Output only. CEC is ignored (`hdmi_ignore_cec` in `config.txt`). |
| Serial port (GPIO 14/15) | Production builds for the Pi contain no serial driver: the UART is never set up, its pins are made inputs, and the firmware's is off (`enable_uart=0`); the log goes nowhere. Test builds log to it and take test commands from it (`src/testshot.*`). |
| SD card | Read by the firmware at power-on (`kernel.img` comes from it, so it must be in then), then by GapKeep, once, at boot: `/apps`, `gapkeep.txt`, and the data folders (`/data/<name>`) the apps list (FAT, read-only driver). Then unmounted; any later FatFs call is refused and logged as an error. Never written; removable once the launcher is up. Sealed builds don't contain the SD code (their data, if any, is built in). |
| VideoCore firmware | Closed. Shared by every Pi OS; out of our control. Pinned by hash (`tools/firmware.sha256`). |

**Nothing is kept.** GapKeep never writes to the card, and the session
store (`gk:session`) is RAM, gone at power-off. So keys are not stored on
the device: they live elsewhere (on paper, as codex32 shares or seed words),
come in when needed, by keyboard or as QR codes shown to the camera, are
recombined in memory for the task (the Signer signs, then forgets them), and
are wiped when the app is done with them (below). Losing or stealing a
switched-off GapKeep reveals no key.

**What is absent by design:** network stack, Wi-Fi and Bluetooth (the
plain Pi Zero has no radio at all), writing to storage, file access for
apps (but reading the data folders their manifest names, below), code
loading after boot, a clock you can trust, and any way for apps
to reach each other (each app's session store is its own).

**Apps on the card** are as trustworthy as the card: whoever can write it
can replace `kernel.img` too, so loading apps from it does not move the
trust boundary. The launcher shows each app's SHA-256, to compare with a
published one. A sealed build (`tools/build.sh pi SEALED=1`) removes the SD and FAT code
from the trusted base.

**Data folders and suites**: code is inside the app hash, data
(`data/<name>/`, read with `gk:data`) is outside it, on purpose: the hash
must be the same on every card, the data differs per card
([DESIGN.md](DESIGN.md#data-is-shared-by-name) says why). So whoever can
change the card can change the data, as they can the apps, and the defence
is the same: the launcher shows each data folder's hash beside the app's,
and apps show what matters before using it (a key's fingerprint). Apps read
only the folders their hashed manifest names, never write, and the folders
are read whole, hashed and kept in memory at boot (`appstore.cpp`), so
what an app reads is what was hashed, and swapping or removing the card
afterwards changes nothing. A sealed kernel can carry its data instead
(`SEALED=1 DATA=dir`): then the kernel's hash covers it and is per person,
and the data folder's hash lets the keyring be checked on its own. Nothing in the data is executed; what parses it is FatFs and the
apps' own JavaScript. Apps in a suite share data this way but never code,
so each app's hash still covers every line it runs.

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

Every C and C++ file (Circle, LVGL, QuickJS, GapKeep) is compiled with
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
(`tools/check_reproducible.sh`); so do the release's SD card images and
zips (`tools/make_release.sh`, `tools/check_reproducible.sh --release`;
README.md, "Releases"). The running kernel shows the SHA-256 of
its own code and constants (launcher, key `i`), which is the SHA-256 of the
start of `kernel.img`, so what runs can be checked against a published
build.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/` | The apps: built in (the launcher, or all in sealed builds) or copied to the card's `/apps`. |
| `circle/` | Circle (submodule) plus the fixes in `patches/circle/`, applied by `tools/build.sh`. Its LVGL submodule supplies the LVGL sources. |
| `third_party/quickjs/` | QuickJS (submodule, unmodified). |
| `third_party/zxing-cpp/` | zxing-cpp, the QR decoder (submodule), plus the fixes in `patches/zxing-cpp/`. |
| `third_party/secp256k1/` | Bitcoin Core's libsecp256k1 (submodule, unmodified). |
| `lib/lvgl/` | Builds LVGL with `gk_lv_conf.h`. |
| `lib/quickjs/` | Builds the QuickJS engine; compat headers. |
| `lib/fatfs/` | Builds Circle's FatFs read-only (`ffconf.h`). |
| `lib/zxing/`, `lib/secp256k1/` | Build the QR decoder and libsecp256k1 for the kernel. |
| `lib/colorqr/` | The experimental colour QR decoder, vendored ([EXPERIMENTAL.md](EXPERIMENTAL.md)). |
| `lib/js/` | JavaScript libraries that apps carry copies of (`tools/share_libs.py`). |
| `patches/` | GapKeep's changes to Circle and zxing-cpp, applied at build time by `tools/apply_patches.sh`. |
| `src/` | Kernel and runtime. `src/generated/` is build output. `src/runtime/` is also compiled into the simulator. |
| `sim/` | The simulator ([SIMULATOR.md](SIMULATOR.md)): stand-ins for the Circle headers the runtime uses, its main loop, and the browser IDE (`sim/web/`). |
| `tests/` | Scenarios (QEMU, simulator, rig); `tests/apps/` holds test-only apps (test builds, `TEST=1`); `tests/sdcard/` the test SD card; `tests/native`, `tests/dice39`, `tests/signer`... host tests (Python, Node). |
| `tools/` | Build script, app bundler, QEMU harness, simulator and IDE launchers, test runners; `tools/rig/` drives the hardware test rig ([RIG.md](RIG.md)). |
| `docs/` | This file, the guides, and the API reference generated from `docs/api/gapkeep-api.yaml`. |
