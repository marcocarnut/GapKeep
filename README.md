# GapKeep

**A tiny bare-metal OS for air-gapped apps.**

GapKeep is a tiny bare-metal system for the Raspberry Pi Zero (the plain one,
with no radio). It boots in about two seconds into a graphical app launcher.
Apps are written in JavaScript and run on [QuickJS](https://bellard.org/quickjs/),
with an [LVGL](https://lvgl.io) interface driven by a USB keyboard and mouse.
There is no Linux, no network stack and no radio, and the SD card is only
ever read: a computer for creating and handling secrets that have no way out
except what you read off the screen.

GapKeep keeps nothing. It never writes to the SD card, and what an app holds
is gone at power-off. Keys are not stored on the device: they live
elsewhere, on paper, for example as [codex32](https://github.com/bitcoin/bips/blob/master/bip-0093.mediawiki)
shares (which dice39 makes), and are brought in only when needed (typed,
or shown to the camera as QR codes), recombined in memory for the task at
hand, and forgotten afterwards. What leaves is only what is on the screen:
text to read, and QR codes for another device's camera.

Built on [Circle](https://github.com/rsta2/circle) (bare-metal C++ for the
Pi). Licensed under the GPLv3 (GapKeep's own sources say GPL-3.0-or-later).
The QR decoder,
[zxing-cpp](https://github.com/zxing-cpp/zxing-cpp), is under the Apache
License 2.0 (`third_party/zxing-cpp/LICENSE`, and `LICENCE.zxing-cpp` on
the cards `tools/make_sdcard.sh` makes); Bitcoin Core's
[libsecp256k1](https://github.com/bitcoin-core/secp256k1), under the MIT
licence (`LICENCE.secp256k1` on the cards), as is the experimental colour QR
decoder, `lib/colorqr` (`LICENCE.colorqr` on the cards). The fonts,
[Montserrat](https://github.com/JulietaUla/Montserrat),
[Font Awesome Free](https://fontawesome.com)'s icons and
[JetBrains Mono](https://www.jetbrains.com/lp/mono/), are under the SIL
Open Font License (`LICENCE.montserrat`, `LICENCE.fontawesome` and
`LICENCE.jetbrainsmono` on the cards; `tools/make_fonts.py` makes them).
The code that `apps/dice39`, `apps/codex32` and `apps/signer` copy from
[dice39](https://github.com/marcocarnut/dice39) (their `vendor/` folders) is
under the GNU AGPL v3 (`LICENSE-dice39.txt` in each). The Pi's boot firmware
is Broadcom's, closed, and redistributable under `LICENCE.broadcom` (on the
cards).

```js
import * as ui from "gk:ui";

const label = new ui.Label({ text: "Hello, air gap!", font: 28 });
new ui.Button({ text: "Click", onClick: () => (label.text = "Clicked!") });
```

## Documentation

- [Writing apps](docs/APPS.md): start here.
- [API reference](docs/API.md): `gk:ui`, `gk:sys`, `gk:crypto`, `gk:clock`, `gk:session`, `gk:i18n`, `gk:apps`, globals.
  Generated from [docs/api/gapkeep-api.yaml](docs/api/gapkeep-api.yaml), which a
  test checks against the runtime.
- [Simulator](docs/SIMULATOR.md): run apps on your machine, in seconds.
- [Browser IDE](docs/IDE.md): edit and run apps in the browser.
- [The clock](docs/CLOCK.md): keeping time without a real-time clock; `gk:clock`.
- [The camera and QR codes](docs/CAMERA.md): `ui.Scanner`, and testing it without a camera.
- [Guide for coding agents](docs/AGENTS.md): writing apps with an AI agent.
- [Architecture and security model](docs/ARCHITECTURE.md)
- [Hardware test rig](docs/RIG.md)

## Building

Needs an x86_64 Linux machine with `git`, `make`, `curl`,
`qemu-system-arm` (tested 8.2.2), Python 3, Pillow for PNG screenshots, and
`mtools` and `dosfstools` for SD card images. `tools/toolchain.sh` fetches
the pinned compiler (Arm GNU Toolchain 13.2.Rel1, checked by SHA-256) into
`toolchain/`; without it, `arm-none-eabi-gcc` from the PATH is used, but
builds are then not reproducible.

For the rest:

| For | Needs |
| --- | --- |
| The simulator (`tools/gksim`) | `gcc` and `g++` for the host, with C++20 support (zxing-cpp) |
| The tests (`tools/run_sim_tests.sh`, `tools/run_tests.sh`) | Node.js 18.19 or later; Python's PyYAML, Pillow and `qrcode`; `zbarimg` (Debian: `nodejs python3-yaml python3-pil python3-qrcode zbar-tools`) |
| The browser IDE (`tools/gkide.sh`) | [Emscripten](https://emscripten.org) (emsdk, found in `~/emsdk` or through `$EMSDK`) |
| SD cards (`tools/make_sdcard.sh`) | network access once: Circle's `boot/Makefile` downloads the Pi firmware, then checked against `tools/firmware.sha256` |
| Regenerating the fonts (`tools/make_fonts.py`, rarely) | `lv_font_conv` 1.5.3 and fontTools; the fonts' zips (see the script) |

The network is needed only to fetch: the submodules, the compiler, the Pi
firmware and the IDE's Monaco editor (`tools/fetch_monaco.sh`, checked
against a pinned hash). Nothing in the build or the tests talks to a
network after that.

```sh
git submodule update --init                              # Circle, QuickJS, zxing-cpp, libsecp256k1
git -C circle submodule update --init --depth 1 addon/lvgl/lvgl   # LVGL 9.4
tools/toolchain.sh                                       # the pinned compiler

tools/build.sh qemu          # -> src/kernel.img for QEMU
tools/build.sh pi            # -> src/kernel.img for a real Pi Zero
tools/build.sh pi TEST=1     # ... with the test-only apps and serial screenshots
tools/build.sh pi SEALED=1   # ... with every app built in and no SD card code
```

`build.sh` applies GapKeep's changes to Circle and zxing-cpp (`patches/`),
configures Circle for the target (QEMU lacks a few peripherals, so the two
need different Circle libraries) and builds Circle, LVGL, QuickJS, the QR
decoder (zxing-cpp, [docs/CAMERA.md](docs/CAMERA.md#the-qr-decoder)) and the
kernel. zxing-cpp's own submodule (zint, for writing barcodes) is not needed.
Switching targets rebuilds everything (about 40 s); otherwise builds are
incremental. Builds are reproducible: `tools/check_reproducible.sh` builds
the current commit twice, in fresh checkouts, and compares the images. GapKeep needs Circle's 8 MB kernel limit and a 1 MB stack, which
`build.sh` sets.

Normal builds have only the launcher built in; the other apps are read from
the SD card's `apps` folder at boot ([docs/APPS.md](docs/APPS.md#installing-apps)).
Sealed builds have every app in `apps/` built in. Test builds have those plus
the test-only apps in `tests/apps/`, listed after the real ones, and read
the card too.

## Running in the simulator

```sh
tools/gksim apps/dice39                     # an app on your machine (sim/, gcc)
tools/run_sim_tests.sh                      # the scenarios on the simulator, plus the API check
```

The simulator is GapKeep's runtime compiled for the host, natively or as
WebAssembly for the browser IDE: see [docs/SIMULATOR.md](docs/SIMULATOR.md).

## Running and testing in QEMU

```sh
tools/build.sh qemu                                         # the kernel for QEMU
python3 tools/qemu_harness.py --interactive                 # boot it, print the serial log (no card: the launcher only)
python3 tools/qemu_harness.py --sd card.img --interactive   # ... with an SD card image (below)
tools/run_tests.sh                              # everything: QEMU scenarios, QuickJS's
                                                # own tests on the target, native and Node tests
```

The harness boots the kernel on QEMU's Pi Zero model with a USB keyboard and
mouse, and an SD card image made by `tools/make_sd_image.sh <image> <dir>`
(`<dir>/apps` holds the apps; [docs/APPS.md](docs/APPS.md#your-first-app)). It can type, click, take screenshots and wait for log lines, so most
development and testing needs no hardware.

## Running on a Pi Zero

`tools/make_sdcard.sh --standalone` builds GapKeep for the Pi Zero and puts
everything the card needs in `sdcard-standalone/`: the Pi firmware,
`config.txt`, `kernel.img` and the `apps` folder. Copy all of it to the root
of a FAT32 card. Add or remove apps by changing `apps` on the card.
`--sealed` makes `sdcard-sealed/` instead, with every app inside
`kernel.img`. The settings file at the top of the card is `gapkeep.txt`
([docs/CLOCK.md](docs/CLOCK.md)); on a card from before the rename from
ZeroGap, rename `zerogap.txt` to `gapkeep.txt`.
Production builds leave the serial port (GPIO 14/15) alone: there is no log.
Test builds (`tools/build.sh pi TEST=1`) log to it at 921600 baud.

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
- [x] Step 2: QuickJS app runtime, `gk:ui` widget API, launcher, docs, tests
- [x] Step 3: native SHA-256 and a health-checked hardware RNG, with test vectors (`gk:crypto`)
- [x] Step 4: dice39 logic extracted verbatim (`tools/extract_dice39.py`) and checked: BIP-39 and BIP-93 test vectors, under Node and on the target
- [x] Step 5: dice39 user interface: dice-code entry, results with verbatim proof, mistake detectors, SeedQR / Compact SeedQR / words QR, codex32 shares
- [x] Real hardware: every scenario passes on a Pi Zero (v1.3, 512 MB) through the rig ([docs/RIG.md](docs/RIG.md))
- [x] Apps from the SD card's `apps` folder, checked and hashed at boot; sealed builds with every app built in
- [x] Simulator (native and WebAssembly) running the same runtime, a browser IDE, an API description checked against the runtime, and a guide for coding agents
- [x] Step 6: hardening: USB drivers cut to hub, keyboard and mouse, with control-transfer timeouts; no serial port in production; W^X memory protection, stack canaries and a stack guard; reproducible builds with a pinned compiler and firmware; the kernel's hash on screen ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model))
- [x] Clock with trim and UTC offset (`gk:clock`), the Clock and Authenticator (TOTP) apps
- [x] Native SHA-1, SHA-512 and HMAC (`gk:crypto`); a per-app session store in RAM (`gk:session`)
- [x] Bitcoin's primitives in `gk:crypto`: RIPEMD-160, HASH160, PBKDF2, and secp256k1 (libsecp256k1: ECDSA, BIP-340 Schnorr, the BIP-32 and Taproot key tweaks)
- [x] The Signer (`apps/signer`): BIP-174/370 PSBTs from Electrum's QR codes, explained; the transaction first, then the keys (codex32 shares, BIP-39 words, xprv, WIF); merges PSBTs; checks change
- [x] QR codes from a camera (`ui.Scanner`): zxing-cpp's decoder, patched and fuzzed; a clean-room driver for the Pi Camera Module v2.1 ([docs/CAMERA.md](docs/CAMERA.md)); a synthetic camera for the simulator, the IDE and test builds
- [x] Languages (`gk:i18n`): English and Brazilian Portuguese, a pseudo-language for testing, the Settings app
- [ ] Experimental: colour QR codes (`"qr-color"`, `apps/colorqr`, [docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md)): read on the simulator, QEMU and a Pi Zero, with the synthetic camera and the Pi Camera; still being researched

## Layout

| Path | What |
| --- | --- |
| `apps/` | The apps: `launcher` (built in), `dice39`, `codex32` (recombines codex32 shares, as dice39 makes them), `hello`, `gallery` (all widgets plus a runtime self-test), `qrscan`, `settings` (language, number marks and keyboard, until power-off), `clock`, `totp` (Authenticator), `repl` (type JavaScript and see what it does, widgets included), `signer` (shows what a transaction does, then signs it with keys from codex32 shares, seed words, an xprv or a WIF), `colorqr` (experimental: colour QR codes, [docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md)). Apps that build on another's library carry a copy, made by `tools/share_libs.py`. |
| `src/` | Kernel (`kernel.*`, `kbdindev.*`) and runtime (`runtime/`). |
| `lib/` | Builds of LVGL (with `gk_lv_conf.h`), QuickJS (with compat headers), zxing-cpp's QR code reader, libsecp256k1 and read-only FatFs; `lib/colorqr`, the colour QR decoder, vendored (not a submodule: its project is not published); `lib/js`, JavaScript libraries that apps copy ([lib/js/README.md](lib/js/README.md)). |
| `circle/`, `third_party/quickjs/`, `third_party/zxing-cpp/`, `third_party/secp256k1/` | Pinned submodules. Circle and zxing-cpp get GapKeep's changes in `patches/`. |
| `sim/` | The simulator: the runtime on a host, natively or in the browser, and the browser IDE (`sim/web/`). |
| `patches/` | GapKeep's changes to Circle and zxing-cpp, applied by `tools/apply_patches.sh` at build time. |
| `tests/` | Scenarios (QEMU, hardware, simulator), test-only apps and the test SD card. |
| `tools/` | Build script, app bundler, QEMU harness, test runner; `tools/rig/` drives real hardware. |
| `docs/` | Guides and reference; `docs/api/` holds the API description. |
