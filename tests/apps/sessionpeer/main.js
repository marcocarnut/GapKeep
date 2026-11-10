// Test builds only: must see none of sessiontest's values (tests/session.txt).
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as session from "gk:session";

const keys = session.keys();
const got = session.get("record");
console.log(`sessionpeer: ${keys.length} keys, record ${got === undefined ? "absent" : "PRESENT"}, used ${session.usage().used}`);
new ui.Label({ text: "sessionpeer" });
