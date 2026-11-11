// Sneakernet: a courier carries a secret across an office of air-gapped
// machines. The secret was split into n shares (as codex32 splits a seed),
// scattered over the floor; any k of them open the vault. Wi-Fi access
// points leak radio that seeps through the corridors: caught in it with
// shares in hand, the courier leaks one, and a share it reaches on the
// floor is lost. Once fewer than k are left, the level is lost too.
//
// A demo of a GapKeep app that moves: one key handler (ui.onKey, with
// auto-repeat for held arrows), one 100 ms timer that keeps the game's
// clock, and a board drawn as static objects plus a few changed per step
// (lib/board.js). Levels come from a seed (lib/level.js), shown as a level
// code (lib/code.js) so any level can be replayed or passed on. The best
// score is kept in gk:session: in RAM, gone at power-off.
//
// The log says what happens (for tests/sneakernet.txt), in English.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as session from "gk:session";
import { randomBytes } from "gk:crypto";
import { t, tm, plural, formatNumber } from "gk:i18n";
import { makeLevel, makeRadio, nextSeed, COLS, WALL } from "./lib/level.js";
import { encode, decode } from "./lib/code.js";
import { Board, COLORS, tileSize } from "./lib/board.js";

const wide = ui.width >= 1000;
const TICK = 100;               // ms: the game clock's step
const HURT_MS = 1500;           // after a leak, the courier is safe this long

const log = (text) => console.log("sneakernet: " + text);
const clockText = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

let screen = "menu";            // "menu", "help", "code" or "play"
let game = null;                // the run: { level, seed, score }
let play = null;                // the level being played (start())

// --- screens around the game ------------------------------------------------------

function page() {
  stopTimer();
  play = null;
  ui.screen.clear();
  ui.screen.set({ layout: "column", padding: wide ? [32, 48] : [16, 24], gap: wide ? 16 : 10, alignItems: "center", scrollable: true });
}

// a column of buttons that Up and Down move between, as well as Tab (gk:ui
// doesn't say which widget has the focus: each button tells us)
let menuButtons = [], focusIndex = 0;
function buttons(parent, list) {
  menuButtons = list.map(([text, onClick], i) => new ui.Button(parent, {
    text, onClick, width: wide ? 420 : 280, onFocus: () => (focusIndex = i),
  }));
  menuButtons[0].focus();
}

function showMenu() {
  page();
  screen = "menu";
  new ui.Label({ text: "Sneakernet", font: wide ? 40 : 32, color: COLORS.amber });
  new ui.Label({ text: t("Carry the shares of a secret across an air-gapped office."), font: wide ? 20 : 14, color: COLORS.muted });
  const col = new ui.Container({ layout: "column", gap: wide ? 12 : 8, alignItems: "center" });
  buttons(col, [
    [ui.symbols.play + "  " + t("New game"), () => newGame(1, randomSeed())],
    [ui.symbols.keyboard + "  " + t("Play a level code"), showCode],
    [ui.symbols.list + "  " + t("How to play"), showHelp],
    [ui.symbols.home + "  " + t("Quit"), () => sys.exit()],
  ]);
  const best = session.get("best");
  new ui.Label({
    text: best ? t("Best: {score} points, level {level}.", { score: formatNumber(best.score), level: best.level })
               : t("No best score yet."),
    font: wide ? 18 : 14,
  });
  new ui.Label({
    text: t("Best scores live in RAM and vanish at power-off. Amnesiac by design."),
    font: wide ? 16 : 12, color: COLORS.muted, width: "100%", textAlign: "center", overflow: "wrap",
  });
  log("menu");
}

