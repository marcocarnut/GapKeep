// Copied from DigiMacroAsm by tools/extract_digimacro.py - do not edit.
// Source: web/table.js (sha256 0a5462c27f92f5eaa1007613b8995ba289f1c7531e8027da93edf936c2b3f07b), DigiMacroAsm commit b37194a97ee9c862b701ef2977ed06d6b395c2ad.
// DigiMacro is GPL; the code between this header and the export line is
// copied verbatim (as a module its module.exports line is skipped).

/* table.js -- macros as text, and as the bytes DigiMacro plays.
 *
 * The one original: the app loads it in the browser, and test/run.sh loads it
 * in node and plays what it encodes against the real firmware. The table is
 * the interface between the two halves of this project, so the app's encoder
 * and the firmware's decoder are checked against each other rather than each
 * being trusted on its own.
 *
 * Keep the escape values in step with DigiMacro.ino; test/webtable.js reads
 * them out of it and checks. Note that 0x04 is NOT free: it is the usage for
 * "a". The escapes live in 0x01 to 0x03, which are states a keyboard reports
 * rather than keys anyone presses, the same three with bit 7 set, and 0x80
 * -- Shift and no key at all -- and all seven are now taken.
 */

const ESC_PAUSE  = 0x01;    /* nn tenths of a second */
const ESC_MOD    = 0x02;    /* a HID modifier mask, for the next keystroke */
const ESC_REPEAT = 0x03;    /* press the previous keystroke nn more times */
const ESC_JUMP   = 0x81;    /* carry on with the macro whose header is arg-1:
                               plus one because a zero byte ends a macro, and
                               the header of "." is zero */
const ESC_MARK   = 0x82;    /* the repeat after this goes back to here */
const ESC_HOST   = 0x83;    /* stop unless the host has proved itself: */
const HOST_SILENT = 1;      /* ...quietly, {host} */
const HOST_LOUD   = 2;      /* ...as if the code were not there, {host!} */
/* {host}'s other arguments are the mouse's: 1xxxxxxx x, 01yyyyyy y and the
   move, and 001c00bb the buttons -- b the ones down now, c to let them up
   again after, which is a click. None down is a release. 000ySSSS, 3 and
   up, is the next move's scale on x or y: S counts a report, 4 by default. */
const PTR_BUTTONS = { 'click': 0x31, 'right-click': 0x32, 'hold': 0x21,
                      'right-hold': 0x22, 'release': 0x20, 'right-release': 0x20 };
const PTR_NAMES = {};
for (const [n, v] of Object.entries(PTR_BUTTONS)) if (!(v in PTR_NAMES)) PTR_NAMES[v] = n;

/* {x,y}, in percent of the screen, and back: x in 128 steps, y in 64, which
   is about square on a 16:9 screen. A move to 0 goes the whole way, so {0,0}
   puts the cursor in the corner wherever it was. A step reads back as a
   whole percent that makes it, where one does -- a round one if it can, since
   y's 64 steps take two or three each and {50,50} should stay {50,50} -- and
   to a decimal otherwise. */
const ptrBytes = (x, y) => [ESC_HOST, 0x80 | Math.round(x * 1.27),
                            ESC_HOST, 0x40 | Math.round(y * 0.63)];
const ptrScale = (a, y) => { const s = Math.round(a * 4);
                             return s === 4 ? [] : [ESC_HOST, (y ? 0x10 : 0) | s]; };
const ptrPct = (v, steps) => {
  const near = v * 100 / steps, all = [];
  for (let n = Math.floor(near) - 2; n <= Math.ceil(near) + 2; n++)
    if (n >= 0 && n <= 100 && Math.round(n * steps / 100) === v) all.push(n);
  if (!all.length) return String(Math.round(v * 1000 / steps) / 10);
  const rank = n => (n % 10 ? n % 5 ? 2 : 1 : 0) * 1000 + Math.abs(n - near);
  return String(all.reduce((a, b) => rank(b) < rank(a) ? b : a));
};
const ESC_IR     = 0x80;    /* where the remote's button starts: a, c, x --
                               three bytes, each with bit 7 set, since the
                               button's address and command may be zero */
const SHIFT      = 0x80;    /* in a stored keystroke */
const TOTP_MARK  = 0x7F;    /* {totp}: 0x80 then this, which no {IR} byte can be */
const TOTP_BYTES = 40;      /* ...then the HMAC midstates, see totpBlob() */
const FW_TOTP    = 18;      /* the firmware that knows them */

/* {IR a c} as the table holds it, and back */
const irBytes = (a, c) => [ESC_IR, a | 0x80, c | 0x80,
                           0x80 | (a >> 7) | ((c >> 7) << 1)];
const irButton = (b, i) => [(b[i] & 0x7F) | ((b[i + 2] & 1) << 7),
                            (b[i + 1] & 0x7F) | ((b[i + 2] & 2) << 6)];
const irHex = v => v.toString(16).padStart(2, '0');

/* LEARN: the board types the button as "a c" in hex, straight from usages,
   so a keyboard layout that puts other characters on the digits would type
   something else. Read by key position instead, as KeyboardEvent.code has it,
   and turned into what goes in a macro once both bytes are there. */
const irKeyChar = code => {
  const m = /^(?:Digit|Numpad)([0-9])$|^Key([A-F])$/.exec(code);
  return m ? (m[1] || m[2].toLowerCase()) : code === 'Space' ? ' ' : null;
};
const irHeard = text => {
  const m = /^\s*([0-9a-f]{2})\s*([0-9a-f]{2})\s*$/i.exec(text);
  return m ? `{IR ${m[1].toLowerCase()} ${m[2].toLowerCase()}}` : null;
};

/* How many bytes the thing at b[i] takes: a keystroke or a mark one, an
   {IR} four, any other escape two. Everything that walks a macro walks it
   with this, since an argument can be any byte at all. */
const escStep = (b, i) => b[i] === ESC_IR ? (b[i + 1] === TOTP_MARK ? 2 + TOTP_BYTES : 4)
                     : (b[i] & 0x7F) < 0x04 && b[i] !== ESC_MARK ? 2 : 1;
const isTotp = (b, i) => b[i] === ESC_IR && b[i + 1] === TOTP_MARK;

/* ==================================================================== */
/* Secrets                                                              */
/* ==================================================================== */

/* {secret} keeps the rest of a macro encrypted: the board types it only while
 * a host's client has given it the key, which it holds in RAM and never
 * stores. As the table holds it:
 *
 *      0x81 hh  n0 n1 n2 n3  c0 ... ck  0x00
 *
 * 0x81 hh is a jump to a code no macro can have -- hh-1 is an end header --
 * so firmware from before secrets ends the macro there and types nothing.
 * hh = 0xFE is {secret}, which stops quietly without the key; 0xFF is
 * {secret!}, which stops as if the code were not there.
 *
 * n is the nonce, new each time the secret is sealed, and never zero: block 0
 * of nonce 0 is the check value below. c is the rest of the macro and a zero
 * of its own, encrypted: XTEA, in counter mode, byte j being the plain byte
 * XOR the first byte of XTEA_K(nonce, j), both words little-endian -- a
 * block a byte, which spares the firmware a cache it has no room for. j is
 * one byte there, so a secret is at most 256 bytes, its zero included.
 * Decrypted, the zero ends the macro, as in plain text.
 *
 * There is no length: the nonce is drawn again until nonce and ciphertext
 * hold no zero and no {IR} where a walk would look, and a walk with the
 * escape rules lands exactly on the terminator. So everything that walks a
 * table -- this file, the firmware, and both as they were before secrets --
 * keeps its place without knowing anything about them.
 *
 * The board tells the right key from a wrong one by the check value,
 * x = XTEA_K(0, 0), at CHECK_ADDR -- where v2's host key was, {host} having
 * gone: a {secret} at the start of a macro is all it was, and more.
 */
