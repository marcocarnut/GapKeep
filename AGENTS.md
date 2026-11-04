# Notes for coding agents

**Writing an app?** Read [docs/AGENTS.md](docs/AGENTS.md): what an app is,
the API, and how to run it and see its screen with the simulator
(`tools/zgsim`).

**Working on zerogap itself?**

- The JavaScript API is described once, in `docs/api/zerogap-api.yaml`.
  Change the runtime and that file together, then run
  `python3 tools/gen_api.py` (writes `docs/API.md` and
  `sim/web/types/zerogap.d.ts`; never edit those by hand) and
  `python3 tools/check_api.py` (compares the description with the runtime).
- `src/runtime/` is shared by the Pi kernel and the simulator (`sim/`):
  keep Circle-specific code out of it, or behind the stand-ins in
  `sim/include/`.
- The launcher (`apps/launcher`) is built in; `tools/zgsim apps/launcher`
  runs your copy of it in the simulator without rebuilding
  (docs/SIMULATOR.md, "Working on the launcher").
- Tests: `tools/run_sim_tests.sh` (seconds), `tools/run_tests.sh` (QEMU,
  minutes), `tools/rig/run_hw_tests.sh` (a real Pi Zero, see docs/RIG.md).
- Never log seed material or other secrets: the log goes to the serial port
  in test builds.
