// The browser IDE's keyboard (sim/web/textinput.js), under Node: the events
// a browser sends for typing, dead keys, AltGr, input methods, shortcuts and
// paste, as plain objects. Two parts:
//
//  1. the decisions: which event types what, never twice, with Gapkeep's own
//     keyDown()/type() (sim/web/gapkeep.js) over a recording stub;
//  2. end to end, if "make -C sim web TEST=1" was run: the simulator in
//     WebAssembly, tests/apps/typetest logging what reached a TextArea.
//
// What it can't show: that a real browser sends these events in this order
// (see docs/IDE.md, "Typing").
//
//   node --experimental-default-type=module tests/web/textinput.mjs
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { TextInput, MOD_CTRL, MOD_ALT, MOD_SHIFT } from "../../sim/web/textinput.js";
import { Gapkeep } from "../../sim/web/gapkeep.js";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

let failed = 0, passed = 0;
function check (name, got, want) {
  const g = JSON.stringify (got), w = JSON.stringify (want);
  if (g === w) passed++;
  else { failed++; console.log (`FAIL ${name}: got ${g}, want ${w}`); }
}

// --- 1. the decisions --------------------------------------------------------

// Gapkeep's methods on a stub: what reaches gk_sim_key_down_dom
function stubMachine () {
  const z = Object.create (Gapkeep.prototype);
  z.sent = [];
  z.halted = false;
  z.m = {
    stringToNewUTF8: (s) => s,
    _free: () => {},
    // as sim/src/sim.cpp's: specials by name, one ASCII or Latin-1 character
    _gk_sim_key_down_dom: (key, mods) => {
      const special = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "Delete", "Insert", "PageUp", "PageDown", "Meta", "OS", " "].includes (key) || /^F[1-9]$/.test (key);
      const c = [...key].length === 1 ? key.codePointAt (0) : -1;
      if (!special && !((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff))) return -1;
      z.sent.push (mods ? `${key}+${mods}` : key);
      return 0;
    },
    _gk_sim_key_up: () => {},
  };
  return z;
}

function setup (options = {}) {
  const z = stubMachine ();
  const warnings = [], logs = [];
  const keys = new TextInput (z, { ...options, warn: (w) => warnings.push (w), log: (l) => logs.push (l) });
  return { z, keys, warnings, logs };
}

const key = (k, more = {}) => ({ key: k, code: "Key" + k, repeat: false, shiftKey: false, ctrlKey: false,
  altKey: false, metaKey: false, isComposing: false, altGraph: false, ...more });