const SECRET_QUIET = 0xFE;  /* the jump's argument: {secret} */
const SECRET_LOUD  = 0xFF;  /* ...and {secret!} */
const JUMP_CLEAR   = 0xF7;  /* ...and {clear}: 0xF6 would be seven symbols */
const JUMP_ALONE   = 0xF6;  /* ...and after ESC_MOD, those modifiers pressed
                               with no key: {Gui}. 0xF5 would be six */
const CHECK_ADDR   = 0x1E4; /* the check value's eight bytes, in EEPROM */
const SECRET_MAX   = 255;   /* keystrokes in a secret */
const isSecret = (b, i) => b[i] === ESC_JUMP &&
                           (b[i + 1] === SECRET_QUIET || b[i + 1] === SECRET_LOUD);

const le32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;

/* XTEA, 32 cycles, encrypt only: counter mode never decrypts. Eight bytes and
   a sixteen-byte key in, eight bytes out, every word little-endian, as the
   firmware's xtea() takes them. */
function xtea(v, k) {
  const key = [le32(k, 0), le32(k, 4), le32(k, 8), le32(k, 12)];
  let v0 = le32(v, 0), v1 = le32(v, 4), sum = 0;
  for (let n = 0; n < 32; n++) {
    v0 = (v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + key[sum & 3]))) >>> 0;
    sum = (sum + 0x9E3779B9) >>> 0;
    v1 = (v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + key[(sum >>> 11) & 3]))) >>> 0;
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < 4; i++) { out[i] = v0 >>> (8 * i); out[i + 4] = v1 >>> (8 * i); }
  return out;
}

const keyCheck = key => xtea(new Uint8Array(8), key);

/* bytes XOR the keystream of nonce (four bytes), from byte 0 */
function secretXor(key, nonce, bytes) {
  const block = new Uint8Array(8);
  return Uint8Array.from(bytes, (b, j) => {
    block.set(nonce, 0);
    block[4] = j; block[5] = block[6] = block[7] = 0;
    return b ^ xtea(block, key)[0];
  });
}

/* Whether a walk with the escape rules, starting at b[0], sees no zero and no
   {IR} and stops exactly at the end. */
function walkSafe(b) {
  if (b.includes(0)) return false;
  let i = 0;
  while (i < b.length) {
    if (b[i] === ESC_IR) return false;
    i += escStep(b, i);
  }
  return i === b.length;
}

const randomBytes = n => (globalThis.crypto || require('crypto').webcrypto)
                           .getRandomValues(new Uint8Array(n));

/* The rest of a macro, as keystrokes -> nonce and ciphertext. `random` is
   for the tests. */
function sealSecret(key, plain, random = randomBytes) {
  if (plain.length > SECRET_MAX) fail('secret-too-long', { n: plain.length, max: SECRET_MAX });
  const p = Uint8Array.from([...plain, 0]);
  for (let tries = 0; tries < 1 << 16; tries++) {
    const nonce = random(4);        /* never zero: walkSafe() refuses any
                                       zero byte, the nonce's included */
    const blob = Uint8Array.from([...nonce, ...secretXor(key, nonce, p)]);
    if (walkSafe(blob)) return [...blob];
  }
  fail('secret-no-nonce');
}

/* ...and back: the keystrokes, or null unless exactly the last byte is the
   zero, which a wrong key almost never gives. */
function openSecret(key, blob) {
  const p = secretXor(key, blob.slice(0, 4), blob.slice(4));
  /* its own zero is the first one a walk meets: not any in a {totp}'s forty */
  let i = 0;
  while (i < p.length && p[i]) i += escStep(p, i);
  return i === p.length - 1 ? [...p.slice(0, -1)] : null;
}

const AUTO_ADDR  = 0x1F3;   /* the macro to type when the board is plugged
                               in, as a header byte; anything impossible as
                               one means nothing is set */
const AUTO_NONE  = 0xFF;
const TABLE_TOP  = 0x1E0;   /* the firmware stops walking here: 480,
                               leaving 32 for the serial number, the host
                               key, the lockout, the power-on macro and the
                               password */
const MAX_SYM    = 5;

/* ==================================================================== */
/* The layouts                                                          */
/* ==================================================================== */

/* What each key types, as the host's layout has it: character -> usage.
   Letters and digits sit where they do on all of these, so only the rest is
   listed. ALTGR is what Right Alt reaches -- AltGr, where a layout has one. */
const US_PLAIN = {' ': 0x2C, '-': 0x2D, '=': 0x2E, '[': 0x2F, ']': 0x30,
               '\\': 0x31, ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36,
               '.': 0x37, '/': 0x38, '\n': 0x28, '\t': 0x2B, '\b': 0x2A};
const US_SHIFTED = {'!': 0x1E, '@': 0x1F, '#': 0x20, '$': 0x21, '%': 0x22,
                 '^': 0x23, '&': 0x24, '*': 0x25, '(': 0x26, ')': 0x27,
                 '_': 0x2D, '+': 0x2E, '{': 0x2F, '}': 0x30, '|': 0x31,
                 ':': 0x33, '"': 0x34, '~': 0x35, '<': 0x36, '>': 0x37,
                 '?': 0x38};

/* Brazil's ABNT2. Its own "/?" key, right of ";", is usage 0x87, and the
   board's keyboard only goes to 0x65 -- a stored keystroke keeps Shift in
   bit 7 besides. So "/" comes from the keypad, which types it on any layout,
   and "?" from AltGr+W, which ABNT2 prints on the key for the same reason:
   keyboards without that key. "]" is the key beside Enter, which a real
   ABNT2 keyboard sends as 0x32; hosts take 0x31 for the same key. */
const ABNT2_PLAIN = {' ': 0x2C, "'": 0x35, '-': 0x2D, '=': 0x2E, '´': 0x2F,
               '[': 0x30, ']': 0x32, 'ç': 0x33, '~': 0x34, '\\': 0x64,
               ',': 0x36, '.': 0x37, ';': 0x38, '/': 0x54,
               '\n': 0x28, '\t': 0x2B, '\b': 0x2A};
const ABNT2_SHIFTED = {'"': 0x35, '!': 0x1E, '@': 0x1F, '#': 0x20, '$': 0x21,
                 '%': 0x22, '¨': 0x23, '&': 0x24, '*': 0x25, '(': 0x26,
                 ')': 0x27, '_': 0x2D, '+': 0x2E, '`': 0x2F, '{': 0x30,
                 '}': 0x32, 'Ç': 0x33, '^': 0x34, '|': 0x64, '<': 0x36,
                 '>': 0x37, ':': 0x38};
const ABNT2_ALTGR = {'?': 0x1A, '°': 0x08, '§': 0x2E, 'ª': 0x30,
                 'º': 0x32, '¹': 0x1E, '²': 0x1F, '³': 0x20,
                 '£': 0x21, '¢': 0x22, '¬': 0x23};

