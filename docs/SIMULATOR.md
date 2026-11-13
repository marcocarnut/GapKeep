# The simulator

`sim/` runs GapKeep on a development machine: the same runtime as on the Pi
(`src/runtime`, the keyboard device, LVGL, QuickJS), compiled for the host,
with a folder standing in for the SD card. Apps behave as on the device:
same widgets, fonts, focus rings, checks on the card's apps, hashes, error
messages and limits. Screenshots match QEMU's pixel for pixel.

It comes in two forms:

| | Build | For |
| --- | --- | --- |
| `sim/build/gksim` | `make -C sim` (needs gcc) | Scripts, tests and agents: runs an app, takes commands on stdin, writes PNG screenshots. |
| `sim/build/web/gksim.{js,wasm}` | `make -C sim web` (needs [Emscripten](https://emscripten.org), e.g. `source ~/emsdk/emsdk_env.sh`) | The browser IDE ([IDE.md](IDE.md)), through `sim/web/gapkeep.js`. |

Add `TEST=1` for the test app set (`gksim-test`: every app in `apps/` and
`tests/apps/` built in), as with the kernel.

## Running an app

```sh
tools/gksim apps/hello                               # run; the log on stdout
tools/gksim --for 3 --shot /tmp/hello.png apps/hello # run 3 s, screenshot, exit
tools/gksim --size 1824x984 path/to/myapp            # another screen size
tools/gksim --lang pt-BR apps/clock                  # another language (or qps)
tools/gksim --data ~/keys/pgp apps/myapp             # with data/pgp on the card (gk:data)
tools/gksim path/to/card/apps/mysuite                # a suite (suite.json): starts on the launcher
```

`tools/gksim` builds the simulator if needed, copies the app folders onto a
temporary card and starts the first one. While it runs, it reads commands
on stdin, one per line:

| Command | Does |
| --- | --- |
| `key <name>` | Press and release a key. Names as QEMU's: `a`, `shift-a`, `ctrl-c`, `ret`, `tab`, `shift-tab`, `spc`, `backspace`, `esc`, `up`, `down`, `left`, `right`, `home`, `end`, `delete`, `f1`, `minus`, `dot`, ..., and `meta_l` (the Windows key: back to the launcher). |
| `keydown <name>`, `keyup` | Hold a key (it auto-repeats after 400 ms, every 80 ms, as on the device), release it. Key commands are taken even while a script runs, as the device's keyboard interrupt takes keys: `key ctrl-c` stops a script that has run half a second. Other commands wait for it to end. |
| `pointer <x> <y> <0\|1>` | The mouse at (x, y), left button up or down. |
| `wheel <notches>` | The mouse wheel where the pointer is: > 0 scrolls down, < 0 up, three lines a notch. In the browser, the wheel over the screen. |
| `shot <file.png>` | Screenshot; answers `#shot <file.png>`. |
| `launch [<id>]` | Start that app, or the launcher. |
| `camera <what>` | What the camera films: see [The camera](#the-camera). |
| `epaper <what>` | The e-paper panel (`--epaper MODEL`, or the card's `gapkeep.txt`): `plug <name> [<model>]`, `unplug`, `shot <file.png>`, `refresh-ms <ms>`. See [EPAPER.md](EPAPER.md#trying-it-without-a-panel-the-simulator). |
| `language <tag>` | The language of the apps started from now on (`pt-BR`, `qps`, `en`), as the Settings app sets it. |
| `keyboard <layout>` | The keyboard layout (`us`, `br-abnt2`), as `keyboard` in `gapkeep.txt` or the Settings app sets it. |
| `eject` | Take the SD card out: its folder is no longer read (GapKeep must not need it after boot; `tests/card_removal.txt`). |
| `usbip attach <host>:<port> [<busid>]` | Plug in the USB device a USB/IP server offers: see [USB devices](#usb-devices). |
| `usbip detach [<busid>]` | Unplug it, for good (none given: every one). |
| `quit` | Exit. |

Answers to commands start with `#`; everything else on stdout is the log,
formatted as on the device's serial port (`00:00:01.23 app:hello: ...`).

`sim/build/gksim` itself takes `--card DIR` (DIR plays the SD card: apps in
`DIR/apps`, data folders in `DIR/data`), `--builtin DIR` (below), `--app ID`, `--size WxH`, `--lang TAG` (the
language, over the card's `gapkeep.txt`; `qps` is the pseudo-language of
[APPS.md](APPS.md#languages)),
`--usbip HOST:PORT[/BUSID]` (as `usbip attach`, from the start), `--for SECONDS` and `--shot FILE`.

## The camera

The simulator has a camera that films what you tell it, for apps with
`ui.Scanner` ([CAMERA.md](CAMERA.md)). The decoder is the real one.

| Command | The camera films |
| --- | --- |
| `camera qr <text>` | A QR code of the text (UTF-8), a little turned, with noise. |
| `camera qrhex <hex>` | A QR code of these bytes. |
| `camera picture <file>` | A picture: binary PGM (`P5`) or PPM (`P6`), 8 bits. |
| `camera scene` | Nothing in particular (the default). |
| `camera none` | There is no camera: scanners report `"no camera"`. |

The log says what changed (`camera: a QR code of 14 bytes`), never what a
code holds. Scenarios use the same commands; test kernels in QEMU and on the
rig take them too.

## USB devices

Apps that use [`gk:usb`](API.md#gkusb) need a device. The simulator takes
them over [USB/IP](https://docs.kernel.org/usb/usbip_protocol.html), the
protocol Linux uses to share USB devices over a network: it is a USB/IP
client (`sim/src/usbip.cpp`), and a device a server offers is a device
plugged in. Any server will do: Linux's `usbipd` sharing a real device, or
a program that simulates one.

```sh
tools/gksim --usbip 127.0.0.1:3240 apps/myapp           # the first device it offers
tools/gksim --usbip 127.0.0.1:3240/1-1.4 apps/myapp     # that one (its bus id)
```

or, while it runs, `usbip attach 127.0.0.1:3240 1-1.4` and `usbip
detach`. It is claimed as on the Pi, if an app lists it (otherwise it
stays imported, unused: the simulator has no other driver), and gk:usb
reads its descriptors and serves the app's control transfers, with the
same checks, limits and timeouts. Only control transfers on endpoint 0 go
over USB/IP; the server has already set the device's address.

An attachment is a cable that stays plugged in. When the server drops the
device (it was unplugged, or it reset and enumerates again), the device is
detached, and the import is tried again every 300 ms until it is offered
again, maybe as another device under the same bus id; `usbip detach`
pulls the cable.

For tests, `tests/usb/usbip_stub.py` is a small USB/IP server with a fake
device (1209:0001: a HID keyboard with a feature report, a vendor
interface, requests that stall, never answer, or answer too much).
Scenarios start it with `usbip stub`, and `usbip unplug` makes it drop the
device (`tests/usb.txt`). `tests/usb_usbip_device.txt` probes a real or
simulated DigiMacro (16c0:27db) at `GK_TEST_USBIP` (default
`127.0.0.1:3241`); `tools/run_sim_tests.sh` skips it when nothing answers
there.

The browser IDE has no USB devices: a web page can't open TCP
connections, so its build has no USB/IP client, and `gk:usb.list()` is
always empty there.

## Working on the launcher

The launcher is built in: the device refuses a card app with its id. The
simulator can replace it without rebuilding: with `--builtin DIR`, a
folder `DIR/launcher` replaces the built-in launcher, with its rights, and
the log says so (`appstore: builtin/launcher replaces the built-in
launcher (simulator only)`). If the folder fails the checks, the log says
why and the built-in launcher stays. `tools/gksim` does this for a folder
named `launcher`:

```sh
tools/gksim apps/launcher apps/hello     # your launcher, with hello on the card
```

The Pi has no such folder: there, change `apps/launcher` and rebuild.

## Scenarios

The test scenarios (`tests/*.txt`, see the top of `tools/qemu_harness.py`)
run on the simulator too:

```sh
python3 tools/qemu_harness.py --sim sim/build/gksim --card DIR scenario.txt
tools/run_sim_tests.sh          # every scenario, plus the API check
```

A scenario takes seconds instead of the minute QEMU needs to boot. Those
that use the serial port (`send`: the memory-protection tests) need QEMU or
the hardware and are skipped.

## How fast is it on a Zero?

The simulator is far faster than a Pi Zero: code that takes two seconds on
the Zero finishes before you notice. So it reports how much JavaScript an
app ran, in a unit that doesn't depend on the machine (QuickJS checks for
interruption after a fixed amount of work), and what that would take on the
Zero:

```
apphost: Started dice39: modules 4 ms, promise jobs 0 ms, work 1, about 27 ms of JavaScript on a Pi Zero
apphost: Stopping dice39 (work 68, about 1888 ms of JavaScript on a Pi Zero)
```

The same app does the same work on both (68 for dice39 above, on the
simulator and on the hardware). The estimate counts JavaScript only, not
compiling modules or drawing, and is coarse (a unit is about 27 ms on the
Zero), but it flags the cases that matter: anything near a second or more
before the first screen. The device logs the work too, without the estimate.

## Differences from the device

- **Speed**, above.
- **Ctrl+C in the browser**: a script that runs on blocks the page (the
  browser delivers no keys until it returns), so in the IDE only the 10 s
  watchdog stops it. The command-line simulator takes keys meanwhile, as
  the device does.
- **No serial port**: `send` in scenarios fails; test-build serial commands
  (`#shot`, `#crash`) are unavailable.
- **USB**: the keyboard and mouse are always there; other devices come
  over USB/IP ([USB devices](#usb-devices)), with control transfers only.
- **The clock** runs on the host's timer but otherwise as on the device:
  `Date` counts from 1970 until the Clock app sets it, and `gapkeep.txt` on
  the card is read at boot ([CLOCK.md](CLOCK.md)).
- **The e-paper panel** is EPDPages' model of its controller, under the
  real driver ([EPAPER.md](EPAPER.md)); SPI transfers take no time.
- **The camera** is synthetic (above), as in test kernels; the Pi Camera's
  driver is the kernel's ([CAMERA.md](CAMERA.md#the-pi-camera)), and
  the IDE can use a webcam instead ([IDE.md](IDE.md#the-camera)).
- **No kernel image**: `sys.kernel.build` is `"simulator"` and its `hash` is
  all zeros.
- **Random numbers** come from the host (`getentropy`), through the same
  health tests as the hardware RNG's.
- **No memory protection** (W^X, stack guard): those are the kernel's, not the
  runtime's; QEMU and the hardware test them.

## How it is built

`sim/include/` holds stand-ins for the few Circle headers the runtime uses
(logger, timer, `CString`, the keyboard device, the RNG), and `ff.h`: the
read calls of FatFs on a host folder. `sim/src/sim.cpp` does what the
kernel's `Initialize` and main loop do. `kbdindev.cpp` runs unchanged: the
simulated keyboard feeds it HID reports and the strings Circle's keymap
makes, so key translation, auto-repeat and the Home key are the real code.
