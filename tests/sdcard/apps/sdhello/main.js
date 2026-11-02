// A test app that lives on the SD card (tests/sdcard), not in the kernel.
import * as ui from "zg:ui";
import * as sys from "zg:sys";
import { greeting } from "./lib/greet.js";

new ui.Label({ text: greeting(), font: 28 });
console.log("sdhello ready:", greeting(), sys.app.source, sys.app.hash);