/* Keys that are not characters, so they can be named rather than numbered.
   "Break" rather than "Pause", because {pause 1.5} is a wait. */
const NAMED = {
  enter: 0x28, esc: 0x29, backspace: 0x2A, tab: 0x2B, space: 0x2C,
  capslock: 0x39,
  f1: 0x3A, f2: 0x3B, f3: 0x3C, f4: 0x3D, f5: 0x3E, f6: 0x3F,
  f7: 0x40, f8: 0x41, f9: 0x42, f10: 0x43, f11: 0x44, f12: 0x45,
  printscreen: 0x46, scrolllock: 0x47, break: 0x48,
  insert: 0x49, home: 0x4A, pgup: 0x4B, delete: 0x4C, end: 0x4D, pgdn: 0x4E,
  right: 0x4F, left: 0x50, down: 0x51, up: 0x52, menu: 0x65,
};

/* The spellings people actually reach for. The canonical name is what a
   table decodes back to; these are only accepted on the way in. */
const KEY_ALIAS = { del: 'delete', ins: 'insert', escape: 'esc',
                    return: 'enter', pageup: 'pgup', pagedown: 'pgdn',
                    spacebar: 'space', bksp: 'backspace', prtsc: 'printscreen' };

const MODS = { ctrl: 0x01, shift: 0x02, alt: 0x04, gui: 0x08,
               rctrl: 0x10, rshift: 0x20, ralt: 0x40, rgui: 0x80 };
const MOD_ALIAS = { control: 'ctrl', win: 'gui', cmd: 'gui', meta: 'gui',
                    super: 'gui', option: 'alt', altgr: 'ralt' };

const UNNAMED = {};
for (const [n, u] of Object.entries(NAMED))   if (!(u in UNNAMED)) UNNAMED[u] = n;

/* ==================================================================== */
/* What it says when something is wrong                                 */
/* ==================================================================== */

/* These reach the person editing the macro, so the app translates them. The
   default is English and the tests read it, which is why the text lives here
   rather than in the app: a message with no default would be a message no
   test could assert on. */
const MSG = {
  'lone-backslash':  () => 'a lone \\ at the end',
  'bad-escape':      p => `\\${p.what} means nothing`,
  'unclosed':        () => 'a { with no }',
  'empty-braces':    () => '{} is empty',
  'pause-range':     p => `{${p.what}}: a pause runs from 0.1 to 25.5 seconds`,
  'point-range':     p => `{${p.what}}: the pointer goes from 0 to 100, in percent `
                         + `of the screen`,
  'point-scale':     p => `{${p.what}}: a scale runs from 0.75 to 3.75, in quarters`,
  'repeat-range':    p => `{${p.what}}: a repeat runs from 1 to 256`,
  'nothing-to-rep':  p => `{${p.what}}: nothing to repeat yet`,
  'group-empty':     () => '() has nothing in it',
  'nested-repeat':   () => 'a count inside a group: the firmware has one mark, '
                         + 'so the inner count would take the outer one over',
  'goto-nowhere':    p => `{goto ${p.what}}: there is no macro with that code`,
  'ir-button':       p => `{${p.what}}: a remote's button is {IR} and two bytes `
                         + `in hex, as in {IR 00 45}`,
  'loop-empty':      p => `${p.what}: these only jump to each other and never `
                         + `type or pause, so the firmware would give up on `
                         + `them rather than run them`,
  'no-key-after':    p => `{${p.what}}: no key after the +`,
  'not-a-modifier':  p => `"${p.what}" is not a modifier`,
  'not-a-key':       p => `"${p.what}" is not a key`,
  'no-key-for':      p => `no key for "${p.what}"`,
  'needs-dead-keys': p => `"${p.what}" needs a keyboard with dead keys -- see ` +
                          `the keyboard setting beside Macros`,
  'not-a-code':      p => `not a code: "${p.what}"`,
  'code-twice':      p => `"${p.what}" is used twice`,
  'not-a-byte':      p => `"${p.what}" has a byte that is not a byte`,
  'has-a-zero':      p => `"${p.what}" contains a zero, which would end it early`,
  'too-big':         p => `${p.n} bytes of table, and only ${p.fits} fit`,
  'secret-no-key':   () => '{secret} needs the key, to encrypt what follows it',
  'secret-twice':    () => 'one {secret} per macro: everything after the first '
                         + 'is secret already',
  'secret-in-group': () => 'a {secret} inside a group: it takes the rest of the '
                         + 'macro, so it cannot be repeated',
  'secret-ir':       () => 'an {IR} after a {secret}: the remote could not find '
                         + 'its button in encrypted text',
  'secret-sealed-last': () => 'nothing can follow a sealed {secret}: it is the '
                         + 'rest of the macro already',
  'secret-blob':     () => 'a sealed {secret} that is not one: it was changed '
                         + 'since it was read',
  'secret-too-long': p => `a secret of ${p.n} keystrokes: at most ${p.max} fit`,
  'host-gone':       () => '{host} is gone: put {secret} where it was, and the '
                         + 'rest of the macro is encrypted as well as guarded',
  'secret-wrong-key':() => 'this is not the key these secrets were sealed with',
  'secret-no-nonce': () => 'no nonce would seal this secret -- try again',
  'totp-blob':       () => 'a {totp @...} must be 80 hex digits: it was changed '
                         + 'since it was read from the board',
  'totp-base32':     p => `{totp ${p.what}}: a secret is base32, letters A-Z and `
                         + 'digits 2-7, as an authenticator app shows it',
  'totp-empty':      () => '{totp} needs the secret: {totp ABCD EFGH ...}',
};

