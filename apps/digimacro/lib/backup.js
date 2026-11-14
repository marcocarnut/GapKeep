// A board's whole EEPROM as a backup, in DigiMacro's own format (its page's
// web/backup.js): the same JSON, so the text of a backup's QR code, saved as
// a file, is what the page's Restore takes, and a backup the page saved,
// shown as a QR code, is what this app restores.
//
// The 512 bytes are the image as stored: the table, the serial number, the
// key check, the lockout, the power-on macro and the password. A board with
// a password has its backup encrypted with it: scrypt with BIP38's
// parameters (N 16384, r 8, p 8) makes an AES-256-GCM key, the header bound
// in as associated data. Without a password the image is in the clear, as
// the page saves it.
//
// The cryptography is passed in (`c`), so that this runs under GapKeep
// (gk:crypto, main.js) and under Node (tests/digimacro, against the page's
// own backup.js):
//   c.scrypt(password, salt, { N, r, p, length }) -> Promise<Uint8Array>
//   c.gcmEncrypt(key, iv, ad, plain) -> Uint8Array (ciphertext, then tag)
//   c.gcmDecrypt(key, iv, ad, data) -> Uint8Array, or throws
//   c.random(n) -> Uint8Array
// Errors are Errors whose message is a key: "backup-not-one",
// "backup-other-map", "backup-wrong-password".
//
// SPDX-License-Identifier: GPL-3.0-or-later

export const BACKUP_FORMAT = "digimacro-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_MAP = 1;
export const SCRYPT = { N: 16384, r: 8, p: 8 };
export const IMAGE_LEN = 512;
export const PASS_ADDR = 0x1f4;         // the password's 12 bytes, last in the image
export const LOCK_COUNT_ADDRS = [0x1ef, 0x1f0];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63]
         + (i + 1 < bytes.length ? B64[n >> 6 & 63] : "=")
         + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

