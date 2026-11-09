// Checks ui.Scanner's rules: "detect" is required and checked, the camera
// is one scanner's at a time, stop/start, and that a QR code arrives as a
// "detect" event of kind "qr". Logs "scantest: ok <name>" or
// "scantest: FAIL <name>: ..." for each check, then "scantest done: N failed".
// tests/scantest.txt drives the camera.
import * as ui from "gk:ui";
import * as sys from "gk:sys";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`scantest: ok ${name}`);
  } catch (e) {
    failed++;
    console.log(`scantest: FAIL ${name}: ${e && e.message ? e.message : e}`);
  }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn, pattern, what) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof TypeError)) throw new Error(`${what}: not a TypeError: ${e}`);
    if (pattern && !pattern.test(e.message)) throw new Error(`${what}: message ${JSON.stringify(e.message)}`);
    return;
  }
  throw new Error(`${what}: did not throw`);
}

check("detect is required", () => throws(() => new ui.Scanner({}), /"detect" is required/, "no detect"));
check("unknown detector", () => throws(() => new ui.Scanner({ detect: ["qr", "aruco"] }), /unknown detector "aruco" \(this system has "qr"(, "qr-color")?\)/, "aruco"));
check("detect must be a list", () => throws(() => new ui.Scanner({ detect: "qr" }), /list of detectors/, "string"));
check("no code events on other widgets", () => throws(() => new ui.Label({ onDetect: () => {} }), /no property/, "Label"));

const first = new ui.Scanner({ detect: ["qr"], width: 160, height: 120 });
check("detect reads back", () => eq(first.detect, ["qr"], "detect"));
check("scanning", () => eq(first.scanning, true, "scanning"));
check("detect may be emptied", () => {
  first.detect = [];
  eq(first.detect, [], "detect");
  first.detect = ["qr", "qr"];
  eq(first.detect, ["qr"], "detect");
});

check("field", () => {
  eq(first.field, "center", "default");
  first.field = "full";
  eq(first.field, "full", "full");
  eq(first.scanning, true, "still scanning after the restart");
  first.field = "center";
  eq(first.field, "center", "center");
  throws(() => (first.field = "wide"), /"center" or "full"/, "bad field");
});

// a second scanner: the camera is taken
const second = new ui.Scanner({
  detect: ["qr"], width: 160, height: 120,
  onError: ({ type, reason, target }) => {
    check("second scanner: error event", () => {
      eq(type, "error", "type");
      eq(reason, "the camera is in use by another scanner", "reason");
      eq(target === second, true, "target");
      eq(second.scanning, false, "scanning");
    });
    // hand the camera over
    first.stop ();
    check("stop", () => eq(first.scanning, false, "first.scanning"));
    second.start ();
    check("start", () => eq(second.scanning, true, "second.scanning"));
    console.log("scantest ready");
  },
  onDetect: (ev) => {
    check("detect event", () => {
      eq(ev.type, "detect", "type");
      eq(ev.kind, "qr", "kind");
      eq(ev.bytes instanceof Uint8Array, true, "bytes");
      eq(ev.target === second, true, "target");
    });
    if (ev.text === null) {
      check("binary code", () => eq(Array.from (ev.bytes), [0, 255, 0xc3, 0x28], "bytes"));
      console.log(`scantest done: ${failed} failed`);
    } else {
      check("text code", () => eq(ev.text, "zerogap \u{1F3B2}", "text"));
      console.log("scantest: text ok");
    }
  },
});

new ui.Button({ text: "Back", onClick: () => sys.exit() }).focus();
