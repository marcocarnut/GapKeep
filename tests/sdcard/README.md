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
| `noentry` | the entry module does not exist |
| `unknownkey` | manifest.json has a key GapKeep doesn't know |
| `wrongid` | the manifest's id differs from the folder name |
