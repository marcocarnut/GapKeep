// A test app that lives on the SD card (tests/sdcard), not in the kernel.
import * as ui from "gk:ui";
import * as sys from "gk:sys";
import { greeting } from "./lib/greet.js";

new ui.Label({ text: greeting(), font: 28 });
// its own picture icon (manifest.json), as the launcher shows it, and twice the size
const row = new ui.Container({ layout: "row", gap: 16, alignItems: "center" });
new ui.Image(row, { src: sys.app.image });
new ui.Image(row, { src: sys.app.image, width: 64, height: 64 });
console.log("sdhello ready:", greeting(), sys.app.source, sys.app.hash,
  "icon", sys.app.image.width + "x" + sys.app.image.height);
