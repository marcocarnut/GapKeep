// Draws a level with gk:ui. LVGL redraws only what changed, so the board is
// a few hundred small, static objects and the game moves or adds a handful
// per step:
//
//   - the floor is the board's own background;
//   - walls are one Container per run of wall tiles in a row (about 200);
//   - radio tiles are added as the radio spreads, in a layer under the items;
//   - items (shares, access points, the vault, doors, air gaps) are a tile
//     with an icon each, deleted when picked up;
//   - the courier is one round Container, moved by setting x and y.
//
// The grid is the same on every screen (level codes replay anywhere); the
// tile size follows the screen.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import { COLS, ROWS, WALL, DOOR } from "./level.js";

export const COLORS = {
  floor: "#26353b", wall: "#0b1113", radio: ["#4a3a00", "#5a4708"], amber: "#ffc300",
  teal: "#00968c", share: "#2fd6c6", courier: "#f2f2f2", door: "#90a4ae", gap: "#b39ddb",
  muted: "#8a9199",
};

// The largest tile that fits the space, and the largest font that fits a tile
export function tileSize(width, height) {
  return Math.max(8, Math.floor(Math.min(width / COLS, height / ROWS)));
}
const iconFont = (tile) => ui.fonts.filter((f) => f <= tile * 0.8).pop() ?? ui.fonts[0];

export class Board {
  constructor(parent, lvl, tile) {
    this.lvl = lvl;
    this.tile = tile;
    this.font = iconFont(tile);
    this.root = new ui.Container(parent, {
      layout: "none", width: COLS * tile, height: ROWS * tile, bg: COLORS.floor, radius: 4,
    });
    // walls, merged into runs along each row
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; ) {
        if (lvl.grid[y * COLS + x] !== WALL) { x++; continue; }
        let end = x;
        while (end < COLS && lvl.grid[y * COLS + end] === WALL) end++;
        this.rect(this.root, x, y, end - x, COLORS.wall);
        x = end;
      }
    }
    this.radioLayer = this.layer();
    this.itemLayer = this.layer();
    this.items = new Map();        // tile index -> its widget
    for (let i = 0; i < lvl.grid.length; i++) {
      if (lvl.grid[i] === DOOR) this.icon(i, ui.symbols.bars, COLORS.door, "#22323a");
    }
    if (lvl.gaps) for (const i of lvl.gaps) this.icon(i, ui.symbols.shuffle, COLORS.gap);
    for (const i of lvl.shares) this.items.set(i, this.icon(i, ui.symbols.save, COLORS.share));
    this.vault = this.icon(lvl.exit, ui.symbols.drive, COLORS.muted);
    this.vault.set({ borderWidth: 2, borderColor: COLORS.teal, radius: 3 });
    for (const i of lvl.aps) this.icon(i, ui.symbols.wifi, COLORS.amber);
    const size = Math.round(tile * 0.64);
    this.courier = new ui.Container(this.root, {
      width: size, height: size, radius: size, bg: COLORS.courier, borderWidth: 2, borderColor: COLORS.teal,
    });
    this.inset = Math.floor((tile - size) / 2);
  }

  // a Container covering the whole board, to keep its children in a z-order
  layer() {
    return new ui.Container(this.root, { layout: "none", width: COLS * this.tile, height: ROWS * this.tile });
  }

  rect(parent, x, y, w, color) {
    const t = this.tile;
    return new ui.Container(parent, { x: x * t, y: y * t, width: w * t, height: t, bg: color });
  }

  icon(i, symbol, color, bg) {
    const t = this.tile;
    const box = new ui.Container(this.itemLayer, { x: (i % COLS) * t, y: Math.floor(i / COLS) * t, width: t, height: t });
    if (bg) box.bg = bg;
    new ui.Label(box, { text: symbol, font: this.font, color, align: "center" });
    return box;
  }

  // radio reached these tiles; a two-tone pattern, so it reads as a haze
  addRadio(tiles) {
    for (const i of tiles) {
      const x = i % COLS, y = Math.floor(i / COLS);
      this.rect(this.radioLayer, x, y, 1, COLORS.radio[(x + y) % 2]);
    }
  }

  removeItem(i) {
    this.items.get(i)?.delete();
    this.items.delete(i);
  }

  moveCourier(i, hurt) {
    const t = this.tile;
    this.courier.set({
      x: (i % COLS) * t + this.inset, y: Math.floor(i / COLS) * t + this.inset,
      bg: hurt ? COLORS.amber : COLORS.courier,
    });
  }

  unlockVault() {
    this.vault.set({ bg: COLORS.teal });
    this.vault.children[0].color = COLORS.courier;
  }
}