let translate = null;
/* base32, as authenticator apps give it: any case, spaces and padding ignored */
function base32(text) {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  if (!clean) fail('totp-empty');
  if (!/^[A-Z2-7]+$/.test(clean)) fail('totp-base32', { what: text });
  const out = [];
  let bits = 0, have = 0;
  for (const c of clean) {
    bits = (bits << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    have += 5;
    if (have >= 8) { out.push((bits >>> (have - 8)) & 0xFF); have -= 8; bits &= (1 << have) - 1; }
  }
  return out;
}

/* SHA-1's compression of one 64-byte block onto h (five big-endian words) */
function sha1Block(h, block) {
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const w = [];
  for (let t = 0; t < 16; t++)
    w[t] = ((block[t * 4] << 24) | (block[t * 4 + 1] << 16) | (block[t * 4 + 2] << 8) | block[t * 4 + 3]) >>> 0;
  for (let t = 16; t < 80; t++) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
  let [a, b, c, d, e] = h;
  for (let t = 0; t < 80; t++) {
    const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
    const k = [0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6][Math.floor(t / 20)];
    const n = (rol(a, 5) + (f >>> 0) + e + k + w[t]) >>> 0;
    e = d; d = c; c = rol(b, 30); b = a; a = n;
  }
  return [a, b, c, d, e].map((v, i) => (h[i] + v) >>> 0);
}

/* What the table holds for a {totp}: the midstates after the key's ipad and
   opad blocks (RFC 2104's precomputation), each reversed byte for byte, inner
   first. A key longer than a block is hashed first, as HMAC says. */
function totpBlob(keyBytes) {
  const IV = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  let key = [...keyBytes];
  if (key.length > 64) {                /* one or more blocks of SHA-1 */
    const msg = [...key, 0x80, ...new Array(((55 - key.length) % 64 + 64) % 64).fill(0)];
    const bits = key.length * 8;
    for (let i = 7; i >= 0; i--) msg.push(i > 3 ? 0 : (bits >>> (8 * i)) & 0xFF);
    let h = IV;
    for (let i = 0; i < msg.length; i += 64) h = sha1Block(h, msg.slice(i, i + 64));
    key = h.flatMap(v => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  }
  const pad = x => Array.from({ length: 64 }, (_, i) => (key[i] ?? 0) ^ x);
  const bytesOf = h => h.flatMap(v => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]).reverse();
  return [...bytesOf(sha1Block(IV, pad(0x36))), ...bytesOf(sha1Block(IV, pad(0x5C)))];
}

function setMessages(fn) { translate = fn; }
function fail(key, params = {}) {
  const s = translate && translate(key, params);
  throw new Error(s || MSG[key](params));
}

/* ==================================================================== */
/* Dead keys                                                            */
/* ==================================================================== */

/* The board sends scan codes, so what appears on screen is the host's
 * business, not ours. "o" is the key next to "i" whatever language anyone is
 * writing; "o-with-an-acute" is not a key at all. On a layout with dead keys
 * it is two presses -- the accent, then the letter -- and on a plain US
 * layout it cannot be typed at all.
 *
 * So the accent handling is a statement about the machine the board will be
 * plugged into, not about the text. Set the layout and accented characters
 * are accepted and expanded; leave it at plain US and they are refused, which
 * is better than silently typing something else.
 */
const US_DEAD = {
  "'": { base: 'aeiouycnszAEIOUYCNSZ', out: 'áéíóúýçńśźÁÉÍÓÚÝÇŃŚŹ' },
  '`': { base: 'aeiouAEIOU',           out: 'àèìòùÀÈÌÒÙ' },
  '^': { base: 'aeiouAEIOU',           out: 'âêîôûÂÊÎÔÛ' },
  '~': { base: 'anoANO',               out: 'ãñõÃÑÕ' },
  '"': { base: 'aeiouyAEIOUY',         out: 'äëïöüÿÄËÏÖÜŸ' },
};
/* ABNT2's accents have keys of their own, and its apostrophe and quote are
   only that. Ç has a key too, so it is never the acute and a c. */
const ABNT2_DEAD = {
  '´': { base: 'aeiouAEIOU', out: 'áéíóúÁÉÍÓÚ' },
  '`': { base: 'aeiouAEIOU', out: 'àèìòùÀÈÌÒÙ' },
  '^': { base: 'aeiouAEIOU', out: 'âêîôûÂÊÎÔÛ' },
  '~': { base: 'anoANO',     out: 'ãñõÃÑÕ' },
  '¨': { base: 'aeiouAEIOU', out: 'äëïöüÄËÏÖÜ' },
};

/* A layout: its keys, its dead keys, and the reverse of both, for turning
   a table back into something editable. */
function makeLayout(label, plain, shifted, altgr, dead) {
  const L = { label, plain, shifted, altgr, dead,
              unplain: {}, unshifted: {}, unaltgr: {}, compose: {} };
  for (const [c, u] of Object.entries(plain))   if (!(u in L.unplain)) L.unplain[u] = c;
  for (const [c, u] of Object.entries(shifted)) L.unshifted[u] = c;
  for (const [c, u] of Object.entries(altgr))   L.unaltgr[u] = c;
  for (let i = 0; i < 26; i++) L.unplain[0x04 + i] = String.fromCharCode(97 + i);
  for (let i = 0; i < 26; i++) L.unshifted[0x04 + i] = String.fromCharCode(65 + i);
  for (let i = 0; i < 9; i++)  L.unplain[0x1E + i] = String(i + 1);
  L.unplain[0x27] = '0';
  /* composed character -> [the dead key, the letter under it] */
  for (const [mark, m] of Object.entries(dead || {}))
    [...m.out].forEach((ch, i) => { L.compose[ch] = [mark, [...m.base][i]]; });
  return L;
}

const LAYOUTS = {
  'us':      makeLayout('US', US_PLAIN, US_SHIFTED, {}, null),
  'us-intl': makeLayout('US International', US_PLAIN, US_SHIFTED, {}, US_DEAD),
  'abnt2':   makeLayout('Brasil (ABNT2)', ABNT2_PLAIN, ABNT2_SHIFTED,
                        ABNT2_ALTGR, ABNT2_DEAD),
};
let layout = 'us';
function setLayout(name) { layout = name in LAYOUTS ? name : 'us'; }
function getLayout() { return layout; }
const L = () => LAYOUTS[layout];

/* Any accented character some layout can compose: on one that cannot, it is
   refused for want of dead keys rather than of a key. */
const COMPOSABLE = new Set(Object.values(LAYOUTS).flatMap(l => Object.keys(l.compose)));

/* one character -> [usage, the modifiers it needs] */
function charUsage(ch) {
  const l = L();
  if (ch >= 'a' && ch <= 'z') return [ch.charCodeAt(0) - 97 + 0x04, 0];
  if (ch >= 'A' && ch <= 'Z') return [ch.charCodeAt(0) - 65 + 0x04, MODS.shift];
  if (ch >= '1' && ch <= '9') return [ch.charCodeAt(0) - 49 + 0x1E, 0];
  if (ch === '0')             return [0x27, 0];
  if (ch in l.plain)          return [l.plain[ch], 0];
  if (ch in l.shifted)        return [l.shifted[ch], MODS.shift];
  if (ch in l.altgr)          return [l.altgr[ch], MODS.ralt];
  fail('no-key-for', { what: ch });
}

/* The bytes for one character's key: one, Shift in bit 7, or an AltGr
   character's three, the modifier said first. */
const keystroke = ch => {
  const [u, m] = charUsage(ch);
  return m === MODS.ralt ? [ESC_MOD, m, u] : [m ? u | SHIFT : u];
};

/* Plain text, nothing else. Bit 7 carries Shift, so one byte covers every
   character on the keyboard and the firmware needs no ASCII table.
   
   With dead keys, two things change. An accented character becomes the accent
   followed by the letter; and a bare accent mark becomes itself followed by a
   space, because that is how a dead-key layout is asked for the mark alone.
   To send one of those keys with nothing after it -- which is what a host does
   when the next character does not combine -- write it in braces: {'}. */
function usages(text) {
  const out = [];
  const l = L();
  for (const ch of text) {
    if (l.dead) {
      if (ch in l.compose) {
        const [mark, base] = l.compose[ch];
        out.push(...keystroke(mark), ...keystroke(base));
        continue;
      }
      if (ch in l.dead) { out.push(...keystroke(ch), ...keystroke(' ')); continue; }
    }
    if (!l.dead && COMPOSABLE.has(ch) && !(ch in l.plain || ch in l.shifted || ch in l.altgr))
      fail('needs-dead-keys', { what: ch });
    out.push(...keystroke(ch));
  }
  return out;
}

/* ==================================================================== */
/* Macro text -> bytes                                                  */
/* ==================================================================== */

/* The syntax, which is the app's whole user interface to a macro:
 *
 *    anything            typed as itself
 *    \n  \t  \\          newline, tab, backslash
 *    {{                  a literal {
 *    {Enter} {Left} {F5} a key that is not a character
 *    {Ctrl+c} {Alt+Tab}  modifiers on any key or character
 *    {pause 1.5}         wait, in seconds, 0.1 to 25.5
 *    x{11}               eleven of them, as a quantifier reads in a regular
 *                        expression -- eleven in all, not eleven more
 *    (ab){3}             ...of a whole group, rather than one thing
 *    {goto .-}           carry on with another macro, and never come back
 *    {clear}             forget the lockout's wrong codes, as the password does
 *    {Gui}  {Ctrl+Shift} modifiers alone, pressed with no key
 *    {IR 00 45}          where the remote's button 00 45 starts typing
 *    \(  \)              a parenthesis that is only a parenthesis
 *
 * The group exists because a keystroke stopped being a character. "ç" on a
 * dead-key keyboard is the accent and then the letter, so "ç{5}" asked to
 * repeat the letter and typed çcccc. The encoder now looks at what the count
 * is counting: one keystroke repeats as one keystroke, and anything longer
 * gets a mark in front of it so the firmware knows where to go back to. That
 * makes "ç{5}" work without anyone writing a group at all, and parentheses
 * are for when the repeated thing is more than one character.
 */
/* The first unescaped ")" after `from`, or -1. */
function closeParen(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === ')') return i;
  }
  return -1;
}
const REPEAT_NEXT = /^\{\s*x?\s*\d+\s*\}/;

