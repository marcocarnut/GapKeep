# JavaScript libraries for apps

Libraries written for no app in particular. Apps import only their own files
(docs/APPS.md), so an app that uses one carries a copy, made byte for byte by
`tools/share_libs.py` (add the copy to its `COPIES`); the copies are never
edited by hand. Each library is pure JavaScript with no dependencies: it runs
in zerogap's QuickJS, in Node and in browsers, and other projects (the web
wallet) copy it the same way, with its commit and SHA-256.

| Library | What | Tests |
| --- | --- | --- |
| `bbqr.js` | BBQr: a file as a series of QR codes, as Coldcard and Sparrow use for PSBTs; with its own deflate (1 KiB window) and inflate | `tests/bbqr/run_node.mjs`, `tests/bbqr/check_capacity.py` (run by `tools/run_sim_tests.sh`) |
