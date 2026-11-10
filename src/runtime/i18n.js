// gk:i18n: an app's text in the person's language, and numbers, amounts and
// dates written the same way on every build (QuickJS has no Intl).
//
// The English text is the key, written where it is used:
//
//   t("Signed {n} of {total} inputs.", { n, total })
//   plural(count, "{n} code", "{n} codes")
//
// The translations are the app's lang/<language>.json, loaded and checked by
// the runtime when the app starts (src/runtime/i18n.cpp): a translation with
// other {names} than its key, or a control or bidi character, never gets
// here. This module only looks them up. The runtime's own text (the messages
// below) is translated by the launcher's catalog, apps/launcher/lang/.
//
// docs/DESIGN.md has the design; docs/API.md ("gk:i18n") the reference.
// The pure parts are tested under Node (tests/i18n/run_node.mjs), with a
// stand-in for "gk:i18n-native", which only this module may import.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as host from "gk:i18n-native";

let state = host.state();		// { language, decimal, group, keyboard }
let messages = host.messages();		// the app's catalog: key -> text, or null
let system;				// the launcher's, when first needed
const handlers = [];

function refresh() {
  state = host.state();
  messages = host.messages();
  system = undefined;
}

// --- messages ---------------------------------------------------------------------

// {name}, or the literal braces {{ and }}
const PLACEHOLDER = /\{\{|\}\}|\{(\w+)\}/g;

function show(v) {
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "bigint") throw new TypeError("t: format a BigInt first (formatSats, formatBtc, formatNumber)");
  return String(v);
}

function fill(text, params) {
  return text.replace(PLACEHOLDER, (m, name) => {
    if (name === undefined) return m[0];
    return params !== undefined && params !== null && Object.hasOwn(params, name) ? show(params[name]) : m;
  });
}

function keyOf(text, params) {
  if (typeof text !== "string") throw new TypeError("t: the text must be a string");
  const context = params?.$context;
  if (context === undefined) return text;
  if (typeof context !== "string") throw new TypeError("t: $context must be a string");
  return context + "\u0004" + text;
}

// The translation of text, or text, before its {names} are filled in
function template(table, text, params) {
  const key = keyOf(text, params);
  if (state.language === "qps") return pseudo(text);
  const s = table ? table[key] : undefined;
  return typeof s === "string" ? s : text;
}

function lookup(table, text, params) {
  return fill(template(table, text, params), params);
}

export function t(text, params) {
  return lookup(messages, text, params);
}

// For a Label with markup: true. Every param is escaped (an address, a
// name, a scanned text can never add a tag); the text is markup if its key
// has a tag or an entity (and then its translation has the same tags: the
// runtime checks), else plain text, escaped too.
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
const escapeMarkup = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

export function tm(text, params) {
  const markup = /<\/?[a-z]+[\s>]|&#?\w+;/.test(text);    // a tag or an entity
  const literal = (s) => (markup ? s : escapeMarkup(s));
  return template(messages, text, params).replace(/\{\{|\}\}|\{(\w+)\}|[^{}]+|[{}]/g, (m, name) => {
    if (m === "{{" || m === "}}") return literal(m[0]);
    if (name !== undefined && params !== undefined && params !== null && Object.hasOwn(params, name)) {
      return escapeMarkup(show(params[name]));
    }
    return literal(m);
  });
}

// the runtime's own text: from the launcher's catalog
function ts(text, params) {
  if (system === undefined) system = host.systemMessages();
  return lookup(system, text, params);
}

// English and Portuguese (Brazil's too: "0 códigos"): one for 1, other
// otherwise. Other rules come with the languages that need them.
function pluralForm(n) {
  return n === 1 ? "one" : "other";
}

export function plural(n, one, other, params) {
  if (typeof n !== "number") throw new TypeError("plural: the count must be a number");
  return t(pluralForm(n) === "one" ? one : other, { ...params, n });
}

// The pseudo-language "qps": every translated text accented (shows missing
// glyphs), about 40% longer (shows text that overflows) and in brackets
// (shows where it is cut off). Text that didn't go through t() stays plain.
const ACCENTED = {
  a: "å", c: "ç", d: "ď", e: "é", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ĺ", n: "ñ", o: "ö",
  r: "ŕ", s: "š", t: "ţ", u: "û", w: "ŵ", y: "ý", z: "ž",
  A: "Å", C: "Ç", D: "Ď", E: "É", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ĺ", N: "Ñ", O: "Ö",
  R: "Ŕ", S: "Š", T: "Ţ", U: "Û", W: "Ŵ", Y: "Ý", Z: "Ž",
};

