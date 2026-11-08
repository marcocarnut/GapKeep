// zg:i18n's pure parts under Node: messages, plurals, the pseudo-language,
// numbers, amounts (GapWallet's W4 cases), dates. The runtime's own module,
// src/runtime/i18n.js, with fake_native.mjs for "zg:i18n-native".
//   node --experimental-default-type=module tests/i18n/run_node.mjs
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const native = new URL("./fake_native.mjs", import.meta.url);
const source = readFileSync(new URL("../../src/runtime/i18n.js", import.meta.url), "utf8")
  .replace(`from "zg:i18n-native"`, `from ${JSON.stringify(native.href)}`);
assert.ok(source.includes(native.href), "the import of zg:i18n-native");
const dir = mkdtempSync(join(tmpdir(), "zg-i18n-"));
writeFileSync(join(dir, "i18n.mjs"), source);
const i = await import(join(dir, "i18n.mjs"));
rmSync(dir, { recursive: true });
const { config } = await import(native.href);

let passed = 0;
const failed = [];
function test(name, f) {
  try {
    f();
    passed++;
  } catch (e) {
    failed.push(`${name}: ${e.message}`);
  }
}
function inLanguage(lang, f, app = "launcher") {
  config.app = app;
  i.setLanguage(lang);
  try {
    return f();
  } finally {
    i.setMarks(null);
    i.setLanguage("en");
    config.app = "launcher";
  }
}
const error = (f) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return null;
};

test("t: names filled in, numbers the language's way", () => {
  assert.equal(i.t("{n} bytes", { n: 12345 }), "12,345 bytes");
  assert.equal(inLanguage("pt-BR", () => i.t("{n} bytes", { n: 12345.5 })), "12.345,5 bytes");
  assert.equal(i.t("A {missing} stays", {}), "A {missing} stays");
  assert.equal(i.t("{{literal}} and {x}}}", { x: 1, literal: 2 }), "{literal} and 1}");
  assert.equal(i.t("{toString}"), "{toString}");   // only the params' own
  assert.equal(i.t("Plain"), "Plain");
  assert.throws(() => i.t("{amount}", { amount: 5n }), TypeError);
  assert.throws(() => i.t(42), TypeError);
});

test("t: translations, context and fallback to English", () => {
  inLanguage("pt-BR", () => {
    assert.equal(i.t("No apps installed."), "Nenhum aplicativo instalado.");
    assert.equal(i.t("A key no catalog has"), "A key no catalog has");
    assert.equal(i.t("__proto__"), "__proto__");
    assert.equal(i.t("SD card, apps/{id}", { id: "x" }), "cartão SD, apps/x");
  });
  inLanguage("pt-BR", () => {
    assert.equal(i.t("Sun", { $context: "weekday" }), "dom");
    assert.equal(i.t("Sun"), "Sun");                      // without the context: another key
    assert.equal(i.t("Sun", { $context: "planet" }), "Sun");
  }, "clock");
});

test("plural: one for 1 only, in English and pt-BR (0 códigos)", () => {
  assert.equal(i.plural(1, "{n} app", "{n} apps"), "1 app");
  assert.equal(i.plural(0, "{n} app", "{n} apps"), "0 apps");
  assert.equal(i.plural(1234, "{n} app", "{n} apps"), "1,234 apps");
  inLanguage("pt-BR", () => {
    assert.equal(i.plural(1, "{n} app", "{n} apps"), "1 aplicativo");
    assert.equal(i.plural(0, "{n} app", "{n} apps"), "0 aplicativos");
    assert.equal(i.plural(2, "{n} app", "{n} apps"), "2 aplicativos");
  });
  assert.throws(() => i.plural(2n, "a", "b"), TypeError);
});

test("qps: accented, longer, in brackets; names kept", () => {
  inLanguage("qps", () => {
    const s = i.t("Sign this? {n}", { n: 3 });
    assert.match(s, /^\[Šîĝñ ţĥîš\? 3 ·+\]$/);
    assert.equal(s.length >= "Sign this? 3".length * 1.3, true);
    assert.equal(i.t(""), "");
    assert.equal(i.plural(1, "{n} app", "{n} apps"), "[1 åpp ··]");
  });
});

