// Level codes: a level number (1 to 99) and its 28-bit seed in eight
// characters of Crockford's base 32, "XXXX-XXXX": seven for the 35 bits,
// and a check character, so a mistyped code is refused instead of starting
// some other level. Plain JavaScript, for Node too.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_LEVEL = 99;

// sum of (position + 1) * digit, mod 31: any one wrong character, or two
// swapped neighbours, changes it, unless they are 0 and Z (31 apart): a
// game's codes need no more (tests/sneakernet/run_node.mjs)
function check(digits) {
  return digits.reduce((sum, d, i) => sum + (i + 1) * d, 0) % 31;
}

export function encode(level, seed) {
  let v = level * 0x10000000 + seed;      // 35 bits: more than JavaScript's bit operators take
  const digits = [];
  for (let i = 0; i < 7; i++) {
    digits.unshift(v % 32);
    v = Math.floor(v / 32);
  }
  digits.push(check(digits));
  const s = digits.map((d) => ALPHABET[d]).join("");
  return s.slice(0, 4) + "-" + s.slice(4);
}

// { level, seed }, or null if it isn't a level code. Lower case, spaces and
// dashes are fine; O reads as 0, I and L as 1 (Crockford's rules).
export function decode(text) {
  const s = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== 8) return null;
  const digits = [...s].map((c) => ALPHABET.indexOf(c));
  if (digits.includes(-1) || check(digits.slice(0, 7)) !== digits[7]) return null;
  const v = digits.slice(0, 7).reduce((v, d) => v * 32 + d, 0);
  const level = Math.floor(v / 0x10000000);
  if (level < 1 || level > MAX_LEVEL) return null;
  return { level, seed: v % 0x10000000 };
}
