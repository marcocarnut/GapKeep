// Lays out a page for an e-paper panel: a title, a short note, a block of
// text (a share in groups of four, or numbered words) and a QR code, in the
// panel's pixel font (epdmono). Pure: no gk: imports, so tests/epaper/
// layout_node.mjs checks it under Node for every panel model and both
// orientations.
//
// Home: apps/dice39/lib/epaperlayout.js; apps/codex32 has a copy made by
// tools/share_libs.py (never edit the copy).
//
// SPDX-License-Identifier: GPL-3.0-or-later

// epdmono's sizes: [character width, line height] in pixels (one bit a
// pixel, monospaced: src/runtime/fonts/gk_epdmono_*.c)
export const EPDMONO = { 10: [6, 10], 14: [8, 14], 16: [8, 16], 20: [10, 20], 24: [12, 24], 32: [16, 32] };

const TEXT_FONTS = [32, 24, 20, 16, 14, 10];
const TITLE_FONTS = [32, 24, 20, 16];
const NOTE_FONTS = [16, 14, 10];
const MARGIN = 2;      // around the text, px (the QR code brings its own quiet zone)
const MAX_SCALE = 6;   // px a module at most: bigger reads no better

// Greedy word wrap to `cols` characters a line; null if a word is longer
export function wrap(text, cols) {
  if (!text) return [];
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word.length > cols) return null;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= cols) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Tokens in rows of `cols` characters at most, each padded to the longest,
// `sep` spaces between them; null if not even one fits a row
export function grid(tokens, cols, sep) {
  const width = Math.max(...tokens.map((x) => x.length));
  const per = Math.floor((cols + sep) / (width + sep));
  if (per < 1) return null;
  const lines = [];
  for (let i = 0; i < tokens.length; i += per) {
    lines.push(tokens.slice(i, i + per).map((x) => x.padEnd(width)).join(" ".repeat(sep)).trimEnd());
  }
  return lines;
}

// A codex32 share as the panel shows it: groups of four characters
export const shareTokens = (share) => share.match(/.{1,4}/g);

// "1 abandon" ... "24 art": numbered words; short = the first four letters
// (BIP-39 words are unique in them)
export const wordTokens = (words, short) =>
  words.map((w, i) => `${String(i + 1).padStart(2)} ${short ? w.slice(0, 4) : w}`);

const height = (font, lines) => (lines.length ? lines.length * EPDMONO[font][1] : 0);
const cols = (font, px) => Math.floor(px / EPDMONO[font][0]);

// The text column (title, note, text) in `px` pixels across: its lines and
// height, or null if something doesn't fit across
function column(page, variant, px, f, tf, nf) {
  const title = wrap(page.title, cols(tf, px));
  const note = wrap(page.note || "", cols(nf, px));
  const text = variant ? grid(variant.tokens, cols(f, px), variant.sep || 1) : [];
  if (!title || !note || !text) return null;
  const gaps = (note.length ? 2 : 0) + (text.length ? 4 : 0);
  return { title, note, text, height: height(tf, title) + height(nf, note) + height(f, text) + gaps };
}

// Blocks of text placed from (x, y) down
function blocks(c, x, y, f, tf, nf) {
  const out = [{ x, y, font: tf, lines: c.title, role: "title" }];
  y += height(tf, c.title);
  if (c.note.length) {
    y += 2;
    out.push({ x, y, font: nf, lines: c.note, role: "note" });
    y += height(nf, c.note);
  }
  if (c.text.length) {
    y += 4;
    out.push({ x, y, font: f, lines: c.text, role: "text" });
  }
  return out;
}

// The best page for a panel of width x height pixels (landscape, as
// ui.epaper.info() gives them). page: { title, note, qrSide (the QR code's
// modules with its 4-module quiet zone on each side), variants: [{ tokens,
// sep }] best first }. Returns null if the QR code doesn't fit at 2 px a
// module, else { orientation, width, height, qr: { x, y, size, scale },
// blocks: [{ x, y, font, lines, role }], variant (its index; variants.length:
// no text), textFont }.
//
// Preferred, in order: the first variant of the text (then the next, then
// none), text of 14 px or more, modules of 3 px or more, the largest text,
// a title on one line, the largest title, a note on one line, larger
// modules (up to 6 px), the larger note, landscape.
export function planPage(panel, page) {
  let best = null;
  const variants = page.variants || [];
  for (const orientation of ["landscape", "portrait"]) {
    const [w, h] = orientation === "landscape" ? [panel.width, panel.height] : [panel.height, panel.width];
    for (let v = 0; v <= variants.length; v++) {
      const variant = variants[v] || null;
      for (let s = MAX_SCALE; s >= 2; s--) {
        const q = s * page.qrSide;
        if (q > w || q > h) continue;
        for (const f of variant ? TEXT_FONTS : [10]) {
          for (const tf of TITLE_FONTS) {
            for (const nf of NOTE_FONTS) {
              if (nf >= tf) continue;
              const base = (variants.length - v) * 1e10 + (!variant || f >= 14 ? 1e9 : 0) +
                Math.min(s, 3) * 1e8 + (variant ? f : 0) * 1e6 + tf * 1e4 + s * 100 + nf * 2 +
                (orientation === "landscape" ? 1 : 0);
              if (best && best.score >= base + 5e5 + 5e3) continue;
              for (const plan of [side(page, variant, w, h, s, q, f, tf, nf), stack(page, variant, w, h, s, q, f, tf, nf)]) {
                if (!plan) continue;
                const score = base + (plan.titleLines === 1 ? 5e5 : 0) + (plan.noteLines <= 1 ? 5e3 : 0);
                if (best && best.score >= score) continue;
                Object.assign(plan, { orientation, width: w, height: h, variant: v, textFont: variant ? f : 0, score });
                best = plan;
              }
            }
          }
        }
      }
    }
  }
  return best;
}

// The QR code on the left, the column beside it
function side(page, variant, w, h, s, q, f, tf, nf) {
  const px = w - q - MARGIN;
  if (px < 40) return null;
  const c = column(page, variant, px, f, tf, nf);
  if (!c || c.height > h - 2 * MARGIN) return null;
  return {
    qr: { x: 0, y: Math.floor((h - q) / 2), size: q, scale: s },
    blocks: blocks(c, q, Math.floor((h - c.height) / 2), f, tf, nf),
    titleLines: c.title.length, noteLines: c.note.length,
  };
}

// The title and note on top, the QR code under them, the text under it
function stack(page, variant, w, h, s, q, f, tf, nf) {
  const px = w - 2 * MARGIN;
  const head = column(page, null, px, f, tf, nf);
  const body = variant ? grid(variant.tokens, cols(f, px), variant.sep || 1) : [];
  if (!head || !body) return null;
  const total = head.height + q + (body.length ? height(f, body) : 0);
  if (total > h - 2 * MARGIN) return null;
  let y = Math.floor((h - total) / 2);
  const out = blocks(head, MARGIN, y, f, tf, nf);
  y += head.height;
  const qr = { x: Math.floor((w - q) / 2), y, size: q, scale: s };
  y += q;
  if (body.length) {
    // the text as wide as it is, centred
    const across = Math.max(...body.map((l) => l.length)) * EPDMONO[f][0];
    out.push({ x: Math.max(MARGIN, Math.floor((w - across) / 2)), y, font: f, lines: body, role: "text" });
  }
  return { qr, blocks: out, titleLines: head.title.length, noteLines: head.note.length };
}