/* `seal` turns the keystrokes after a {secret} into what the table holds
   (sealSecret with the key); without one, a {secret} can only be written
   already sealed, as {secret <hex>}. */
function encodeMacro(text, seal = null) {
  const out = [];
  let i = 0;

  /* Where in `out` the last thing that a count could count began, or -1.
     One byte repeats as one byte; anything longer needs a mark in front of
     it, which is inserted here once we know a count follows. */
  let unitAt = -1;

  /* Text pasted from elsewhere may carry its accents as separate combining
     marks -- "e" followed by U+0301 rather than a single "é" -- which looks
     identical and is not. Compose it first, so that what is looked up is what
     is on screen. */
  text = text.normalize('NFC');

  const push = (...b) => { for (const v of b) out.push(v); };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\') {                          /* the two-character escapes */
      const n = text[++i];
      if (n === undefined) fail('lone-backslash');
      const lit = { n: '\n', t: '\t', b: '\b', '\\': '\\',
                    '(': '(', ')': ')' }[n];
      if (lit === undefined) fail('bad-escape', { what: n });
      unitAt = out.length;
      push(...usages(lit));
      i++;
      continue;
    }

    if (ch === '{' && text[i + 1] === '{') {
      unitAt = out.length; push(...usages('{')); i += 2; continue;
    }

    /* "(" opens a group only when a count follows the matching ")". Anywhere
       else it is a parenthesis, which is what it is nine times in ten. */
    if (ch === '(') {
      const close = closeParen(text, i + 1);
      if (close >= 0 && REPEAT_NEXT.test(text.slice(close + 1))) {
        const inner = text.slice(i + 1, close);
        if (inner === '') fail('group-empty');
        const body = encodeMacro(inner, () => fail('secret-in-group'));
        /* The firmware keeps one mark, so a count inside a group would send
           the group's own repeat back to the wrong place. Refusing says so;
           emitting it would type something nobody asked for. */
        for (let j = 0; j < body.length; j += escStep(body, j)) {
          if (isSecret(body, j)) fail('secret-in-group');
          if (body[j] === ESC_REPEAT || body[j] === ESC_MARK)
            fail('nested-repeat');
        }
        unitAt = out.length;
        push(ESC_MARK);             /* explicit groups always get one, so that
                                       what comes back reads the same way */
        push(...body);
        i = close + 1;              /* the count is handled next time round */
        continue;
      }
    }

    if (ch === '{') {
      const end = text.indexOf('}', i);
      if (end < 0) fail('unclosed');
      const body = text.slice(i + 1, end).trim();
      i = end + 1;

      const pause = /^pause\s+([0-9]*\.?[0-9]+)$/i.exec(body);
      if (pause) {
        const tenths = Math.round(parseFloat(pause[1]) * 10);
        if (tenths < 1 || tenths > 255)
          fail('pause-range', { what: body });
        unitAt = out.length;
        push(ESC_PAUSE, tenths);
        continue;
      }

      /* {11} as well as {x11}: a bare count reads as a quantifier does in a
         regular expression, which is what it is. No key is a bare number --
         a digit is typed as itself -- so there is nothing to collide with. */
      const rep = /^x?\s*(\d+)$/i.exec(body);
      if (rep) {
        const n = parseInt(rep[1], 10);         /* how many in all */
        if (n < 1 || n > 256) fail('repeat-range', { what: body });
        if (unitAt < 0) fail('nothing-to-rep', { what: body });
        if (n > 1) {
          /* One byte is repeated as itself; anything longer needs the
             firmware told where it began. A group put its own mark in. */
          if (out.length - unitAt > 1 && out[unitAt] !== ESC_MARK)
            out.splice(unitAt, 0, ESC_MARK);
          push(ESC_REPEAT, n - 1);              /* the firmware counts MORE */
        }
        unitAt = -1;                            /* a count cannot count a count */
        continue;
      }

      /* The pointer: where it goes, and a click there */
      const num = '([0-9]*\\.?[0-9]+)', scaled = `${num}(?:\\s*\\*\\s*${num})?`;
      const at = new RegExp(`^${scaled}\\s*,\\s*${scaled}$`).exec(body);
      if (at) {
        const x = parseFloat(at[1]), y = parseFloat(at[3]);
        const a = at[2] ? parseFloat(at[2]) : 1, b = at[4] ? parseFloat(at[4]) : 1;
        if (x > 100 || y > 100) fail('point-range', { what: body });
        if ([a, b].some(v => v < 0.75 || v > 3.75)) fail('point-scale', { what: body });
        unitAt = out.length;
        push(...ptrScale(a, 0), ...ptrScale(b, 1), ...ptrBytes(x, y));
        continue;
      }
      const button = PTR_BUTTONS[body.toLowerCase()];
      if (button) {
        unitAt = out.length;
        push(ESC_HOST, button);
        continue;
      }

      /* v2's {host}: firmware 16 refuses every one, {secret} having taken
         its place. Read back, it still shows, so that it can be changed. */
      if (/^host!?$/i.test(body)) fail('host-gone');

      /* {secret}: the rest of the macro, sealed. It takes the rest, so it is
         the last thing here; and what it holds is never walked in the clear,
         so no remote's button can be found in it. A secret already sealed --
         read off a board by a page without the key -- comes back as its hex,
         and goes back as it came. */
      const secret = /^secret(!?)(?:\s+([0-9a-f]*))?$/i.exec(body);
      if (secret) {
        let blob;
        if (secret[2] !== undefined) {
          if (text.slice(i).trim() !== '') fail('secret-sealed-last');
          const h = secret[2];
          blob = h.length % 2 ? [] : h.match(/../g)?.map(x => parseInt(x, 16)) ?? [];
          if (blob.length < 5 || !walkSafe(blob)) fail('secret-blob');
        } else {
          if (!seal) fail('secret-no-key');
          const rest = encodeMacro(text.slice(i), () => fail('secret-twice'));
          for (let j = 0; j < rest.length; j += escStep(rest, j))
            if (rest[j] === ESC_IR && !isTotp(rest, j)) fail('secret-ir');
          blob = seal(rest);
        }
        push(ESC_JUMP, secret[1] ? SECRET_LOUD : SECRET_QUIET, ...blob);
        return out;
      }

      /* {totp SECRET}: the six digits an authenticator app shows for that
         base32 secret. A blob read back off a board comes back as {totp @hex}
         and goes back as it came: the secret itself cannot be recovered. */
      const totp = /^totp(?:\s+([^]*))?$/i.exec(body);
      if (totp) {
        const arg = (totp[1] ?? '').trim();
        if (arg[0] === '@') {
          const h = arg.slice(1);
          if (!/^[0-9a-f]{80}$/i.test(h)) fail('totp-blob');
          push(ESC_IR, TOTP_MARK, ...h.match(/../g).map(x => parseInt(x, 16)));
        } else {
          push(ESC_IR, TOTP_MARK, ...totpBlob(base32(arg)));
        }
        unitAt = -1;                            /* a repeat of it makes no sense */
        continue;
      }

      /* {IR a c}: the remote's button a c starts typing from here. Played
         through from the code, it is nothing. */
      if (/^ir(\s|\d|$)/i.test(body)) {
        const ir = /^ir\s+([0-9a-f]{1,2})\s+([0-9a-f]{1,2})$/i.exec(body);
        if (!ir) fail('ir-button', { what: body });
        push(...irBytes(parseInt(ir[1], 16), parseInt(ir[2], 16)));
        unitAt = -1;                            /* a place, not a thing */
        continue;
      }

      if (/^clear$/i.test(body)) {
        push(ESC_JUMP, JUMP_CLEAR);
        unitAt = -1;                            /* twice is once */
        continue;
      }

      const go = /^goto\s+([.-]+|ir\d+)$/i.exec(body);
      if (go) {
        push(ESC_JUMP, header(go[1]) + 1);
        unitAt = -1;                            /* nothing after it runs */
        continue;
      }

      /* the rest is [mod+]...key */
      const parts = body.split('+').map(p => p.trim()).filter(p => p !== '');
      if (parts.length === 0 && body !== '+') fail('empty-braces');

      /* "+" is both the separator and a key, so it has to be said twice to
         mean itself: {Ctrl++} is Ctrl and plus, while {Ctrl+} is a modifier
         with nothing to modify, which is a typo rather than a shortcut. */
      let keyName;
      if (body === '+' || body.endsWith('++')) keyName = '+';
      else if (body.endsWith('+')) fail('no-key-after', { what: body });
      else keyName = parts.pop();
      const modOf = m => MODS[MOD_ALIAS[m.toLowerCase()] || m.toLowerCase()];
      let mask = 0;
      for (const m of parts) {
        if (modOf(m) === undefined) fail('not-a-modifier', { what: m });
        mask |= modOf(m);
      }

      /* {Gui}, {Ctrl+Shift}: modifiers alone, pressed and let go, which a
         TV takes for its home screen and Windows for Start */
      if (keyName !== '+' && modOf(keyName) !== undefined) {
        unitAt = out.length;
        push(ESC_MOD, mask | modOf(keyName), ESC_JUMP, JUMP_ALONE);
        continue;
      }

      let usage;
      const low = keyName.toLowerCase();
      const named = NAMED[KEY_ALIAS[low] || low];
      if (named !== undefined) {
        usage = named;
      } else if ([...keyName].length === 1) {
        const [u, m] = charUsage(keyName);
        usage = u;
        mask |= m;
      } else {
        fail('not-a-key', { what: keyName });
      }

      unitAt = out.length;
      if (mask) push(ESC_MOD, mask);
      push(usage);
      continue;
    }

    unitAt = out.length;
    push(...usages(ch));
    i++;
  }
  return out;
}