test("formatNumber", () => {
  assert.equal(i.formatNumber(1234567.5), "1,234,567.5");
  assert.equal(i.formatNumber(-1234567), "-1,234,567");
  assert.equal(i.formatNumber(0.1 + 0.2), "0.30000000000000004");
  assert.equal(i.formatNumber(1e-7), "0.0000001");
  assert.equal(i.formatNumber(1e21), "1,000,000,000,000,000,000,000");
  assert.equal(i.formatNumber(2.5, { decimals: 2 }), "2.50");
  assert.equal(i.formatNumber(-0.001, { decimals: 2 }), "0.00");
  assert.equal(i.formatNumber(-0), "0");
  assert.equal(i.formatNumber(NaN), "NaN");
  assert.equal(i.formatNumber(-12345678901234567890n), "-12,345,678,901,234,567,890");
  assert.equal(inLanguage("pt-BR", () => i.formatNumber(1234567.5)), "1.234.567,5");
  assert.throws(() => i.formatNumber(1, { decimals: 21 }), RangeError);
  assert.throws(() => i.formatNumber("1"), TypeError);
});

test("marks: the language's, or set; never the same", () => {
  assert.deepEqual(i.marks(), { decimal: ".", group: "," });
  assert.deepEqual(inLanguage("pt-BR", () => i.marks()), { decimal: ",", group: "." });
  i.setMarks({ group: "" });
  assert.equal(i.formatNumber(1234567.5), "1234567.5");
  i.setMarks({ decimal: "," });                    // English with a decimal comma: groups with dots
  assert.equal(i.formatNumber(1234567.5), "1.234.567,5");
  i.setMarks({ decimal: ".", group: "," });
  assert.throws(() => i.setMarks({ decimal: ".", group: "." }), RangeError);
  i.setMarks(null);
  assert.deepEqual(i.marks(), { decimal: ".", group: "," });
});

test("formatSats and formatBtc: integers, never floating point", () => {
  assert.equal(i.formatSats(2100000000000000), "2,100,000,000,000,000");
  assert.equal(i.formatSats(-5n), "-5");
  assert.throws(() => i.formatSats(1.5), TypeError);
  assert.throws(() => i.formatSats(2 ** 53), TypeError);
  assert.equal(i.formatBtc(123456789), "1.23456789");
  assert.equal(i.formatBtc(100000000), "1.00000000");
  assert.equal(i.formatBtc(100000000, { decimals: 2 }), "1.00");
  assert.equal(i.formatBtc(100000000, { decimals: 0 }), "1");
  assert.equal(i.formatBtc(123456789, { decimals: 2 }), "1.23456789");   // digits never hidden
  assert.equal(i.formatBtc(120000000, { decimals: 0 }), "1.2");
  assert.equal(i.formatBtc(-150000000), "-1.50000000");
  assert.equal(i.formatBtc(2099999997690000n), "20,999,999.97690000");
  assert.equal(inLanguage("pt-BR", () => i.formatBtc(2099999997690000)), "20.999.999,97690000");
  assert.equal(inLanguage("pt-BR", () => i.formatBtc(-150000000)), "-1,50000000");
  assert.throws(() => i.formatBtc(1, { decimals: 9 }), RangeError);
});

test("parseBtc: what one language could misread is refused in both (GapWallet W4)", () => {
  // [typed, en, pt-BR]: sats, or null for refused
  const cases = [
    ["1.000", 100000000, null], ["1,000", null, 100000000],
    ["0,001", 100000, 100000], ["0.001", 100000, 100000],
    ["12.500", 1250000000, null], ["12,500", null, 1250000000],
    ["1.5", 150000000, 150000000], ["1,5", 150000000, 150000000],
    ["1.0000", 100000000, 100000000],
    ["1,234.5", 123450000000, null], ["1.234,5", null, 123450000000],
    ["1,000,000", 100000000000000, null], ["1.000.000", null, 100000000000000],
    ["22.000.000", null, null], ["1.2.3", null, null], ["1,2,3", null, null],
    ["1234,567", 123456700000, 123456700000], ["1234.567", 123456700000, 123456700000],
    ["", null, null], [".", null, null], ["-1", null, null], ["1e3", null, null], [" 2 ", 200000000, 200000000],
    ["0.123456789", null, null], ["21000000", 2100000000000000, 2100000000000000], ["21000000.00000001", null, null],
  ];
  for (const [typed, en, pt] of cases) {
    for (const [lang, want] of [["en", en], ["pt-BR", pt]]) {
      const got = inLanguage(lang, () => {
        try {
          return i.parseBtc(typed);
        } catch (e) {
          assert.ok(e instanceof RangeError, `${typed}: ${e}`);
          return null;
        }
      });
      assert.equal(got, want, `${typed} in ${lang}`);
    }
  }
  assert.equal(inLanguage("pt-BR", () => i.parseBtc("1.000,000")), 100000000000);
  assert.throws(() => i.parseBtc("1.000,000"), RangeError);
  assert.equal(i.parseBtc("100,000.5"), 10000050000000);
});