function showHelp() {
  page();
  screen = "help";
  new ui.Label({ text: t("How to play"), font: wide ? 32 : 22, color: COLORS.amber });
  const rows = [
    [ui.symbols.file, COLORS.share, t("Shares of the secret. Walk over one to pick it up.")],
    [ui.symbols.drive, COLORS.teal, t("The vault. Any k of the n shares open it: the level says how many.")],
    [ui.symbols.wifi, COLORS.amber, t("Access points. Their radio seeps through the corridors, never through walls.")],
    ["", COLORS.radio[1], t("Radio. Caught in it, you leak a share; a share it reaches on the floor is lost.")],
    [ui.symbols.bars, COLORS.door, t("Faraday doors. You walk through; radio doesn't.")],
    [ui.symbols.shuffle, COLORS.gap, t("Air gap. Only empty hands cross it, to its twin.")],
  ];
  const list = new ui.Container({ layout: "column", gap: wide ? 10 : 6, width: "100%", maxWidth: 900 });
  for (const [symbol, color, text] of rows) {
    const row = new ui.Container(list, { layout: "row", gap: 12, alignItems: "center", width: "100%" });
    const box = new ui.Container(row, { width: wide ? 32 : 22, height: wide ? 32 : 22 });
    if (symbol) new ui.Label(box, { text: symbol, color, align: "center", font: wide ? 24 : 16 });
    else box.bg = color;
    new ui.Label(row, { text, grow: 1, overflow: "wrap", font: wide ? 18 : 14 });
  }
  new ui.Label({
    text: t("Arrows or WASD move, Esc pauses. Fewer than k shares left, and the level is lost. Spare shares and speed score."),
    width: "100%", maxWidth: 900, overflow: "wrap", font: wide ? 18 : 14, color: COLORS.muted,
  });
  buttons(ui.screen, [[ui.symbols.left + "  " + t("Back"), showMenu]]);
  log("help");
}

function showCode() {
  page();
  screen = "code";
  new ui.Label({ text: t("Play a level code"), font: wide ? 32 : 22, color: COLORS.amber });
  new ui.Label({ text: t("Each level shows its code at the top. Type one to play that level again."), font: wide ? 18 : 14, width: "100%", textAlign: "center", overflow: "wrap" });
  const field = new ui.TextArea({
    oneLine: true, maxLength: 9, width: wide ? 300 : 200, placeholder: "XXXX-XXXX", mono: true,
    accept: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-",
  });
  const error = new ui.Label({ text: "", color: COLORS.amber, font: wide ? 18 : 14 });
  const go = () => {
    const code = decode(field.text);
    if (!code) {
      error.text = t("That isn't a level code: check it and try again.");
      log("bad level code");
      return;
    }
    newGame(code.level, code.seed);
  };
  field.on("submit", go);
  const row = new ui.Container({ layout: "row", gap: 12 });
  new ui.Button(row, { text: ui.symbols.play + "  " + t("Play"), onClick: go });
  new ui.Button(row, { text: ui.symbols.left + "  " + t("Back"), onClick: showMenu });
  menuButtons = [];
  field.focus();
}

function randomSeed() {
  const b = randomBytes(4);
  return ((b[0] << 20) | (b[1] << 12) | (b[2] << 4) | (b[3] >> 4)) >>> 0;   // 28 bits
}

// --- a run, and its levels -------------------------------------------------------

function newGame(level, seed) {
  game = { level, seed, score: 0, newBest: false };
  start();
}