function pseudo(text) {
  if (text === "") return text;
  let visible = 0;
  // {names}, tags and entities stay as they are
  const out = text.replace(/\{\{|\}\}|\{\w+\}|<[^<>]*>|&#?\w+;|[^{}<&]+|[{}<&]/g, (piece) => {
    if (piece[0] === "{" || piece[0] === "}" || piece[0] === "<" || (piece[0] === "&" && piece.length > 1)) return piece;
    visible += [...piece].length;
    return piece.replace(/[A-Za-z]/g, (c) => ACCENTED[c] ?? c);
  });
  return "[" + out + " " + "·".repeat(Math.max(1, Math.ceil(visible * 0.4))) + "]";
}

// --- numbers ----------------------------------------------------------------------

function grouped(digits) {
  return state.group ? digits.replace(/\B(?=(\d{3})+$)/g, state.group) : digits;
}

// "1234.5" (JavaScript's way, no exponent) -> the language's
function written(negative, plain) {
  const [whole, frac] = plain.split(".");
  const zero = /^[0.]*$/.test(plain);
  return (negative && !zero ? "-" : "") + grouped(whole) + (frac ? state.decimal + frac : "");
}

function decimalsOption(options, max, fallback) {
  const d = options?.decimals ?? fallback;
  if (!Number.isInteger(d) || d < 0 || d > max) throw new RangeError(`decimals: a whole number from 0 to ${max}`);
  return d;
}

export function formatNumber(x, options) {
  if (typeof x === "bigint") return written(x < 0n, String(x < 0n ? -x : x));
  if (typeof x !== "number") throw new TypeError("formatNumber: a number expected");
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (options?.decimals !== undefined) {
    const d = decimalsOption(options, 20);
    if (a >= 1e21) return written(x < 0, BigInt(a).toString()) + (d ? state.decimal + "0".repeat(d) : "");
    return written(x < 0, a.toFixed(d));
  }
  let plain = String(a);
  if (plain.includes("e")) {
    plain = a >= 1 ? BigInt(a).toString() : a.toFixed(20).replace(/0+$/, "");
  }
  return written(x < 0, plain);
}

const SATS = 100000000n;
const MAX_SATS = 2100000000000000n;

function satsOf(sats, what) {
  if (typeof sats === "bigint") return sats;
  if (typeof sats === "number" && Number.isSafeInteger(sats)) return BigInt(sats);
  throw new TypeError(`${what}: a whole number of satoshis expected (a safe integer or a BigInt)`);
}

export function formatSats(sats) {
  return formatNumber(satsOf(sats, "formatSats"));
}

// decimals: at least that many (0 to 8); the digits that aren't zero always show
export function formatBtc(sats, options) {
  const s = satsOf(sats, "formatBtc");
  const min = decimalsOption(options, 8, 8);
  const a = s < 0n ? -s : s;
  let frac = String(a % SATS).padStart(8, "0");
  while (frac.length > min && frac.endsWith("0")) frac = frac.slice(0, -1);
  return written(s < 0n, String(a / SATS) + (frac ? "." + frac : ""));
}

const escape = (c) => c.replace(/[.\\]/g, "\\$&");

// The text as typed -> "1234.5", or a RangeError saying why not. GapWallet's
// rules (W4, src/amount.js): what could be read two ways, like 1.000 (one,
// or a thousand), is refused rather than guessed; a lone mark that can't be
// a thousands separator, as in 0.001 or 1,5, is the decimal mark, whichever
// the language: numbers are often copied from elsewhere.
function normalize(s, invalid) {
  const { decimal: D, group: G } = state;
  if (s === "" || !/^[\d.,]+$/.test(s)) throw invalid();
  if (s.includes(",") && s.includes(".")) {
    const m = G && new RegExp(`^(\\d{1,3}(?:${escape(G)}\\d{3})*)${escape(D)}(\\d*)$`).exec(s);
    if (!m) {
      throw new RangeError(G
        ? ts("Write {d} for decimals and {g} between thousands, or leave the thousands separator out.", { d: D, g: G })
        : ts("Write {d} for decimals, without a thousands separator.", { d: D }));
    }
    return `${m[1].split(G).join("")}.${m[2]}`;
  }
  const mark = s.includes(",") ? "," : s.includes(".") ? "." : null;
  if (!mark) return s;
  const pieces = s.split(mark);
  if (pieces.length === 2) {
    const [whole, frac] = pieces;
    if (whole === "" && frac === "") throw invalid();
    // 1.000 or 12,500: a thousand, or one? Refused, in every language
    if (frac.length === 3 && /^[1-9]\d{0,2}$/.test(whole) && mark !== D) {
      throw new RangeError(ts("“{text}” could be read two ways. Leave out the thousands separator, and write decimals with {d}: 1000 or 1{d}5.", { text: s, d: D }));
    }
    return `${whole}.${frac}`;
  }
  // several of the same mark: only thousands, written properly
  if (mark === G && new RegExp(`^\\d{1,3}(?:${escape(G)}\\d{3})+$`).test(s)) return pieces.join("");
  throw invalid();
}

