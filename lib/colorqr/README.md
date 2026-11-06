# colorqr

Reads the extra data a colour QR code carries in the colours of its data
modules (FORMAT.md), on a frame where zxing-cpp has already found the code.
Used only by the scanner's experimental `"qr-color"` detector
(`src/runtime/scanner.cpp`), which needs `experimental = yes` in the card's
`zerogap.txt` (docs/EXPERIMENTAL.md).

- From the colorqr research project (not published), commit `6225fa8` (branch fast-path):
  `c/include` and `c/src`, unchanged, and `FORMAT.md`. MIT (LICENSE).
- Update: copy those again from the new commit, change the commit here, run
  `tools/fuzz_colorqr.sh` and `tools/run_sim_tests.sh`.
- zerogap carries no encoder: apps can read colour codes, never draw them.
