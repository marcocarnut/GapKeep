// The test suite's second app (tests/sdcard/apps/testsuite): the same data
// folder as suite-reader, so the same hash.
import * as ui from "gk:ui";
import * as data from "gk:data";

const hash = data.hash("testdata");
new ui.Label({ text: "data/testdata", font: 20 });
new ui.Label({ text: "SHA-256 " + hash, font: 12, width: "100%" });
const done = new ui.Button({ text: "Done", onClick: () => console.log("suite-peer done") });
done.focus();
console.log("suite-peer ready: hash " + hash);