// Strict: what atob() takes from base64() (padding required), else null
export function unbase64(text) {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const out = [];
  for (let i = 0; i < text.length; i += 4) {
    let n = 0, pad = 0;
    for (let k = 0; k < 4; k++) {
      const ch = text[i + k];
      let v;
      if (ch === "=" && i + 4 === text.length && k >= 2) {
        pad++;
        v = 0;
      } else {
        if (pad) return null;
        v = B64.indexOf(ch);
        if (v < 0) return null;
      }
      n = n << 6 | v;
    }
    out.push(n >> 16 & 255);
    if (pad < 2) out.push(n >> 8 & 255);
    if (pad < 1) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

export const utf8 = (s) => {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  return Uint8Array.from(out);
};

const fail = (key) => { throw new Error(key); };

// The header, in the page's order: what the encryption binds in
const headOf = (f) => ({ format: f.format, version: f.version, map: f.map,
                         serial: f.serial, firmware: f.firmware, saved: f.saved });

// The backup as text: compact JSON (the page indents its files; JSON is JSON,
// and a QR code holds the fewer characters better). `password` null: in the
// clear.
export async function makeBackup(image, password, meta, c) {
  if (!(image instanceof Uint8Array) || image.length !== IMAGE_LEN) throw new RangeError("an image of 512 bytes");
  const head = { format: BACKUP_FORMAT, version: BACKUP_VERSION, map: BACKUP_MAP,
                 serial: meta.serial, firmware: meta.firmware, saved: meta.saved };
  if (password === null) return JSON.stringify({ ...head, image: base64(image) });
  const salt = c.random(16), iv = c.random(12);
  const key = await c.scrypt(utf8(password), salt, { ...SCRYPT, length: 32 });
  const ct = c.gcmEncrypt(key, iv, utf8(JSON.stringify(head)), image);
  key.fill(0);
  return JSON.stringify({ ...head,
    kdf: { name: "scrypt", ...SCRYPT, salt: base64(salt) },
    cipher: { name: "AES-256-GCM", iv: base64(iv) },
    image: base64(ct) });
}

// What a backup says of itself, without opening it
export function readBackupHeader(text) {
  let f;
  try { f = JSON.parse(text); } catch (e) { fail("backup-not-one"); }
  if (!f || typeof f !== "object" || f.format !== BACKUP_FORMAT) fail("backup-not-one");
  if (f.version !== BACKUP_VERSION || f.map !== BACKUP_MAP) fail("backup-other-map");
  return { encrypted: !!f.kdf, serial: f.serial, firmware: f.firmware, saved: f.saved };
}

// The image (512 bytes). The cost is the file's, so it is bounded: no dearer
// than the page makes (16 MiB).
export async function openBackup(text, password, c) {
  const h = readBackupHeader(text);
  const f = JSON.parse(text);
  if (!h.encrypted) {
    const image = unbase64(f.image);
    if (!image || image.length !== IMAGE_LEN) fail("backup-not-one");
    return image;
  }
  if (!f.kdf || typeof f.kdf !== "object" || !f.cipher || typeof f.cipher !== "object") fail("backup-not-one");
  if (f.kdf.name !== "scrypt" || f.cipher.name !== "AES-256-GCM") fail("backup-other-map");
  const { N, r, p } = f.kdf;
  if (![N, r, p].every(Number.isInteger) || N < 2 || (N & (N - 1)) !== 0
      || r < 1 || p < 1 || N * r * p > SCRYPT.N * SCRYPT.r * SCRYPT.p || 128 * r * N > 128 * SCRYPT.r * SCRYPT.N)
    fail("backup-not-one");
  const salt = unbase64(f.kdf.salt), iv = unbase64(f.cipher.iv), ct = unbase64(f.image);
  if (!salt || !iv || !ct || iv.length !== 12 || ct.length !== IMAGE_LEN + 16) fail("backup-not-one");
  if (typeof password !== "string") fail("backup-wrong-password");
  const key = await c.scrypt(utf8(password), salt, { N, r, p, length: 32 });
  let image;
  try {
    image = c.gcmDecrypt(key, iv, utf8(JSON.stringify(headOf(f))), ct);
  } catch (e) {
    fail("backup-wrong-password");
  } finally {
    key.fill(0);
  }
  if (image.length !== IMAGE_LEN) fail("backup-not-one");
  return image;
}

// The password inside must be one somebody knows: none, or the one the file
// was opened with (what saving always writes). A file saying otherwise would
// lock the board against its owner. True if it is.
export function passwordFits(image, password) {
  const stored = image.slice(PASS_ADDR, PASS_ADDR + 12);
  if (stored.every((b) => b === 0xff)) return true;
  if (password === null) return false;
  const want = new Uint8Array(12);
  want.set(utf8(password).slice(0, 12));
  return stored.every((b, i) => b === want[i]);
}

// The key file's line for a board, as DigiMacro's page writes it (tools/
// hostauth reads it): "# comment", then "SERIAL hex"
export const keyFileText = (serial, key, comment) =>
  `# ${comment}\n${serial} ${Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("")}\n`;

// A key from a key file's text: the line for this serial, or the one line
// there is. { key } or { error: "key-not-in-file" | "key-v2-host" }
export function keyFromFile(text, serial) {
  const lines = String(text).split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)).filter((w) => w.length >= 2 && !w[0].startsWith("#"));
  const mine = lines.filter((w) => w[0].toUpperCase() === serial.toUpperCase());
  const line = mine.length ? mine[0] : lines.length === 1 ? lines[0] : null;
  if (!line) return { error: "key-not-in-file" };
  if (/^[0-9a-f]{16}$/i.test(line[1])) return { error: "key-v2-host" };
  if (!/^[0-9a-f]{32}$/i.test(line[1])) return { error: "key-not-in-file" };
  return { key: Uint8Array.from(line[1].match(/../g).map((h) => parseInt(h, 16))) };
}
