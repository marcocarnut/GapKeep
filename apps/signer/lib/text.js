// Text for people, made in pure code (Node too) and translated by the app.
//
//   t("Input {n}: the amount is unknown.", { n: 2 })     a Message
//   plural(count, "{n} input", "{n} inputs", params)     a Message
//   btcValue(sats), satsValue(sats), numberValue(x, decimals)   values for params
//
// A Message is a String: its English, the key with the params filled in, as
// the libraries always wrote it (tests and logs read that). It also keeps
// the key and the params, so the app can say it in the person's language
// (lib/psbt/view.js, say()): gk:i18n's t() with the same key, amounts
// formatted the language's way. Params may be Messages themselves.
//
// The keys are string literals in calls of t() and plural(), as
// tools/i18n.py finds them; the catalog is lang/<language>.json.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export class Message extends String {
  constructor(english, key, params, forms) {
    super(english);
    this.key = key;
    this.params = params;
    this.forms = forms || null;   // a plural's { n, one, other }
  }
}

// Values that are written differently in each language
export const btcValue = (sats) => ({ $btc: Number(sats) });       // 0.00119000, no unit
export const satsValue = (sats) => ({ $sats: Number(sats) });     // 1234, no unit
export const numberValue = (x, decimals) => ({ $number: x, decimals });

// The English way of the values: as the libraries wrote them before
function english(v) {
  if (v instanceof Message) return String(v);
  if (v && typeof v === "object") {
    if ("$btc" in v) return formatBtcEnglish(v.$btc);
    if ("$sats" in v) return String(v.$sats);
    if ("$number" in v) return v.decimals === undefined ? String(v.$number) : v.$number.toFixed(v.decimals);
  }
  return String(v);
}

function formatBtcEnglish(sats) {
  const neg = sats < 0, a = Math.abs(sats);
  return (neg ? "-" : "") + Math.floor(a / 1e8) + "." + String(a % 1e8).padStart(8, "0");
}

const fill = (key, params) => key.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, name) =>
  (m === "{{" ? "{" : m === "}}" ? "}" : params && name in params ? english(params[name]) : m));

export function t(key, params = {}) {
  return new Message(fill(key, params), key, params);
}

export function plural(n, one, other, params = {}) {
  const all = { ...params, n };
  return new Message(fill(n === 1 ? one : other, all), n === 1 ? one : other, all, { n, one, other });
}

// "Input 1", "Inputs 1, 3": a list of numbers in a sentence
export const numbers = (list) => list.join(", ");
