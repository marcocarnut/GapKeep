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
  loader and the SD card reader, `gapkeep.txt`. A tampered card under a
  genuine kernel is in scope: everything the genuine kernel parses from
  the card (the FAT file system, manifests, `suite.json`, catalogs, icons,
  data folders, `gapkeep.txt`) must be memory-safe on any input, and must
  not be able to make the launcher show a forged hash (an app's name that
  draws a fake "SHA-256" line, say).
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
- Whoever can write the SD card can replace `kernel.img`, and a
  replaced kernel can show any hash it likes: the hashes the device shows
  (its own, the apps', the data folders') identify an honest kernel and
  catch build and copying mistakes, but cannot catch a malicious kernel.
  Against a card that may have been changed, the defence is to check the
  card itself on a trusted computer (`sha256sum kernel.img`; every file
  against the `SHA256SUMS` that `tools/make_sdcard.sh` printed when the
  card was made, not the copy on the card; `tools/bundle_apps.py --hash`
  for apps), or to use
  a sealed build you built or checked yourself
  ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model)). A
  genuine kernel that can be made to misbehave by what is on the card
  *is* a vulnerability (above).
- Physical attacks on a running device (probing its RAM, its bus or its
  power): a Pi Zero has no memory encryption.
- The closed VideoCore firmware, which every Pi system shares.
- The simulator and the browser IDE (`sim/`): development tools, not meant
  for secrets.