/* ==================================================================== */
/* Bytes -> macro text                                                  */
/* ==================================================================== */

function modNames(mask) {
  const names = [];
  for (const [n, bit] of Object.entries(MODS))
    if (mask & bit) names.push(n[0].toUpperCase() + n.slice(1));
  return names;
}

function keyName(usage) {
  if (usage in UNNAMED) return UNNAMED[usage][0].toUpperCase() + UNNAMED[usage].slice(1);
  if (usage in L().unplain) return L().unplain[usage];
  return '0x' + usage.toString(16).padStart(2, '0');
}

function literal(ch) {
  if (ch === '\n') return '\\n';
  if (ch === '\t') return '\\t';
  if (ch === '\b') return '\\b';
  if (ch === '\\') return '\\\\';
  if (ch === '{')  return '{{';
  return ch;
}

/* The character a plain keystroke types, or undefined if it types none */
function plainChar(b) {
  if ((b & 0x7F) < 0x04) return undefined;
  return (b & SHIFT) ? L().unshifted[b & 0x7F] : L().unplain[b & 0x7F];
}

/* Text that a count can follow without parentheses: one character, or one
   brace form. "ç" is one thing to a reader even though it is two keystrokes,
   and that is the whole point of the group. */
const oneUnit = s => [...s].length === 1 || /^\{[^}]*\}$/.test(s);

/* `open` turns a sealed secret back into keystrokes (openSecret with the
   key), or gives null; without it, or with null, the secret reads back as
   {secret <hex>}. */