async function start() {
  page();
  screen = "play";
  const lvl = makeLevel(game.level, game.seed);
  const code = encode(game.level, game.seed);
  ui.screen.set({ padding: wide ? 16 : 6, gap: wide ? 10 : 4, scrollable: false });

  // the heads-up line: level and code, shares, score and time
  const hud = new ui.Container({ layout: "row", width: "100%", alignItems: "center", gap: 12 });
  const font = wide ? 22 : 14;
  new ui.Label(hud, { markup: true, font, text: tm("Level {n}  <tt>{code}</tt>", { n: game.level, code }) });
  const status = new ui.Label(hud, { font, grow: 1, textAlign: "center", overflow: "dots", text: "" });
  const right = new ui.Label(hud, { font, text: "" });

  const tile = tileSize(ui.width - 2 * (wide ? 16 : 6), ui.height - 2 * (wide ? 16 : 6) - (wide ? 40 : 24));
  const board = new Board(ui.screen, lvl, tile);

  play = {
    lvl, board, status, right, code,
    radio: makeRadio(lvl),
    at: lvl.start,
    carried: 0,
    floor: new Set(lvl.shares),     // shares still on the floor
    time: 0,                        // ms played (pauses don't count)
    steps: 0,                       // radio steps so far
    hurtUntil: 0,
    message: "", messageUntil: 0,
    last: 0,
    running: false,
  };
  board.moveCourier(play.at, false);
  board.addRadio(lvl.aps);
  hudUpdate();
  log(`level ${game.level} start, code ${code}, ${lvl.rules.k} of ${lvl.rules.n} shares, ${lvl.aps.length} access points`);

  const k = lvl.rules.k, n = lvl.rules.n;
  await ui.alert(t("Any {k} of the {n} shares open the vault. The radio starts in a few seconds.", { k, n }),
                 { title: t("Level {n}", { n: game.level }), buttons: [t("Go")] });
  resume();
}

function hudUpdate() {
  const p = play;
  const { k } = p.lvl.rules;
  p.status.text = p.time < p.messageUntil ? p.message
    : t("Carrying {have}, need {k}, {left} on the floor", { have: p.carried, k, left: p.floor.size });
  p.right.text = t("{score} pts  {time}", { score: formatNumber(game.score), time: clockText(p.time) });
}

function say(text) {
  play.message = text;
  play.messageUntil = play.time + 2500;
  hudUpdate();
}

// The game clock: everything timed (the radio, the time shown, being hurt)
// counts play time, so a pause stops it all
let timer = null;
function resume() {
  if (!play) return;
  play.running = true;
  play.last = sys.uptime();
  timer ??= setInterval(tick, TICK);
}
function stopTimer() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (play) play.running = false;
}

function tick() {
  const p = play;
  if (!p || !p.running) return;
  const now = sys.uptime();
  const second = Math.floor(p.time / 1000);
  const wasHurt = p.time < p.hurtUntil, hadMessage = p.time < p.messageUntil;
  p.time += Math.min(now - p.last, 500);     // a slow frame doesn't jump the radio
  p.last = now;
  const { grace, period } = p.lvl.rules;
  while (p.time >= grace + p.steps * period && p.running) {
    p.steps++;
    const fresh = p.radio.step();
    p.board.addRadio(fresh);
    for (const i of fresh) {
      if (p.floor.has(i)) {
        p.floor.delete(i);
        p.board.removeItem(i);
        log(`share leaked on the floor, ${p.floor.size} left there`);
        say(t("The radio reached a share on the floor: it's lost."));
      }
    }
    exposed();
    if (!feasible()) return;
  }
  if (wasHurt && p.time >= p.hurtUntil) p.board.moveCourier(p.at, false);
  if (Math.floor(p.time / 1000) !== second || (hadMessage && p.time >= p.messageUntil)) hudUpdate();
}

// In radio with shares in hand: leak one (then a moment to get away)
function exposed() {
  const p = play;
  if (!p.radio.covered[p.at] || p.carried === 0 || p.time < p.hurtUntil) return;
  p.carried--;
  p.hurtUntil = p.time + HURT_MS;
  p.board.moveCourier(p.at, true);
  log(`share leaked from the courier, carrying ${p.carried}`);
  say(t("Radio! You leaked a share."));
  feasible();
}

// Can k shares still be had? If not, the level is lost (once)
function feasible() {
  const p = play;
  if (!p.running) return false;
  if (p.carried + p.floor.size >= p.lvl.rules.k) return true;
  lose();
  return false;
}

