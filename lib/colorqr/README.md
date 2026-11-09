# colorqr

Reads the extra data a colour QR code carries in the colours of its data
modules (FORMAT.md), on a frame where zxing-cpp has already found the code.
Used only by the scanner's experimental `"qr-color"` detector
(`src/runtime/scanner.cpp`), which needs `experimental = yes` in the card's
`gapkeep.txt` (docs/EXPERIMENTAL.md).

- From the colorqr research project (not published), v1.1.1 (tag `v1.1.1`, commit `d3aae8e`):
  `c/include` and `c/src`, unchanged, and `FORMAT.md`. MIT (LICENSE).
- Update: copy those again from the new commit, change the commit here, run
  `tools/fuzz_colorqr.sh` and `tools/run_sim_tests.sh`.
- GapKeep carries no encoder: apps can read colour codes, never draw them.
