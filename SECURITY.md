# Security

GapKeep is meant to handle secrets, so a security problem in it matters more
than most bugs. Thank you for reporting one.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: on
[github.com/marcocarnut/GapKeep](https://github.com/marcocarnut/GapKeep),
the **Security** tab, then **Report a vulnerability**. Please never report
a vulnerability in a public issue, pull request or discussion.

Say what is affected (the commit or release, and whether it is a production,
sealed or test build), what an attacker needs (a USB device, a QR code shown
to the camera, a changed SD card...), and how to reproduce it, if you can.

You will get a first reply within 7 days. An encrypted email channel will
come in a later release.

## In scope

- The kernel (`src/`) and Circle as GapKeep configures and patches it
  (`patches/circle/`): USB, keyboard and mouse handling, memory protection.
- The runtime (`src/runtime/`): the app host, the `gk:*` modules, the app
  loader and the SD card reader, `gapkeep.txt`.
- The QR decoder (zxing-cpp as patched in `patches/zxing-cpp/`, and
  `src/runtime/qrdecode.cpp`) and the experimental colour QR decoder
  (`lib/colorqr`).
- The camera driver (`src/camera/`).
- The apps in `apps/`, the Signer above all: anything that could sign
  something the person did not see, leak a key or a seed, or show a wrong
  amount, address or change.
- The build: anything that makes a published build differ from what its
  commit says (`tools/build.sh`, `tools/check_reproducible.sh`).

## Not a vulnerability

- **Test builds log to the serial port**, and take commands from it, by
  design: that is how they are tested on QEMU and on real hardware. Never
  use a test build (`TEST=1`) with real secrets. Production builds have no
  serial driver and never read the serial port. (An app logging a secret,
  in any build, is a bug: please report it.)
- Whoever can write the SD card can replace `kernel.img` and every app on
  it; the launcher shows each app's hash, and the kernel its own, to be
  compared with published ones ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model)).
- Physical attacks on a running device (probing its RAM, its bus or its
  power): a Pi Zero has no memory encryption.
- The closed VideoCore firmware, which every Pi system shares.
- The simulator and the browser IDE (`sim/`): development tools, not meant
  for secrets.
