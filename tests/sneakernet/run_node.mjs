// Sneakernet's levels and level codes, under Node:
//   node --experimental-default-type=module tests/sneakernet/run_node.mjs
// Codes go there and back and refuse typos; every level from 1 to 99 is
// built whole for many seeds (everything placed, on distinct floor tiles,
// all within reach); and the levels tests/sneakernet.txt plays are still
// the ones its routes were made for.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const { encode, decode } = await import("../../apps/sneakernet/lib/code.js");
const { makeLevel, makeRadio, distances, COLS, WALL, FLOOR } = await import("../../apps/sneakernet/lib/level.js");

const bad = [];
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// codes: there and back, and every one-character typo refused (but 0 for Z)
let typos = 0;
for (let n = 0; n < 300; n++) {
  const level = 1 + (n % 99), seed = (n * 2654435761) % 0x10000000;
  const code = encode(level, seed);
  const back = decode(code.toLowerCase());
  if (!back || back.level !== level || back.seed !== seed) bad.push(`code ${code}: decodes as ${JSON.stringify(back)}`);
  const plain = code.replace("-", "");
  for (let i = 0; i < 8; i++) {
    for (const c of ALPHABET) {
      if (c === plain[i] || (c + plain[i]).match(/^(0Z|Z0)$/)) continue;
      const typo = plain.slice(0, i) + c + plain.slice(i + 1);
      typos++;
      if (decode(typo)) bad.push(`code ${code}: the typo ${typo} is accepted`);
    }
  }
}
for (const wrong of ["", "0800-21Y", "0800-21YSS", "0000-0000", "!800-21YS"]) {
  if (decode(wrong)) bad.push(`"${wrong}" is accepted as a code`);
}
console.log(`codes: 300 round trips, ${typos} typos tried`);

// levels: everything placed, distinct, on the floor, reachable
let levels = 0;
for (let level = 1; level <= 99; level++) {
  for (let seed = 0; seed < 40; seed++) {
    const lvl = makeLevel(level, seed * 7919);
    const again = makeLevel(level, seed * 7919);
    const name = `level ${encode(level, seed * 7919)}`;
    if (lvl.grid.join() !== again.grid.join() || lvl.shares.join() !== again.shares.join()) bad.push(`${name}: not the same twice`);
    const things = [lvl.start, lvl.exit, ...lvl.shares, ...lvl.aps, ...(lvl.gaps ?? [])];
    if (lvl.shares.length !== lvl.rules.n || lvl.aps.length !== lvl.rules.aps) bad.push(`${name}: ${lvl.shares.length} shares, ${lvl.aps.length} access points`);
    if (new Set(things).size !== things.length) bad.push(`${name}: two things on one tile`);
    const reach = distances(lvl.grid, [lvl.start]);
    for (const i of things) {
      if (i === undefined || lvl.grid[i] !== FLOOR || reach[i] < 0) bad.push(`${name}: something at ${i} is out of reach`);
    }
    if (lvl.grid.filter((x) => x !== WALL && x !== FLOOR).length !== lvl.rules.doors) bad.push(`${name}: wrong number of doors`);
    levels++;
  }
}
console.log(`levels: ${levels} built`);

// the scenario's levels: the routes in tests/sneakernet.txt pick up these
// shares, in this order, and the radio stays far behind
const expect = (code, want) => {
  const { level, seed } = decode(code);
  const lvl = makeLevel(level, seed);
  const radio = makeRadio(lvl);
  const got = {
    shares: lvl.shares.map((i) => [i % COLS, Math.floor(i / COLS)].join()).join(" "),
    aps: lvl.aps.map((i) => [i % COLS, Math.floor(i / COLS)].join()).join(" "),
    exit: [lvl.exit % COLS, Math.floor(lvl.exit / COLS)].join(),
  };
  let firstShareLost = 0;
  for (let s = 1; !firstShareLost && s < 1000; s++) {
    if (radio.step().some((i) => lvl.shares.includes(i))) firstShareLost = lvl.rules.grace + s * lvl.rules.period;
  }
  got.firstShareLost = firstShareLost;
  for (const k of Object.keys(want)) if (got[k] !== want[k]) bad.push(`${code}: ${k} is ${got[k]}, not ${want[k]}`);
};
expect("0800-21YS", { shares: "15,11 23,15 15,5", aps: "11,3", exit: "15,1", firstShareLost: 87600 });
expect("0800-0QV2", { firstShareLost: 7200 });

for (const b of bad.slice(0, 20)) console.log("FAIL", b);
console.log(bad.length ? `${bad.length} failures` : "all passed");
process.exit(bad.length ? 1 : 0);