function move(dx, dy) {
  const p = play;
  const { grid, rules: { k }, gaps, exit } = p.lvl;
  const to = p.at + dy * COLS + dx;
  if (grid[to] === WALL) return;
  p.at = to;
  p.board.moveCourier(to, p.time < p.hurtUntil);

  if (p.floor.has(to)) {
    p.floor.delete(to);
    p.carried++;
    p.board.removeItem(to);
    log(`share picked up, carrying ${p.carried}, ${k} needed`);
    if (p.carried === k) {
      p.board.unlockVault();
      say(t("Enough shares: go to the vault!"));
    } else hudUpdate();
  }
  if (gaps && gaps.includes(to)) {
    if (p.carried === 0) {
      p.at = gaps[1 - gaps.indexOf(to)];
      p.board.moveCourier(p.at, false);
      log("crossed the air gap");
      say(t("You crossed the air gap."));
    } else say(t("Only empty hands cross the air gap."));
  }
  exposed();
  if (!p.running) return;
  if (p.at === exit) {
    if (p.carried >= k) clear();
    else say(plural(k, "The vault needs {n} share.", "The vault needs {n} shares."));
  }
}

async function clear() {
  const p = play;
  stopTimer();
  const { k, n } = p.lvl.rules;
  const secs = Math.floor(p.time / 1000);
  const spare = p.carried - k;
  const points = 100 * game.level + 50 * spare + Math.max(0, 120 - secs);
  game.score += points;
  log(`level ${game.level} cleared, ${p.carried} of ${n} shares, ${secs} s, ${points} points`);
  record();
  const choice = await ui.alert(
    t("{carried} shares delivered, {spare} spare, in {time}.\n{points} points; {score} in all.",
      { carried: p.carried, spare, time: clockText(p.time), points, score: formatNumber(game.score) }),
    { title: t("Level {n} cleared", { n: game.level }), buttons: [t("Next level"), t("Main menu")] });
  if (choice === 1) return showMenu();
  game.seed = nextSeed(game.seed, game.level);
  game.level = Math.min(game.level + 1, 99);
  start();
}

async function lose() {
  const p = play;
  stopTimer();
  const { k } = p.lvl.rules;
  log(`level ${game.level} lost, ${p.carried} carried, ${p.floor.size} on the floor, score ${game.score}`);
  const choice = await ui.alert(
    t("Fewer than {k} shares are left: the secret can't be put back together.\nScore: {score}.", { k, score: formatNumber(game.score) })
      + (game.newBest ? "\n" + t("A new best score!") : ""),
    { title: t("Level {n} lost", { n: game.level }), buttons: [t("Try this level again"), t("Main menu")] });
  if (choice === 0) newGame(game.level, game.seed);
  else showMenu();
}

// the best score of this power-on, updated after each level cleared
function record() {
  const best = session.get("best");
  if (best && best.score >= game.score) return;
  session.set("best", { score: game.score, level: game.level });
  game.newBest = true;
}

async function pause() {
  stopTimer();
  log("paused");
  const choice = await ui.alert(
    t("Arrows or WASD move. Pick up shares, keep out of the radio, reach the vault."),
    { title: t("Paused"), buttons: [t("Resume"), t("Restart level"), t("Main menu")] });
  if (choice === 1) return start();
  if (choice === 2) return showMenu();
  resume();
}

// --- keys ------------------------------------------------------------------------

const MOVES = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};

ui.onKey((ev) => {
  if (screen === "play") {
    if (!play || !play.running) return true;
    if (ev.key === "Escape") { pause(); return true; }
    const m = MOVES[ev.key.length === 1 ? ev.key.toLowerCase() : ev.key];
    if (m) move(m[0], m[1]);
    return true;
  }
  // menus: Up and Down move between the buttons, Escape goes back
  if (ev.key === "Escape" && screen !== "menu") { showMenu(); return true; }
  if (menuButtons.length > 1 && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
    const n = menuButtons.length;
    menuButtons[(focusIndex + (ev.key === "ArrowDown" ? 1 : n - 1)) % n].focus();
    return true;
  }
  return false;
});

showMenu();
log("ready");
