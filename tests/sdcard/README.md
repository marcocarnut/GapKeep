The test SD card: tests/sdapps.txt boots a test build with these files on
the card. `apps/sdhello` is a valid app (with a picture icon, a module in a
subfolder, a README the loader ignores, and a macOS `._` metadata file it
skips); every
other folder must be refused, each for its own reason:

| Folder | Refused because |
| --- | --- |
| `hello` | a built-in app has that id |
| `BadName` | the folder name is not an app id |
| `badbase64` | the icon's pixels are not canonical base64 (unused bits set) |
| `badicon` | the icon's pixels are the wrong size for its width and height |
| `badjson` | manifest.json is not valid JSON |
| `badutf8` | a module is not valid UTF-8 |
| `bidi‮name` | the folder name is not an app id (and holds U+202E, a bidi control: the launcher and the log show it as `bidi?name`) |
| `noentry` | the entry module does not exist |
| `spoofbidi` | its version holds a bidi control (U+202E) |
| `spoofname` | its name holds a line break: it would put a forged `SHA-256` line under the app's name in the launcher |
| `unknownkey` | manifest.json has a key GapKeep doesn't know |
| `wrongid` | the manifest's id differs from the folder name |
| `zsuite/suite-peer` | `testsuite` has an app with that id (ids are unique across suites) |

`apps/testsuite` is a suite (docs/APPS.md, "Suites"): a `suite.json`, its
name in Brazilian Portuguese (`lang/pt-BR.json`), and two apps,
`suite-reader` and `suite-peer`, which read `data/testdata` with `gk:data`
(tests/suites.txt). `apps/zsuite` is a suite whose only app is refused, so
the launcher doesn't show it.

`data/` holds the data folders (docs/APPS.md, "Data files"):
`data/testdata` has a binary file (`key.bin`, every byte value), a text
file in a subfolder (`notes/hello.txt`), a name with `@` and a space, and a
macOS `._` file that is skipped; its hash is
`python3 tools/bundle_apps.py --data-hash tests/sdcard/data/testdata`.
`data/other` is there to be refused: no app lists it.