{
  // a plain letter: keydown leaves it to the textarea, input types it once
  const { z, keys } = setup ();
  check ("letter keydown not prevented", keys.keydown (key ("a")), false);
  check ("letter input empties the textarea", keys.input ({ inputType: "insertText" }, "a"), true);
  keys.keyup (key ("a"));
  check ("letter typed once", z.sent, ["a"]);
}
{
  // a dead key with composition events (Chrome): " then a is ä
  const { z, keys } = setup ();
  check ("dead keydown", keys.keydown (key ("Dead", { code: "Quote", shiftKey: true })), false);
  keys.compositionstart ();
  check ("composing input waits", keys.input ({ isComposing: true, inputType: "insertCompositionText" }, "\""), false);
  check ("next keydown while composing", keys.keydown (key ("a", { isComposing: true })), false);
  check ("compositionend", keys.compositionend ("ä"), true);
  // Safari sends an input after compositionend; the textarea is empty by then
  check ("input after compositionend", keys.input ({ inputType: "insertText" }, ""), true);
  check ("dead key and a: ä once", z.sent, ["ä"]);
}
{
  // a dead key without composition (Firefox on Linux): input "ä" directly;
  // and the quote itself: dead key, then space
  const { z, keys } = setup ();
  keys.keydown (key ("Dead", { code: "Quote", shiftKey: true }));
  keys.keydown (key ("a"));
  keys.input ({ inputType: "insertText" }, "ä");
  keys.keydown (key ("Dead", { code: "Quote", shiftKey: true }));
  keys.keydown (key (" ", { code: "Space" }));
  keys.input ({ inputType: "insertText" }, "\"");
  check ("dead keys without composition", z.sent, ["ä", "\""]);
}
{
  // the earlier cases: ç á ã, typed by an ABNT2 or US-international layout
  const { z, keys, warnings } = setup ();
  for (const c of ["ç", "á", "ã", "Ç", "É"]) {
    keys.keydown (key (c));
    keys.input ({ inputType: "insertText" }, c);
  }
  check ("ç á ã", z.sent, ["ç", "á", "ã", "Ç", "É"]);
  check ("no warning for Latin-1", warnings, []);
}
{
  // AltGr: Windows reports Ctrl+Alt with it, Linux AltGraph; both are text
  const { z, keys, warnings } = setup ();
  check ("AltGr+2 keydown", keys.keydown (key ("²", { ctrlKey: true, altKey: true, altGraph: true })), false);
  keys.input ({ inputType: "insertText" }, "²");
  check ("AltGr+e (€) keydown", keys.keydown (key ("€", { ctrlKey: true, altKey: true, altGraph: true })), false);
  keys.input ({ inputType: "insertText" }, "€");
  keys.input ({ inputType: "insertText" }, "€");
  check ("AltGr: ² typed, € dropped", z.sent, ["²"]);
  check ("one warning for what is dropped", warnings.length, 1);
}
{
  // macOS: Option+e is a dead acute, Option+2 is ™ (dropped): text, not Alt
  const { z, keys } = setup ({ mac: true });
  check ("Option+Dead", keys.keydown (key ("Dead", { altKey: true })), false);
  keys.compositionstart ();
  keys.compositionend ("é");
  check ("Option+letter is text on a Mac", keys.keydown (key ("å", { altKey: true })), false);
  keys.input ({ inputType: "insertText" }, "å");
  check ("mac Option", z.sent, ["é", "å"]);
}
{
  // special keys and shortcuts come from keydown, and are prevented
  const { z, keys } = setup ();
  check ("Enter", keys.keydown (key ("Enter")), true);
  keys.keyup (key ("Enter"));
  check ("Shift+Tab", keys.keydown (key ("Tab", { shiftKey: true })), true);
  check ("Backspace", keys.keydown (key ("Backspace")), true);
  check ("repeat of a held key", keys.keydown (key ("Backspace", { repeat: true })), true);
  check ("ArrowDown", keys.keydown (key ("ArrowDown")), true);
  check ("Ctrl+C", keys.keydown (key ("c", { ctrlKey: true })), true);
  check ("Alt+x (Linux, Windows)", keys.keydown (key ("x", { altKey: true })), true);
  check ("Meta (the Windows key)", keys.keydown (key ("Meta")), true);
  check ("Shift alone is not prevented", keys.keydown (key ("Shift", { shiftKey: true })), false);
  check ("F12 is the browser's", keys.keydown (key ("F12")), false);
  check ("specials sent", z.sent, ["Enter", `Tab+${MOD_SHIFT}`, "Backspace", "ArrowDown", `c+${MOD_CTRL}`,
    `x+${MOD_ALT}`, "Meta"]);
}
{
  // paste: Ctrl+V left to the browser; the text typed, without the last
  // newline; the input event that a paste can bring is not typed again
  const { z, keys, logs } = setup ();
  check ("Ctrl+V not prevented", keys.keydown (key ("v", { ctrlKey: true })), false);
  keys.paste ("ms12 ç\r\nok\n");
  check ("paste's input", keys.input ({ inputType: "insertFromPaste" }, "ms12 ç\nok"), true);
  check ("pasted", z.sent, ["m", "s", "1", "2", " ", "ç", "Enter", "o", "k"]);
  check ("paste logged", logs, ["pasted 9 characters"]);
  keys.paste ("€uro");
  check ("paste of a dropped character", logs[1], "pasted 3 of 4 characters (GapKeep types ASCII and Latin-1 only)");
}
{
  // a phone's keyboard (Android): keys as "Unidentified", Backspace only as an
  // edit of the (empty) textarea; while composing a word, the edit is the word's
  const { z, keys } = setup ();
  check ("Unidentified keydown left alone", keys.keydown (key ("Unidentified")), false);
  check ("deleteContentBackward is Backspace", keys.beforeinput ({ inputType: "deleteContentBackward" }), true);
  check ("other edits left to input", keys.beforeinput ({ inputType: "insertText" }), false);
  keys.compositionstart ();
  check ("composing: the word's", keys.beforeinput ({ isComposing: true, inputType: "deleteContentBackward" }), false);
  keys.compositionend ("");
  check ("phone Backspace sent once", z.sent, ["Backspace"]);
}
{
  // an input method's word, and an emoji: composition gives the text
  const { z, keys, warnings } = setup ();
  keys.compositionstart ();
  keys.input ({ isComposing: true, inputType: "insertCompositionText" }, "na");
  keys.compositionend ("não");
  keys.input ({ inputType: "insertText" }, "🙂");
  check ("IME word", z.sent, ["n", "ã", "o"]);
  check ("emoji warned", warnings.length, 1);
}

// --- 2. end to end ---------------------------------------------------------------

const build = fileURLToPath (new URL ("../../sim/build/web/gksim-test.js", import.meta.url));
if (!existsSync (build)) {
  console.log ("SKIP end to end: no sim/build/web/gksim-test.js (make -C sim web TEST=1)");
} else {
  const log = [];
  const gk = await Gapkeep.create ({ moduleUrl: pathToFileURL (build).href, onLog: (line) => log.push (line) });
  gk.boot (640, 480);
  gk.start ();
  const until = async (re, ms = 10000) => {
    for (const end = Date.now () + ms; Date.now () < end; await new Promise ((r) => setTimeout (r, 20))) {
      const line = log.find ((l) => re.test (l));
      if (line) return line;
    }
    return null;
  };
  check ("launcher", !!(await until (/launcher ready/)), true);
  gk.launch ("typetest");
  check ("typetest", !!(await until (/typetest ready/)), true);
  const keys = new TextInput (gk, { warn: () => {}, log: () => {} });
  const typed = async (want) => {
    keys.keydown (key ("Enter"));
    keys.keyup (key ("Enter"));
    const re = new RegExp ("typetest: typed " + want.replace (/\+/g, "\\+") + " \\(");
    return (await until (re)) !== null;
  };
  // ç, then a dead key's ä (composition), AltGr's ², and a letter
  for (const c of ["ç"]) { keys.keydown (key (c)); keys.input ({ inputType: "insertText" }, c); }
  keys.keydown (key ("Dead")); keys.compositionstart (); keys.compositionend ("ä");
  keys.keydown (key ("²", { ctrlKey: true, altKey: true, altGraph: true })); keys.input ({ inputType: "insertText" }, "²");
  keys.keydown (key ("x")); keys.input ({ inputType: "insertText" }, "x");
  await new Promise ((r) => setTimeout (r, 300));
  check ("typed ç ä ² x", await typed ("U+00E7 U+00E4 U+00B2 U+0078"), true);
  keys.paste ("á ã\n");
  await new Promise ((r) => setTimeout (r, 500));
  check ("pasted á ã", await typed ("U+00E1 U+0020 U+00E3"), true);
  gk.stop ();
}

console.log (`textinput: ${passed} passed, ${failed} failed`);
process.exit (failed ? 1 : 0);
