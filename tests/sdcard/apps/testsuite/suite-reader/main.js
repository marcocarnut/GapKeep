// A test app of the test suite (tests/sdcard/apps/testsuite): reads the
// card's data/testdata with gk:data (tests/suites.txt). One button per
// file: Enter reads it, as text if it is UTF-8, else as bytes. At start it
// tries what must be refused, and logs each refusal. It logs sizes and
// hashes, never what the files hold.
import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as data from "gk:data";
import { sha256 } from "gk:crypto";

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

console.log("suite-reader app: suite " + sys.app.suite + ", data " + sys.app.data.join(" "));

// what must be refused, each with a TypeError that says why
const refusals = [
  ["not in the manifest", () => data.list("other")],
  ["not a folder name", () => data.list("../other")],
  ["parent path", () => data.read("testdata", "../other/secret.txt")],
  ["parent inside", () => data.read("testdata", "notes/../../other/secret.txt")],
  ["absolute path", () => data.read("testdata", "/key.bin")],
  ["backslash", () => data.read("testdata", "notes\\hello.txt")],
  ["missing file", () => data.read("testdata", "nothere.txt")],
  ["dotfile", () => data.read("testdata", "._key.bin")],
  ["binary as text", () => data.readText("testdata", "key.bin")],
  ["no folder", () => data.read("absent", "x.txt")],
];
for (const [what, fn] of refusals) {
  try {
    fn();
    console.log("suite-reader NOT refused: " + what);
  } catch (e) {
    console.log("suite-reader refused " + what + ": " + e.name + ": " + e.message);
  }
}

// a folder that is not on the card: no files, no hash
console.log("suite-reader absent: " + JSON.stringify(data.list("absent")) + " " + data.hash("absent"));

const files = data.list("testdata");
const hash = data.hash("testdata");
console.log("suite-reader list: " + files.map((f) => f.name + " " + f.size).join(", "));
console.log("suite-reader hash: " + hash);

new ui.Label({ text: "data/testdata", font: 20 });
new ui.Label({ text: "SHA-256 " + hash, font: 12, width: "100%" });
const result = new ui.Label({ text: "Enter reads a file.", font: 14, width: "100%" });
const buttons = files.map((f) => new ui.Button({
  text: f.name + " (" + f.size + " bytes)",
  onClick: () => {
    const bytes = data.read("testdata", f.name);
    let kind = "binary";
    try {
      const text = data.readText("testdata", f.name);
      kind = "text, " + text.length + " characters";
    } catch (e) {
      // not UTF-8: bytes only
    }
    const digest = hex(sha256(bytes));
    result.text = f.name + ": " + bytes.length + " bytes, " + kind + "\nSHA-256 " + digest;
    console.log("suite-reader read " + f.name + ": " + bytes.length + " bytes, " + kind + ", sha256 " + digest);
  },
}));
if (buttons.length) buttons[0].focus();
console.log("suite-reader ready");
