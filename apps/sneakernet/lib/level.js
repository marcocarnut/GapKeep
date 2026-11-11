// Sneakernet's levels: a floor plan, the shares on it, the access points
// and their radio, all from a level number and a 28-bit seed. Plain
// JavaScript (no gk: modules), so it runs under Node too: the same seed
// gives the same level everywhere, on every screen size.
//
// The grid is COLS x ROWS tiles. Tiles at odd (x, y) are rooms of the maze;
// the tiles between them are walls or openings. A tile is an index,
// i = y * COLS + x.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export const COLS = 31, ROWS = 21;
export const WALL = 1, FLOOR = 0, DOOR = 2;     // DOOR: a Faraday door, radio can't pass

// mulberry32: a small, fast, good-enough PRNG. Returns floats in [0, 1).
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed of the level after this one: a hash of this one's.
export function nextSeed(seed, level) {
  return Math.floor(prng(seed ^ Math.imul(level, 0x9e3779b9))() * 0x10000000);
}

// How hard each level is. k of n shares open the vault.
export function rules(level) {
  const k = Math.min(2 + Math.floor((level - 1) / 2), 5);
  return {
    k,
    n: Math.min(k + 1 + ((level - 1) % 2), 8),
    aps: Math.min(1 + Math.floor(level / 2), 5),        // Wi-Fi access points
    doors: level >= 2 ? Math.min(level, 4) : 0,         // Faraday doors
    gaps: level >= 3,                                   // an air-gap pair
    period: Math.max(250, 600 - 40 * (level - 1)),      // ms between radio steps
    grace: 3000,                                        // ms of silence at the start
  };
}

const STEPS = [-COLS, 1, COLS, -1];       // up, right, down, left

