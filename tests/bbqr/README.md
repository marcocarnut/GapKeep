# Tests of lib/js/bbqr.js

- `run_node.mjs`: everything, under Node (`node --experimental-default-type=module
  tests/bbqr/run_node.mjs`); run by `tools/run_sim_tests.sh`.
- `check_capacity.py`: the QR capacity table against Python's `qrcode`.
- `real-scan.txt`: a BBQr series as a camera read it (8 parts with repeats,
  type U, encoding Z, a real zlib stream), from the BBQr project:
  https://github.com/coinkite/BBQr, `test_data/real-scan.txt` at
  8dc7ef07d0d520763cc0001a885ca8d29ac8719a, public domain (its
  UNLICENSE.md). SHA-256
  920d332fd9e3dc2dfafa560dfaa0fca071578c6a3881aa7b257c69b221045d67.
  Found by the web wallet's agent, copied as text.