test("parse errors are the system's text, translated", () => {
  assert.match(error(() => i.parseBtc("1,000")).message, /could be read two ways.*1000 or 1\.5/);
  assert.match(inLanguage("pt-BR", () => error(() => i.parseBtc("1.000")).message), /duas formas.*1000 ou 1,5/);
  assert.equal(inLanguage("pt-BR", () => error(() => i.parseBtc("x")).message), "Digite um valor em BTC, como 0,001.");
  assert.equal(inLanguage("pt-BR", () => error(() => i.parseBtc("1.123456789")).message), "Bitcoin tem no máximo 8 casas decimais.");
  // the app's own catalog doesn't matter: the clock's has none of these
  assert.equal(inLanguage("pt-BR", () => error(() => i.parseNumber("abc")).message, "clock"), "Digite um número, como 1,5.");
});

test("amounts round trip through each language's writing", () => {
  for (const lang of ["en", "pt-BR"]) {
    inLanguage(lang, () => {
      for (const n of [1, 999, 100000, 123456789, 100000000000, 2099999997690000]) {
        assert.equal(i.parseBtc(i.formatBtc(n)), n, `${n} in ${lang}`);
      }
    });
  }
});

test("parseNumber: signs, decimals, the same refusals", () => {
  assert.equal(i.parseNumber("-21.4"), -21.4);
  assert.equal(i.parseNumber("+1,5"), 1.5);
  assert.equal(i.parseNumber("0.5"), 0.5);
  assert.equal(i.parseNumber(".5"), 0.5);
  assert.equal(i.parseNumber("5."), 5);
  assert.equal(i.parseNumber("1,234,567.125"), 1234567.125);
  assert.equal(inLanguage("pt-BR", () => i.parseNumber("-21,4")), -21.4);
  assert.equal(inLanguage("pt-BR", () => i.parseNumber("1.234.567,125")), 1234567.125);
  for (const bad of ["", "-", "+-1", "1,000", "abc", "1 000", "1e3", "--1", "0x10", "Infinity"]) {
    assert.throws(() => i.parseNumber(bad), RangeError, bad);
  }
  i.setMarks({ group: "" });
  assert.throws(() => i.parseNumber("1,234.5"), /without a thousands separator/);
  assert.throws(() => i.parseNumber("1,000"), RangeError);
  assert.equal(i.parseNumber("1234.5"), 1234.5);
  i.setMarks(null);
});

test("dates: ISO 8601 with a space, in the clock's zone, or UTC", () => {
  const s = Date.UTC(2026, 10, 8, 14, 3, 5) / 1000;
  config.utcOffset = 0;
  assert.equal(i.formatDateTime(s), "2026-11-08 14:03:05");
  assert.equal(i.formatDateTime(s + 0.999), "2026-11-08 14:03:05");
  config.utcOffset = -180;
  assert.equal(i.formatDateTime(s), "2026-11-08 11:03:05");
  assert.equal(i.formatDate(s - 12 * 3600), "2026-11-07");
  assert.equal(i.formatTime(s), "11:03:05");
  assert.equal(i.formatDateTime(s, { utc: true }), "2026-11-08 14:03:05 UTC");
  assert.equal(i.formatDate(s, { utc: true }), "2026-11-08 UTC");
  assert.equal(inLanguage("pt-BR", () => i.formatDateTime(0, { utc: true })), "1970-01-01 00:00:00 UTC");
  config.utcOffset = 0;
  assert.throws(() => i.formatDate(NaN), TypeError);
  assert.throws(() => i.formatDate(1e20), RangeError);
});

test("settings: readers, onLanguageChange", () => {
  assert.equal(i.language(), "en");
  assert.equal(i.keyboard(), "us");
  assert.deepEqual(i.keyboards(), ["us"]);
  assert.equal(i.languages()[1].name, "Português (Brasil)");
  const seen = [];
  const off = i.onLanguageChange((ev) => seen.push(`${ev.language} ${ev.marks.decimal}`));
  i.setLanguage("pt-BR");
  i.setMarks({ decimal: "." });
  off();
  i.setMarks(null);
  i.setLanguage("en");
  assert.deepEqual(seen, ["pt-BR ,", "pt-BR ."]);
  assert.throws(() => i.setLanguage("xx"), RangeError);
  assert.throws(() => i.onLanguageChange(1), TypeError);
});

console.log(`i18n: ${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("FAIL", f);
process.exit(failed.length ? 1 : 0);
