// textinput.js - the IDE's keyboard for zerogap's screen, without the DOM:
// what to do with each keyboard, input, composition and paste event. ide.js
// feeds it the events of a hidden <textarea> that has the focus while the
// person types into the screen (the way terminals in browsers do it, as
// xterm.js); tests/web/textinput.mjs feeds it plain objects under Node.
//
// Two paths, and each key takes one of them, never both:
//
//  - Text (printable characters) comes only from the textarea's input
//    events and compositionend: the OS's layout, dead keys (" then a is ä),
//    AltGr and input methods all happen before the browser reports it, and
//    a dead key's keydown says only "Dead". A keydown that would type a
//    character is left alone (no preventDefault) so that the textarea gets
//    it; it is not sent from keydown, or it would be typed twice.
//  - Everything else comes from keydown: Enter, Tab, arrows, Backspace,
//    Escape, Home, End, Delete, F keys, the Windows/Meta key, and Ctrl or
//    Alt with a key (shortcuts for apps; but AltGr, which Windows reports as
//    Ctrl+Alt, and macOS's Option, type characters: those are text).
//
// Text is typed as key presses at once, in order with the special keys
// (printable ASCII and Latin-1, newlines as Enter, tabs as Tab); a paste,
// which can be long, through Zerogap.type, which paces it. What zerogap
// can't type is dropped, with one warning.
// Held text keys repeat as the OS repeats them (each repeat is an input
// event); held special keys repeat in zerogap, as on the device.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export const MOD_SHIFT = 1, MOD_CTRL = 2, MOD_ALT = 4;

// Keys whose browser default (scroll, leave the screen, go back, edit the
// textarea...) must not happen while the screen has the keyboard.
export const BROWSER_KEYS = new Set (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace",
  " ", "Enter", "Escape", "Home", "End", "PageUp", "PageDown", "F1", "F3", "F5", "F6", "F7", "Delete"]);

// One character (one code point), as KeyboardEvent.key gives a printable key
const isChar = (key) => [...key].length === 1;

export class TextInput {
  // machine: { keyDown (key, mods) -> bool, keyUp (), type (text) -> number of keys typed }
  // options.mac: Option types characters (as AltGr elsewhere)
  // options.warn (message): called once, the first time text is dropped
  // options.log (message): for pastes
  constructor (machine, options = {}) {
    this.machine = machine;
    this.mac = !!options.mac;
    this.warn = options.warn || (() => {});
    this.log = options.log || (() => {});
    this.heldCode = null;       // the special key zerogap is repeating
    this.composing = false;
    this.warned = false;
  }

  // ev: { key, code, repeat, shiftKey, ctrlKey, altKey, metaKey, altGraph }.
  // Returns true if the browser's default must be prevented.
  keydown (ev) {
    const m = this.machine;
    if (!m || ev.isComposing || ev.key === "Process" || ev.key === "Dead") return false;   // text, later
    const altGr = !!ev.altGraph || (this.mac && ev.altKey && !ev.ctrlKey && !ev.metaKey);
    const ctrl = (ev.ctrlKey || ev.metaKey) && !altGr;
    const alt = ev.altKey && !altGr;

    // Ctrl+V (Cmd+V): the browser pastes into the textarea, see paste()
    if (ctrl && !alt && ev.key.toLowerCase () === "v") return false;
    // a character, without Ctrl or Alt: the input event types it
    if (isChar (ev.key) && !ctrl && !alt) return false;

    if (ev.repeat) return true;   // zerogap repeats keys itself
    const mods = (ev.shiftKey ? MOD_SHIFT : 0) | (ctrl ? MOD_CTRL : 0) | (alt ? MOD_ALT : 0);
    if (m.keyDown (ev.key, mods)) {
      this.heldCode = ev.code;
      return true;
    }
    return BROWSER_KEYS.has (ev.key) || ctrl || alt;
  }

  keyup (ev) {
    // zerogap has one key down at a time: release it only when that key is
    // let go (not, say, the Shift that came with it)
    if (this.machine && ev.code === this.heldCode) {
      this.machine.keyUp ();
      this.heldCode = null;
    }
  }

  // the screen lost the keyboard
  blur () {
    if (this.heldCode) this.machine?.keyUp ();
    this.heldCode = null;
    this.composing = false;
  }

  compositionstart () {
    this.composing = true;
  }

  // ev: { isComposing, inputType }; value: the textarea's text. Returns
  // true if the textarea must be emptied now.
  input (ev, value) {
    if (this.composing || ev.isComposing) return false;   // compositionend has it
    if (ev.inputType === "insertFromPaste") return true;  // paste() typed it
    this.text (value);
    return true;
  }

  // value: the textarea's text once composed (dead key and letter, an
  // input method's word). Returns true: empty the textarea.
  compositionend (value) {
    this.composing = false;
    this.text (value);
    return true;
  }

  // A paste's text (the clipboard's): typed, without the newline that
  // copying a whole line brings.
  paste (text) {
    text = text.replace (/[\r\n]+$/, "").replace (/\r\n?/g, "\n");
    const n = this.text (text, true);
    this.log (n === [...text].length ? `pasted ${n} characters`
      : `pasted ${n} of ${[...text].length} characters (zerogap types ASCII and Latin-1 only)`);
  }

  // Types text: at once, or paced (a paste). The number of keys typed.
  text (value, paced = false) {
    if (!value || !this.machine) return 0;
    let n = 0;
    if (paced) {
      n = this.machine.type (value);
    } else {
      for (const c of value) {
        const k = c === "\n" ? "Enter" : c === "\t" ? "Tab" : c;
        const code = c.codePointAt (0);
        if (k === c && !((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff))) continue;
        if (this.machine.keyDown (k, 0)) n++;
        this.machine.keyUp ();
      }
    }
    if (n < [...value].length && !this.warned) {
      this.warned = true;
      this.warn ("zerogap types ASCII and Latin-1 only (á, ç, £...): other characters are dropped");
    }
    return n;
  }
}