// Path distances to every tile from the nearest of the tiles `from` (walls:
// -1). Doors are passable.
export function distances(grid, from) {
  const dist = new Int16Array(grid.length).fill(-1);
  const queue = new Int16Array(grid.length);
  let tail = 0;
  for (const i of from) {
    dist[i] = 0;
    queue[tail++] = i;
  }
  for (let q = 0; q < tail; q++) {
    const i = queue[q];
    for (const step of STEPS) {
      const j = i + step;
      if (grid[j] !== WALL && dist[j] < 0) {
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }
  return dist;
}

export function makeLevel(level, seed) {
  const r = rules(level);
  const rand = prng(seed * 977 + level);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const grid = new Uint8Array(COLS * ROWS).fill(WALL);

  // 1. A maze, carved depth-first from a random room...
  const rooms = [];
  for (let y = 1; y < ROWS; y += 2) for (let x = 1; x < COLS; x += 2) rooms.push(y * COLS + x);
  const stack = [pick(rooms)];
  grid[stack[0]] = FLOOR;
  while (stack.length) {
    const i = stack[stack.length - 1];
    const next = [];
    for (const step of STEPS) {
      const j = i + 2 * step;         // the room beyond the wall; the border is all walls
      if (j > 0 && j < grid.length && grid[j] === WALL && grid[i + step] === WALL && !border(i + step)) next.push(j);
    }
    if (!next.length) { stack.pop(); continue; }
    const j = pick(next);
    grid[(i + j) / 2] = FLOOR;
    grid[j] = FLOOR;
    stack.push(j);
  }
  // 2. ...with some walls knocked out, so there is more than one way round
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      const i = y * COLS + x;
      if (grid[i] !== WALL || (x + y) % 2 === 0) continue;   // only walls between two rooms
      const step = x % 2 ? COLS : 1;
      if (grid[i - step] === FLOOR && grid[i + step] === FLOOR && rand() < 0.1) grid[i] = FLOOR;
    }
  }

  // 3. The courier starts bottom left; the vault is the room farthest away
  const start = (ROWS - 2) * COLS + 1;
  const fromStart = distances(grid, [start]);
  const exit = rooms.reduce((a, b) => (fromStart[b] > fromStart[a] ? b : a));
  const fromExit = distances(grid, [exit]);

  // Things are placed on random candidates, at least `d` tiles (as the crow
  // flies, in steps) from everything placed before, if a few tries find one
  const taken = [start, exit];
  const place = (candidates, d) => {
    let best = -1;
    for (let tries = 0; tries < 24; tries++) {
      const i = pick(candidates);
      if (taken.includes(i)) continue;
      best = i;
      const x = i % COLS, y = (i - x) / COLS;
      if (taken.every((j) => Math.abs(x - (j % COLS)) + Math.abs(y - Math.floor(j / COLS)) >= d)) break;
    }
    if (best < 0) best = candidates.find((i) => !taken.includes(i));
    taken.push(best);
    return best;
  };

  // 4. The shares: one from each band of distance, near to far, so there is
  // always a choice between the easy ones and the gamble
  const byDistance = rooms.filter((i) => fromStart[i] >= 6 && fromExit[i] >= 4)
    .sort((a, b) => fromStart[a] - fromStart[b]);
  const shares = [];
  for (let s = 0; s < r.n; s++) {
    const band = byDistance.slice(Math.floor((s * byDistance.length) / r.n), Math.floor(((s + 1) * byDistance.length) / r.n));
    shares.push(place(band, 4));
  }

  // 5. Access points, away from the start, the vault and the shares (the
  // radio should not take a share before the courier could get there)
  const fromShares = distances(grid, shares);
  const apRooms = rooms.filter((i) => fromStart[i] >= 16 && fromExit[i] >= 6 && fromShares[i] >= 6);
  const aps = [];
  for (let a = 0; a < r.aps; a++) aps.push(place(apRooms.length ? apRooms : rooms, 6));

  // 6. Faraday doors in openings between rooms (never next to the start)
  const openings = [];
  for (let i = 0; i < grid.length; i++) {
    const x = i % COLS, y = (i - x) / COLS;
    if (grid[i] === FLOOR && (x + y) % 2 === 1 && fromStart[i] > 4) openings.push(i);
  }
  for (let d = 0; d < r.doors; d++) grid[place(openings, 3)] = DOOR;

  // 7. An air-gap pair: one pad near the start, its twin far off
  let gaps = null;
  if (r.gaps) {
    const near = rooms.filter((i) => fromStart[i] >= 4 && fromStart[i] <= 12);
    const away = rooms.filter((i) => fromStart[i] >= 24);
    gaps = [place(near, 2), place(away, 4)];
  }

  return { level, seed, rules: r, grid, start, exit, shares, aps, gaps, radioSeed: Math.floor(rand() * 0x7fffffff) };
}

const border = (i) => i < COLS || i >= (ROWS - 1) * COLS || i % COLS === 0 || i % COLS === COLS - 1;

// The radio: it starts on each access point and seeps through openings, a
// step at a time, never through walls or Faraday doors. Each step, every
// tile at its edge spreads to each open neighbour with probability 0.6: a
// gas, not a diamond. It depends only on the level and the number of steps,
// never on what the courier does, so a seed replays exactly.
export function makeRadio(lvl) {
  const rand = prng(lvl.radioSeed);
  const covered = new Uint8Array(lvl.grid.length);
  let edge = [...lvl.aps];
  for (const i of edge) covered[i] = 1;
  return {
    covered,
    // One step; returns the tiles newly covered.
    step() {
      const fresh = [];
      const keep = [];
      for (const i of edge) {
        let open = false;
        for (const step of STEPS) {
          const j = i + step;
          if (lvl.grid[j] !== FLOOR || covered[j]) continue;
          if (rand() < 0.6) { covered[j] = 1; fresh.push(j); } else open = true;
        }
        if (open) keep.push(i);
      }
      edge = keep.concat(fresh);
      return fresh;
    },
  };
}