function decodeMacro(bytes, open = null) {
  let out = '', mod = 0;
  let groupAt = -1, groupByte = 0;      /* where a marked group began */

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];

    if (b === ESC_MARK) {               /* no argument, so not below */
      groupAt = out.length;
      groupByte = i + 1;
      continue;
    }

    /* On a dead-key layout, what the host shows for two keystrokes is not
       what either of them shows alone, and the editor should say what will
       appear. A mark with nothing that combines after it is written {'}, the
       one form that survives being encoded again. */
    const dead = L().dead;
    if (dead && !mod) {
      const mark = plainChar(b);
      if (mark !== undefined && mark in dead) {
        const next = i + 1 < bytes.length ? plainChar(bytes[i + 1]) : undefined;
        if (next === ' ') { out += literal(mark); i++; continue; }
        const joined = next !== undefined && dead[mark].base.includes(next)
                     ? [...dead[mark].out][[...dead[mark].base].indexOf(next)]
                     : undefined;
        if (joined !== undefined) { out += joined; i++; continue; }
        out += `{${mark}}`;
        continue;
      }
    }

    if (isTotp(bytes, i)) {             /* the secret is not recoverable */
      out += `{totp @${[...bytes.slice(i + 2, i + 2 + TOTP_BYTES)].map(irHex).join('')}}`;
      i += 1 + TOTP_BYTES;
      continue;
    }

    if (b === ESC_IR) {
      const [a, c] = irButton(bytes, i + 1);
      out += `{IR ${irHex(a)} ${irHex(c)}}`;
      i += 3;
      continue;
    }

    if (isSecret(bytes, i)) {                   /* the rest, sealed */
      const tag = bytes[i + 1] === SECRET_LOUD ? 'secret!' : 'secret';
      const blob = [...bytes.slice(i + 2)];
      const plain = open && open(blob);
      return out + (plain ? `{${tag}}` + decodeMacro(plain)
                          : `{${tag} ${blob.map(irHex).join('')}}`);
    }

    if ((b & 0x7F) < 0x04) {                    /* an escape */
      const arg = bytes[++i];
      if (b === ESC_PAUSE)  { out += `{pause ${(arg / 10).toFixed(1)}}`; continue; }
      if (b === ESC_JUMP && arg === JUMP_CLEAR) { out += '{clear}'; continue; }
      if (b === ESC_JUMP && arg === JUMP_ALONE) {
        out += `{${modNames(mod).join('+')}}`;
        mod = 0;
        continue;
      }
      if (b === ESC_JUMP) { out += `{goto ${codeOf(arg - 1)}}`; continue; }
      if (b === ESC_HOST && arg in PTR_NAMES) { out += `{${PTR_NAMES[arg]}}`; continue; }
      if (b === ESC_HOST && (arg > HOST_LOUD && arg < 0x20 || arg & 0x80)) {
        /* a move, and any scale before it */
        const sc = [4, 4];
        let j = i;
        while (bytes[j - 1] === ESC_HOST && bytes[j] > HOST_LOUD && bytes[j] < 0x20) {
          sc[bytes[j] >> 4] = bytes[j] & 0x0F;
          j += 2;
        }
        if (bytes[j - 1] === ESC_HOST && (bytes[j] & 0x80)
            && bytes[j + 1] === ESC_HOST && (bytes[j + 2] & 0xC0) === 0x40) {
          const per = (v, s) => s === 4 ? v : `${v}*${s / 4}`;
          out += `{${per(ptrPct(bytes[j] & 0x7F, 127), sc[0])},`
               + `${per(ptrPct(bytes[j + 2] & 0x3F, 63), sc[1])}}`;
          i = j + 2;
          continue;
        }
      }
      if (b === ESC_HOST) { out += arg === HOST_LOUD ? '{host!}' : '{host}'; continue; }
      if (b === ESC_REPEAT) {
        const n = arg + 1;              /* the firmware counts the extra ones */
        if (groupAt < 0) {
          /* A ")" just before a count would read as a group closing, so it
             has to say that it is only a parenthesis. */
          if (out.endsWith(')') && !out.endsWith('\\)'))
            out = out.slice(0, -1) + '\\)';
          out += `{${n}}`;
          continue;
        }
        const inner = out.slice(groupAt);
        const span = (i - 1) - groupByte;   /* bytes between mark and repeat */
        /* One byte under a mark has to keep its parentheses: written without
           them it would encode as a bare repeat, mark and all dropped. */
        out = out.slice(0, groupAt)
            + (span > 1 && oneUnit(inner) ? inner : `(${inner})`)
            + `{${n}}`;
        groupAt = -1;
        continue;
      }
      if (b === ESC_MOD)    { mod = arg; continue; }
      out += `{?${b.toString(16)}}`;            /* an escape this editor does
                                                   not know */
      continue;
    }

    const usage = b & 0x7F;
    const mask = mod | ((b & SHIFT) ? MODS.shift : 0);
    mod = 0;

    /* A keystroke reads back as the character it types, wherever one exists:
       Shift plus the usage for "1" is "!", and needs no saying. */
    if (!mask) {
      const ch = L().unplain[usage];
      if (ch !== undefined) { out += literal(ch); continue; }
    } else if (mask === MODS.shift) {
      const ch = L().unshifted[usage];
      if (ch !== undefined) { out += literal(ch); continue; }
      /* Shift on a key that types nothing -- Shift+Left -- has to be said */
    } else if (mask === MODS.ralt) {
      const ch = L().unaltgr[usage];
      if (ch !== undefined) { out += literal(ch); continue; }
    }

    out += mask ? `{${modNames(mask).join('+')}+${keyName(usage)}}`
                : `{${keyName(usage)}}`;
  }
  return out;
}

/* ==================================================================== */
/* The table                                                            */
/* ==================================================================== */

/* ".-" -> the header byte: three bits of count-minus-one, five of symbols,
   a dash being a 1 and the first symbol in the highest bit the count uses.
   "IR1" to "IR30" are headers no tapping can make: one symbol, with bits
   set above it. The remote reaches them, and so does a goto. */
const IR_CODES = 30;

function header(code) {
  const ir = /^ir([1-9]\d?)$/i.exec(code);
  if (ir && +ir[1] <= IR_CODES) return (+ir[1] + 1) << 3;
  if (!new RegExp(`^[.-]{1,${MAX_SYM}}$`).test(code))
    fail('not-a-code', { what: code });
  let bits = 0;
  for (const c of code) bits = (bits << 1) | (c === '-' ? 1 : 0);
  return (bits << 3) | (code.length - 1);
}

/* Any other untappable header comes back as something header() refuses,
   rather than as the tappable code its low bits spell. */
function codeOf(header) {
  const n = (header & 0x07) + 1, bits = header >> 3;
  if (bits >> n) return n === 1 ? 'IR' + (bits - 1)
                                : '#' + header.toString(16).padStart(2, '0');
  let code = '';
  for (let i = n - 1; i >= 0; i--) code += (bits >> i) & 1 ? '-' : '.';
  return code;
}

/* Whether a code can be tapped at all. */
function tappable(code) { return /^[.-]+$/.test(code); }

/* Where a macro goes when it is done, and whether it does anything on the
   way. Execution is linear until a jump, and a jump never comes back, so only
   the first one counts -- and only what happens BEFORE it ever runs. */
function entryFate(bytes) {
  let acts = false;
  for (let i = 0; i < bytes.length; i += escStep(bytes, i)) {
    const b = bytes[i];
    /* what a secret does is not known here: count it as doing something */
    if (isSecret(bytes, i)) return { acts: true, goes: null };
    if (isTotp(bytes, i)) { acts = true; continue; }
    if (b === ESC_JUMP && bytes[i + 1] === JUMP_CLEAR) continue;   /* nothing shows */
    if (b === ESC_JUMP && bytes[i + 1] === JUMP_ALONE) { acts = true; continue; }
    if (b === ESC_JUMP)  return { acts, goes: bytes[i + 1] - 1 };
    if (b === ESC_MARK || b === ESC_IR || b === ESC_HOST || b === ESC_MOD)
      continue;                                 /* nothing shows */
    acts = true;                                /* a keystroke, a pause */
  }
  return { acts, goes: null };
}

/* A macro that jumps to itself runs for ever, which is the point of having
   jumps, and touching the pad stops it -- the firmware reads the pad between
   keystrokes and during pauses. So a loop is only a problem when it does
   neither: macros that merely jump to each other never reach a point where
   anybody is asked, and the firmware bounds them by counting instead. That is
   never what anyone meant, so it is worth saying so here. */
function loopCheck(entries) {
  const fate = new Map();
  for (const [code, body] of entries) fate.set(header(code), entryFate(body));

  for (const start of fate.keys()) {
    const path = [];
    let at = start;
    while (at !== null && fate.has(at)) {
      const seen = path.indexOf(at);
      if (seen >= 0) {                          /* a cycle, from here on */
        const cycle = path.slice(seen);
        if (!cycle.some(h => fate.get(h).acts))
          fail('loop-empty',
               { what: [...cycle, cycle[0]]
                       .map(h => `"${codeOf(h)}"`).join(' -> ') });
        break;
      }
      path.push(at);
      at = fate.get(at).goes;
    }
  }
}