export function parseNumber(text) {
  const invalid = () => new RangeError(ts("Enter a number, like {example}.", { example: `1${state.decimal}5` }));
  const m = /^([+-]?)(.*)$/s.exec(String(text).trim());
  const n = normalize(m[2], invalid);
  if (!/^\d*(?:\.\d*)?$/.test(n) || !/\d/.test(n)) throw invalid();
  const x = Number(n.startsWith(".") ? "0" + n : n.endsWith(".") ? n.slice(0, -1) : n);
  return m[1] === "-" ? -x : x;
}

// -> whole satoshis, a Number (21 million BTC fit, exactly)
export function parseBtc(text) {
  const invalid = () => new RangeError(ts("Enter an amount in BTC, like {example}.", { example: `0${state.decimal}001` }));
  const n = normalize(String(text).trim(), invalid);
  const m = /^(\d*)(?:\.(\d*))?$/.exec(n);
  if (!m || (m[1] === "" && !m[2])) throw invalid();
  if ((m[2] || "").length > 8) throw new RangeError(ts("Bitcoin has 8 decimal places at most."));
  const sats = BigInt(m[1] || "0") * SATS + BigInt((m[2] || "").padEnd(8, "0"));
  if (sats > MAX_SATS) throw new RangeError(ts("That's more bitcoin than there is."));
  return Number(sats);
}

export function marks() {
  return { decimal: state.decimal, group: state.group };
}

// --- dates and times: ISO 8601 with a space, in every language ----------------------

const pad = (n, w = 2) => String(n).padStart(w, "0");

function parts(seconds, options) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new TypeError("a time in seconds since 1970 expected");
  const utc = options?.utc === true;
  const d = new Date((Math.floor(seconds) + (utc ? 0 : host.utcOffset() * 60)) * 1000);
  if (Number.isNaN(d.getTime())) throw new RangeError("time out of range");
  return {
    date: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    zone: utc ? " UTC" : "",
  };
}

export function formatDateTime(seconds, options) {
  const p = parts(seconds, options);
  return `${p.date} ${p.time}${p.zone}`;
}

export function formatDate(seconds, options) {
  const p = parts(seconds, options);
  return p.date + p.zone;
}

export function formatTime(seconds, options) {
  const p = parts(seconds, options);
  return p.time + p.zone;
}

// --- the settings: everyone reads them, apps with "settings" change them -------------

export function language() {
  return state.language;
}

export function languages() {
  return host.languages();
}

export function keyboard() {
  return state.keyboard;
}

export function keyboards() {
  return host.keyboards();
}

function changed() {
  refresh();
  const ev = { language: state.language, marks: marks() };
  for (const fn of [...handlers]) {
    try {
      fn(ev);
    } catch (e) {
      Promise.reject(e);	// reported as any uncaught error; the others still run
    }
  }
}

export function setLanguage(tag) {
  if (typeof tag !== "string") throw new TypeError("setLanguage: a language tag expected, like \"pt-BR\"");
  host.setLanguage(tag);
  changed();
}

export function setMarks(m) {
  if (m !== null && m !== undefined && typeof m !== "object") throw new TypeError("setMarks: { decimal, group } or null expected");
  host.setMarks(m?.decimal, m?.group);
  changed();
}

export function setKeyboard(layout) {
  if (typeof layout !== "string") throw new TypeError("setKeyboard: a layout name expected, like \"us\"");
  host.setKeyboard(layout);
  refresh();
}

export function onLanguageChange(fn) {
  if (typeof fn !== "function") throw new TypeError("onLanguageChange: a function expected");
  handlers.push(fn);
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}
