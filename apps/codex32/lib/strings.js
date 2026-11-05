// User-facing text: codex32_recover.html's own English strings (copied
// verbatim into ../vendor/recover.js), with the HTML taken out, and a few
// replaced where they speak of a browser: pasting, the clipboard, closing
// the page. The Portuguese strings are in the vendored file too, unused.

import { STRINGS } from "../vendor/recover.js";

// HTML to plain text: paragraphs become blank lines, list items bullets,
// and typography the built-in font lacks becomes ASCII.
export function plain(html) {
  return ascii(String(html))
    .replace(/<\/p>\s*<ul>\s*<li>/g, "\n- ")
    .replace(/<li>/g, "\n- ")
    .replace(/<\/p>\s*<p>|<\/ul>\s*<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const page = STRINGS.en;

const overrides = {
  warnHtml: "Do this on the <b>offline device</b> you will use the phrase on. The moment enough shares are in " +
    "one place, the seed exists again — that is the point of the exercise and also its whole risk. " +
    "Press Clear when you are done: it erases the shares and the result from this app.",
  inputHeading: "Type your shares",
  inputHelp: "One per box. You need exactly as many as the threshold the shares were made with — a 2-of-3 " +
    "split needs 2, no more and no fewer. Case does not matter, and spaces are ignored. Enter goes on to the " +
    "next box, and recovers from the last one.",
  errNoShares: "Type your shares first, one per box.",
  // the page says 8 + 8 + 8 at 12 words too
  qrBtnSplit: page.qrBtnSplit.replace("8 + 8 + 8", "{third} + {third} + {third}"),
  qrWarningHtml: page.qrWarningHtml.replace("those 8 words", "those {third} words"),
  exportHeading: "Getting the phrase off this device",
  exportCompareHtml: "<p>The shares you just combined were the safe form of this secret — no one of them " +
    "was worth stealing. What is on screen now is the whole of it in one place, and every way out of here " +
    "carries all of it.</p><ul><li>QR of the words — the same secret carried by light rather than a cable, " +
    "which is what makes an air-gapped machine practical. The price is a camera, a lit screen, and whatever " +
    "else can see either.</li><li>SeedQR and Compact SeedQR — the same exposure in a different notation, " +
    "for wallets that read these and not plain text. A different format, not a safer one.</li></ul>" +
    "<p>When you are done here, press Clear. The shares are what this secret should go back to living as.</p>",
};

export const S = {};
for (const k of Object.keys(page)) S[k] = plain(k in overrides ? overrides[k] : page[k]);
for (const k of Object.keys(overrides)) S[k] = plain(overrides[k]);

export function ascii(text) {
  return String(text)
    .replace(/\u2014/g, "-").replace(/\u2013/g, "-")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...").replace(/\u2022/g, "*").replace(/\u00d7/g, "x");
}

// "{t} words" and the like: the page's placeholders
export const F = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
