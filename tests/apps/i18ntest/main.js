// gk:i18n on the device: its catalog (lang/pt-BR.json over lang/pt.json),
// where the runtime refuses some translations, each for its own reason,
// and the rest of the module, logged for tests/i18n.txt. Test builds only.
import * as ui from "gk:ui";
import * as i from "gk:i18n";
import { tm } from "gk:i18n";
import * as sys from "gk:sys";

const show = (s) => JSON.stringify(s);
const log = (what, value) => console.log(`i18ntest ${what}: ${show(value)}`);

log("language", i.language());
log("marks", i.marks());
// the manifest's name and description, through the catalog
log("name", sys.app.name);
log("description", sys.app.description);
// taken
log("Both", i.t("Both"));
log("Only in pt", i.t("Only in pt"));
log("Hello", i.t("Hello {name}", { name: "Ana" }));
log("Newline", i.t("Two\nlines"));
log("proto", i.t("__proto__"));
log("context", i.t("Open", { $context: "verb" }));
log("recolor", i.t("Colour #ff0000 text#"));
// refused: English
log("Drops", i.t("Send {amount}", { amount: "1,5" }));
log("Invents", i.t("Fee {fee}", { fee: "2" }));
log("Bidi", i.t("Pay {to}", { to: "x" }));
log("Control", i.t("Bell"));
log("Number", i.t("A number"));
log("Empty", i.t("Not translated yet"));
log("Unknown", i.t("Not in any catalog"));
// markup: tags kept (reordered) taken; dropped, added or broken refused;
// params escaped
log("markup kept", tm("Pay <tt>{address}</tt> <u>now</u>", { address: "<s>bc1q</s>" }));
log("markup dropped", tm("Send <span color='#ffb300'>{amount}</span>", { amount: "1 BTC" }));
log("markup added", tm("Just text"));
log("markup broken", tm("Keep <tt>this</tt>"));
// the rest
log("plural", [0, 1, 2].map((n) => i.plural(n, "{n} code", "{n} codes")));
log("numbers", [i.formatNumber(1234567.5), i.formatSats(2100000000000000n), i.formatBtc(123456789)]);
log("parseBtc", i.parseBtc("1.234,5"));
try {
  i.parseBtc("1.000");
} catch (e) {
  log("parseBtc error", e.message);
}
log("date", i.formatDateTime(1762610585, { utc: true }));
log("languages", i.languages());
try {
  i.setLanguage("en");
} catch (e) {
  log("setLanguage", `${e.name}: ${e.message}`);
}
try {
  await import("gk:i18n-native");
} catch (e) {
  log("native", `${e.name}: ${e.message}`);
}
new ui.Label({ text: i.t("Hello {name}", { name: "Ana" }) });
console.log("i18ntest done");
