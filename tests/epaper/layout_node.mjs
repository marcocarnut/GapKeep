// The e-paper page layout of dice39 and codex32 (apps/dice39/lib/
// epaperlayout.js) for every panel model, under Node:
//   node tests/epaper/layout_node.mjs [-v]
// For codex32 shares of each seed size and the seed's QR codes: the page
// fits the panel, nothing overlaps, the QR code has modules of 2 px at
// least (3 where it can), and the text is all there. Throwaway data only.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { planPage, shareTokens, wordTokens, EPDMONO } from "../../apps/dice39/lib/epaperlayout.js";

const verbose = process.argv.includes("-v");
const PANELS = { "weact-2.9-bwr": [296, 128], "weact-2.13-bw": [250, 122], "weact-4.2-bw": [400, 300] };

// codex32 shares of 16, 20, 24 and 32 bytes (lengths 48, 54, 61, 74), in
// QR's alphanumeric mode at ECC M: versions 3, 3, 3 and 4
const share = (n) => "MS12TEST" + "A".repeat(n - 8);
const SHARES = [[48, 29], [54, 29], [61, 29], [74, 33]];
const words = (n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? "about" : "abandon"));
// the seed's QR codes: SeedQR (numeric, L), Compact SeedQR (bytes, L), the words (bytes, M)
const SEEDS = [
  [12, "SeedQR", 25], [24, "SeedQR", 29], [12, "Compact SeedQR", 21], [24, "Compact SeedQR", 25],
  [12, "Words", 41], [24, "Words", 57],
];

let failed = 0;
function fail(what) {
  failed++;
  console.log("FAIL " + what);
}

function check(name, panel, page, want) {
  const plan = planPage({ width: panel[0], height: panel[1] }, page);
  if (!plan) {
    if (want.fits === false) return;
    return fail(`${name}: does not fit`);
  }
  if (want.fits === false) return fail(`${name}: fits, but should not`);
  const { qr } = plan;
  const boxes = [{ x: qr.x, y: qr.y, w: qr.size, h: qr.size, what: "QR" }];
  for (const b of plan.blocks) {
    const [cw, lh] = EPDMONO[b.font];
    boxes.push({ x: b.x, y: b.y, w: Math.max(...b.lines.map((l) => l.length)) * cw, h: b.lines.length * lh, what: b.role });
  }
  for (const b of boxes) {
    if (b.x < 0 || b.y < 0 || b.x + b.w > plan.width || b.y + b.h > plan.height) {
      fail(`${name}: ${b.what} outside the panel (${JSON.stringify(b)} in ${plan.width}x${plan.height})`);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        fail(`${name}: ${a.what} and ${b.what} overlap`);
      }
    }
  }
  if (qr.scale < 2 || qr.size !== qr.scale * page.qrSide) fail(`${name}: QR scale ${qr.scale}`);
  if (want.scale && qr.scale < want.scale) fail(`${name}: QR at ${qr.scale} px, ${want.scale} expected`);
  if (want.font && plan.textFont < want.font) fail(`${name}: text at ${plan.textFont} px, ${want.font} expected`);
  if (want.variant !== undefined && plan.variant !== want.variant) fail(`${name}: text variant ${plan.variant}`);
  const text = plan.blocks.filter((b) => b.role === "text").flatMap((b) => b.lines).join(" ").split(/ +/).join("");
  const tokens = plan.variant < page.variants.length ? page.variants[plan.variant].tokens : [];
  if (text !== tokens.join("").split(/ +/).join("")) fail(`${name}: the text is not all there`);
  if (verbose) {
    console.log(`${name}: ${plan.orientation} ${plan.width}x${plan.height}, QR ${qr.size} px (${qr.scale} a module), ` +
      `text ${plan.textFont} px, variant ${plan.variant}, title ${plan.blocks[0].font}`);
  }
}

for (const [model, panel] of Object.entries(PANELS)) {
  for (const [len, modules] of SHARES) {
    for (const [title, note] of [["Share 1 of 3", "any 2 recover the phrase"],
      ["Partição 10 de 15", "quaisquer 10 recuperam a frase"]]) {
      check(`${model} share ${len} "${title}"`, panel, {
        title, note, qrSide: modules + 8, variants: [{ tokens: shareTokens(share(len)), sep: 1 }],
      }, { scale: model === "weact-2.13-bw" && len > 54 ? 2 : 3, font: model === "weact-2.13-bw" ? 14 : 16, variant: 0 });
    }
  }
  for (const [n, title, modules] of SEEDS) {
    const page = {
      title, note: `${n} words, BIP-39`, qrSide: modules + 8,
      variants: [{ tokens: wordTokens(words(n)), sep: 2 }, { tokens: wordTokens(words(n), true), sep: 2 }],
    };
    // the 24 words' own QR code (version 10) needs a 4.2" panel
    const fits = !(title === "Words" && n === 24 && model !== "weact-4.2-bw");
    check(`${model} ${title} ${n}`, panel, page, { fits, scale: 2 });
  }
}
console.log(failed ? `epaper layout: ${failed} failed` : "epaper layout: all pages fit");
process.exit(failed ? 1 : 0);