/* Things that are allowed but probably not meant, as message keys. A {host!}
   is only indistinguishable from an empty code if nothing shows before it:
   type something first, or move the mouse, and a guesser learns the code
   exists. */
function macroWarnings(bytes) {
  const warn = [];
  let shown = false;
  for (let i = 0; i < bytes.length; i += escStep(bytes, i)) {
    const b = bytes[i];
    if (isSecret(bytes, i)) {
      if (bytes[i + 1] === SECRET_LOUD && shown) warn.push('secret-late');
      break;
    }
    if (b === ESC_HOST && bytes[i + 1] === HOST_LOUD && shown)
      warn.push('host-late');
    if (isTotp(bytes, i)) { warn.push('totp-opaque'); shown = true; continue; }
    if (b === ESC_MARK || b === ESC_IR || b === ESC_MOD ||
        b === ESC_JUMP && bytes[i + 1] !== JUMP_ALONE ||
        b === ESC_HOST && bytes[i + 1] <= HOST_LOUD) continue;
    shown = true;
  }
  return warn;
}

const hasSecret = bytes => {
  for (let i = 0; i < bytes.length; i += escStep(bytes, i))
    if (isSecret(bytes, i)) return true;
  return false;
};

/* [[code, keystrokes], ...] -> the whole table, terminator and all. Entries
   are packed, so their order in the array is their order in EEPROM. */
function packTable(entries) {
  const out = [];
  const seen = new Set();
  for (const [code, body] of entries) {
    const h = header(code);
    if (seen.has(h)) fail('code-twice', { what: code });
    seen.add(h);
    if (body.some(b => !(b >= 0 && b <= 255)))
      fail('not-a-byte', { what: code });
    for (let j = 0; j < body.length; j += escStep(body, j))
      if (!isTotp(body, j) && body[j] === 0)    /* a {totp}'s forty may be anything */
        fail('has-a-zero', { what: code });
    out.push(h, ...body, 0);
  }
  out.push(0xFF);
  if (out.length > TABLE_TOP)
    fail('too-big', { n: out.length, fits: TABLE_TOP });

  /* A jump to a code that is not here ends the macro rather than doing
     something wrong, so this is a warning the firmware does not need -- but
     it is almost always a typo, and silence would be unkind. */
  const present = new Set(entries.map(([code]) => header(code)));
  for (const [code, body] of entries) {
    const f = entryFate(body);
    if (f.goes !== null && !present.has(f.goes))
      fail('goto-nowhere', { what: codeOf(f.goes) });
  }
  loopCheck(entries);
  return Uint8Array.from(out);
}

/* ...and back, so a board's table can be edited rather than retyped. Stops at
   the terminator exactly as the firmware's walk does, so whatever an earlier,
   longer table left beyond it stays invisible here too. */
function unpackTable(bytes) {
  const entries = [];
  let i = 0;
  while (i < bytes.length && i < TABLE_TOP) {
    const h = bytes[i++];
    if ((h & 0x07) >= MAX_SYM) break;           /* 0xFF, or any impossible length */
    const body = [];
    while (i < bytes.length && i < TABLE_TOP && bytes[i]) {
      /* step as a walk does: an argument, or a {totp}'s forty, may be anything */
      const n = escStep(bytes, i);
      for (let k = 0; k < n && i < bytes.length; k++) body.push(bytes[i++]);
    }
    i++;                                        /* the terminator */
    entries.push([codeOf(h), body]);
  }
  return entries;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const SEALED = /\{\s*secret!?\s+[0-9a-f]/i;

/* What the editor holds: text per code, in table order. With the key, a
   {secret} is sealed afresh; without it, only secrets still sealed can be
   written. `check` is the board's check value: a key that is not the one
   it checks would leave the sealed ones unreadable, so it is refused. The
   page writes keyCheck(key) to CHECK_ADDR with the table. */
function encodeTable(rows, { key = null, check = null } = {}) {
  if (key && check && rows.some(r => SEALED.test(r.text)) &&
      !sameBytes(check, keyCheck(key)))
    fail('secret-wrong-key');
  const seal = key ? plain => sealSecret(key, plain) : null;
  return packTable(rows.map(r => [r.code, encodeMacro(r.text, seal)]));
}

/* `bytes` is the EEPROM from 0, through CHECK_ADDR if there are secrets for
   `key` to open. */
function decodeTable(bytes, key = null) {
  const entries = unpackTable(bytes);
  let open = null;
  if (key && entries.some(([, body]) => hasSecret(body))) {
    if (!sameBytes([...bytes.slice(CHECK_ADDR, CHECK_ADDR + 8)], [...keyCheck(key)]))
      fail('secret-wrong-key');
    open = blob => openSecret(key, blob);
  }
  return entries.map(([code, body]) => ({ code, text: decodeMacro(body, open) }));
}

/* The sample table both the app and the test use, so what gets tested is
   what the button writes. */
function sampleRows() {
  return [
    { code: '.',  text: 'hello from DigiMacro\\n' },
    { code: '-',  text: 'wait{pause 1.0} ok' },
    { code: '..', text: 'ab{4}' },
    { code: '.-', text: '{Ctrl+Left}z' },
  ];
}

if (typeof module !== 'undefined') module.exports = {
  ESC_PAUSE, ESC_MOD, ESC_REPEAT, ESC_JUMP, SHIFT, TABLE_TOP, MAX_SYM,
  ESC_MARK, ESC_HOST, HOST_SILENT, HOST_LOUD, macroWarnings,
  ESC_IR, SECRET_QUIET, SECRET_LOUD, JUMP_CLEAR, JUMP_ALONE, CHECK_ADDR, SECRET_MAX, xtea, keyCheck,
  sealSecret, openSecret, walkSafe, hasSecret,
  AUTO_ADDR, AUTO_NONE, LAYOUTS, setLayout, getLayout, setMessages, MSG,
  usages, header, codeOf, tappable, IR_CODES, packTable, unpackTable,
  encodeMacro, decodeMacro, encodeTable, decodeTable, sampleRows,
  irKeyChar, irHeard,
  base32, totpBlob, TOTP_MARK, TOTP_BYTES, FW_TOTP,
};

export {
  ESC_PAUSE,
  ESC_MOD,
  ESC_REPEAT,
  ESC_JUMP,
  SHIFT,
  TABLE_TOP,
  MAX_SYM,
  ESC_MARK,
  ESC_HOST,
  HOST_SILENT,
  HOST_LOUD,
  macroWarnings,
  ESC_IR,
  SECRET_QUIET,
  SECRET_LOUD,
  JUMP_CLEAR,
  JUMP_ALONE,
  CHECK_ADDR,
  SECRET_MAX,
  xtea,
  keyCheck,
  sealSecret,
  openSecret,
  walkSafe,
  hasSecret,
  AUTO_ADDR,
  AUTO_NONE,
  LAYOUTS,
  setLayout,
  getLayout,
  setMessages,
  MSG,
  usages,
  header,
  codeOf,
  tappable,
  IR_CODES,
  packTable,
  unpackTable,
  encodeMacro,
  decodeMacro,
  encodeTable,
  decodeTable,
  sampleRows,
  irKeyChar,
  irHeard,
  base32,
  totpBlob,
  TOTP_MARK,
  TOTP_BYTES,
  FW_TOTP,
};
