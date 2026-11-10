# Contributing to GapKeep

Thank you for helping. Start with [README.md](README.md) to build and run
it, [AGENTS.md](AGENTS.md) for working on GapKeep itself, and
[docs/AGENTS.md](docs/AGENTS.md) for writing an app (it is written for AI
coding agents, and is just as useful to people). The reasons behind the
main choices are in [docs/DESIGN.md](docs/DESIGN.md).

Security problems: not in a public issue, please; see [SECURITY.md](SECURITY.md).

## The rules

- **The API is described once,** in `docs/api/gapkeep-api.yaml`. Change it
  together with the runtime, then run `python3 tools/gen_api.py` (it writes
  `docs/API.md` and `sim/web/types/gapkeep.d.ts`: never edit those by hand)
  and `python3 tools/check_api.py`.
- **Run the tests:** `tools/run_sim_tests.sh` for every change, and
  `tools/run_tests.sh` (QEMU) too for anything the kernel builds or runs:
  the runtime, the kernel, Circle's patches.
- **Never log secrets:** no seed, key, share or password, not even in a
  test. The log goes to the serial port in test builds.
- **Apps work with the keyboard alone:** every action reachable with Tab,
  Shift+Tab, arrows, Enter and Space; no mouse is guaranteed.
- **Apps import only their own files.** A library shared between apps has
  one home and is copied byte for byte by `tools/share_libs.py`; copies are
  never edited by hand, and neither is vendored code (`vendor/`).
- New files carry `SPDX-License-Identifier: GPL-3.0-or-later` in their
  header comment. Contributions are under GPL-3.0-or-later
  ([LICENSE](LICENSE)).
