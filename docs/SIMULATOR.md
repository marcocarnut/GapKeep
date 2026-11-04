# The simulator

`sim/` runs zerogap on a development machine: the same runtime as on the Pi
(`src/runtime`, the keyboard device, LVGL, QuickJS), compiled for the host,
with a folder standing in for the SD card. Apps behave as on the device:
same widgets, fonts, focus rings, checks on the card's apps, hashes, error
messages and limits. Screenshots match QEMU's pixel for pixel.

It comes in two forms:

| | Build | For |
| --- | --- | --- |
| `sim/build/zgsim` | `make -C sim` (needs gcc) | Scripts, tests and agents: runs an app, takes commands on stdin, writes PNG screenshots. |
| `sim/build/web/zgsim.{js,wasm}` | `make -C sim web` (needs [Emscripten](https://emscripten.org), e.g. `source ~/emsdk/emsdk_env.sh`) | The browser IDE ([IDE.md](IDE.md)), through `sim/web/zerogap.js`. |

Add `TEST=1` for the test app set (`zgsim-test`: every app in `apps/` and
`tests/apps/` built in), as with the kernel.

## Running an app

```sh
tools/zgsim apps/hello                               # run; the log on stdout
tools/zgsim --for 3 --shot /tmp/hello.png apps/hello # run 3 s, screenshot, exit
tools/zgsim --size 1824x984 path/to/myapp            # another screen size
```

`tools/zgsim` builds the simulator if needed, copies the app folders onto a
temporary card and starts the first one. While it runs, it reads commands
on stdin, one per line:

| Command | Does |
| --- | --- |
| `key <name>` | Press and release a key. Names as QEMU's: `a`, `shift-a`, `ctrl-c`, `ret`, `tab`, `shift-tab`, `spc`, `backspace`, `esc`, `up`, `down`, `left`, `right`, `home`, `end`, `delete`, `f1`, `minus`, `dot`, ..., and `meta_l` (the Windows key: back to the launcher). |
| `keydown <name>`, `keyup` | Hold a key (it auto-repeats after 400 ms, every 80 ms, as on the device), release it. |
| `pointer <x> <y> <0\|1>` | The mouse at (x, y), left button up or down. |
| `shot <file.png>` | Screenshot; answers `#shot <file.png>`. |
| `launch [<id>]` | Start that app, or the launcher. |
| `quit` | Exit. |

Answers to commands start with `#`; everything else on stdout is the log,
formatted as on the device's serial port (`00:00:01.23 app:hello: ...`).

`sim/build/zgsim` itself takes `--card DIR` (DIR plays the SD card: apps in
`DIR/apps`), `--builtin DIR` (below), `--app ID`, `--size WxH`,
`--for SECONDS` and `--shot FILE`.

## Working on the launcher

The launcher is built in: the device refuses a card app with its id. The
simulator can replace it without rebuilding: with `--builtin DIR`, a
folder `DIR/launcher` replaces the built-in launcher, with its rights, and
the log says so (`appstore: builtin/launcher replaces the built-in
launcher (simulator only)`). If the folder fails the checks, the log says
why and the built-in launcher stays. `tools/zgsim` does this for a folder
named `launcher`:

```sh
tools/zgsim apps/launcher apps/hello     # your launcher, with hello on the card
```

The Pi has no such folder: there, change `apps/launcher` and rebuild.

## Scenarios

The test scenarios (`tests/*.txt`, see the top of `tools/qemu_harness.py`)
run on the simulator too:

```sh
python3 tools/qemu_harness.py --sim sim/build/zgsim --card DIR scenario.txt
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
- **No serial port**: `send` in scenarios fails; test-build serial commands
  (`#shot`, `#crash`) are unavailable.
- **No USB events**: the keyboard and mouse are always there.
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
