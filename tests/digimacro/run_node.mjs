// The DigiMacro app's libraries under Node:
//
//   node --experimental-default-type=module tests/digimacro/run_node.mjs
//
// 1. vendor/table.js, the copy, against DigiMacroAsm's own web/table.js
//    (DIGIMACROASM, default ~/claude/code/DigiMacroAsm; skipped without it):
//    the same bytes for the same macros, the same text back, the same
//    {totp} midstates, the same refusals, and the same reading of random
//    EEPROM images, in each keyboard layout.
// 2. lib/macros.js: {totp #N} and {totp ~N}, never a key on screen; what
//    is written is what the page would write; keys wiped after a write.
// 3. lib/board.js against a fake board (fakeboard.mjs): the gates, the
//    password, reading and writing in chunks, the clock, answers taken by
//    another program, the report id in answers or not.
// 4. lib/parse.js (Google Authenticator's export): edge cases, and random
//    and mutated exports, which must parse or be refused with a ParseError,
//    never anything else.
// 5. Secrets with the board's key: sealed and opened as the page does, the
//    snapshot the same for the same macros; {IR} filled by LEARN, the
//    board's typing read from its keyboard reports.
// 6. lib/backup.js against DigiMacroAsm's web/backup.js: each opens the
//    other's backups (encrypted and not), wrong passwords and broken files
//    refused, the key file's text read as the page reads it.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as V from "../../apps/digimacro/vendor/table.js";
import { Macros, MacroError, totpFits } from "../../apps/digimacro/lib/macros.js";
import * as B from "../../apps/digimacro/lib/board.js";
import { parseCode, parseMigration, ParseError } from "../../apps/digimacro/lib/parse.js";
import * as K from "../../apps/digimacro/lib/backup.js";
import { scryptSync, createCipheriv, createDecipheriv, randomBytes as nodeRandom, webcrypto } from "node:crypto";

// as a browser has it (table.js seals with it; the page's backup.js uses
// its subtle), which Node 18 has only under a flag
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { FakeBoard } from "./fakeboard.mjs";

let fails = 0, checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) {
    fails++;
    console.log("FAIL: " + what);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 0x1000000;
const below = (n) => Math.floor(rand() * n);
const randomBytes = (n) => Uint8Array.from({ length: n }, () => below(256));

const MACROS = [
  "hello from DigiMacro\\n", "wait{pause 1.0} ok", "ab{4}", "{Ctrl+Left}z",
  "{Ctrl+Shift+Left}{Shift+Left}{Alt+Tab}{F5}", "A!Z {{x}} \\t", "coração{Enter}",
  "tv{IR 00 45}on{IR 80 c5}!", "(ab){3}c", "{50,50}{click}", "{Gui}", "{clear}x",
  "user\\t{totp JBSWY3DPEHPK3PXP}{Enter}", "{totp GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ}",
  "x{goto .}", "{pause 25.5}{x2}", "ç", "{", "{nope}", "{pause 99}", "{totp 0189}", "{totp}",
  "\\q", "a\\", "()", "{Ctrl+}", "{Foo+a}", "{IR zz}", "€",
];

// --- 1. the copy against the original ----------------------------------------
const tree = process.env.DIGIMACROASM || homedir() + "/claude/code/DigiMacroAsm";
if (existsSync(tree + "/web/table.js")) {
  const O = createRequire(import.meta.url)(tree + "/web/table.js");
  const outcome = (fn) => {
    try {
      const r = fn();
      return { ok: r instanceof Uint8Array || Array.isArray(r) ? Array.from(r) : r };
    } catch (e) {
      return { error: e.message };
    }
  };
  for (const layout of Object.keys(O.LAYOUTS)) {
    O.setLayout(layout);
    V.setLayout(layout);
    for (const m of MACROS) {
      const a = outcome(() => O.encodeMacro(m)), b = outcome(() => V.encodeMacro(m));
      check(same(a, b), `encode ${JSON.stringify(m)} (${layout}): copy and original agree`);
      if (a.ok) check(same(outcome(() => O.decodeMacro(a.ok)), outcome(() => V.decodeMacro(a.ok))),
                      `decode ${JSON.stringify(m)} (${layout})`);
    }
    const rows = O.sampleRows().concat([{ code: "...", text: "{totp JBSWY3DPEHPK3PXP}" }]);
    check(same(outcome(() => O.encodeTable(rows)), outcome(() => V.encodeTable(rows))), `encodeTable (${layout})`);
    for (let i = 0; i < 300; i++) {
      const ee = new Uint8Array(512).fill(0xff);
      const n = below(480);
      ee.set(randomBytes(n), 0);
      if (rand() < 0.5) ee[below(n + 1)] = 0xff;
      check(same(outcome(() => O.decodeTable(ee)), outcome(() => V.decodeTable(ee))),
            `decodeTable of random image ${i} (${layout})`);
    }
  }
  for (let i = 0; i < 50; i++) {
    const key = randomBytes(1 + below(100));
    check(same(O.totpBlob(key), V.totpBlob(key)), `totpBlob of a ${key.length}-byte key`);
  }
  console.log(`table.js: the copy agrees with ${tree}/web/table.js`);
} else {
  console.log(`table.js: ${tree} not found, the copy is not compared with the original`);
}
V.setLayout("us");

// --- 2. lib/macros.js --------------------------------------------------------
{
  const RFC = Uint8Array.from("12345678901234567890", (c) => c.charCodeAt(0));
  const m = new Macros();
  m.rows = [{ code: ".", text: "user\\t{totp #1}{Enter}" }, { code: "-", text: "{totp #2}" }];
  m.accounts.set(1, { secret: RFC.slice(), algorithm: "SHA1", digits: 6, period: 30, issuer: "A", name: "a" });
  m.accounts.set(2, { secret: RFC.slice(), algorithm: "SHA256", digits: 6, period: 30, issuer: "B", name: "b" });
  let st = m.state();
  check(!st.ok && st.each[0].bytes && st.each[1].error instanceof MacroError && /SHA-1/.test(st.each[1].error.message),
        "an account the board can't type is refused, in its own row");
  check(!totpFits({ algorithm: "SHA1", digits: 8, period: 30 }) && totpFits({ algorithm: "SHA1", digits: 6, period: 30 }),
        "the board's codes: SHA-1, 6 digits, 30 s");
  m.rows[1].text = "{totp #3}";
  check(/no imported account 3/.test(m.state().each[1].error.message), "an unknown account");
  m.rows[1].text = "x";
  st = m.state();
  check(st.ok, "a good table encodes");
  // what the page would write for the same macro with the key typed in
  const table = m.table();
  const page = V.encodeTable([{ code: ".", text: "user\\t{totp GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ}{Enter}" }, { code: "-", text: "x" }]);
  check(same(Array.from(table), Array.from(page)), "{totp #1} encodes as {totp <its key>} does");
  const secret = m.accounts.get(1).secret;
  m.settle();
  check(secret.every((b) => b === 0) && !m.accounts.has(1), "after a write the key written is wiped");
  check(m.accounts.has(2) && m.accounts.get(2).secret.some((b) => b !== 0), "an account not written stays");
  check(m.rows[0].text === "user\\t{totp ~1}{Enter}" && m.blobs.length === 1, "and the row says {totp ~1}");
  check(same(Array.from(m.table()), Array.from(page)), "{totp ~1} encodes as it did");
  // read back from a board: a key shows as {totp ~N}, never as hex
  const ee = new Uint8Array(512).fill(0xff);
  ee.set(page, 0);
  const r = new Macros();
  check(r.load(ee) === 2 && r.rows[0].text === "user\\t{totp ~1}\\n", "read back: {totp ~1} ({Enter} as \\n, as the page shows it)");
  check(!/[0-9a-f]{20}/i.test(JSON.stringify(r.rows)), "no key on screen");
  check(same(Array.from(r.table()), Array.from(page)), "written back unchanged");
  // a sealed secret goes back as it came; a new {secret} needs the key
  const KEY = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
  let n = 7;
  const random = (k) => Uint8Array.from({ length: k }, () => (n = (n * 69069 + 1) >>> 0) >>> 24);
  const sealedTable = V.packTable([[".", V.encodeMacro("user{secret}pw", (plain) => V.sealSecret(KEY, plain, random))]]);
  const ee2 = new Uint8Array(512).fill(0xff);
  ee2.set(sealedTable, 0);
  const s = new Macros();
  s.load(ee2);
  check(s.rows[0].text === "user" && /^\{secret [0-9a-f]+\}$/.test(s.rows[0].sealed), "a sealed secret is kept apart");
  check(same(Array.from(s.table()), Array.from(sealedTable)), "and written back as it came");
  s.rows[0].text = "user{secret}x";
  check(/needs the board's key/.test(s.state().each[0].error.message), "{secret} without the key is refused");
  check(s.nextCode() === "-", "the next free code");
}

// --- 3. lib/board.js against the fake board ----------------------------------
{
  const fake = new FakeBoard();
  const board = new B.Board(fake.io());
  const info = await board.info();
  check(info.magic && info.firmware === 18 && info.protocol === 3 && !info.bare, "INFO: DigiMacro, firmware 18");
  check(B.hardening(info).length === 6, "the v2 hardening checklist");
  let refused = false;
  try {
    await board.read(0, 4);
  } catch (e) {
    refused = e instanceof B.Refused;
  }
  check(refused, "a read before the hold is refused");
  fake.open = true;
  const data = Uint8Array.from({ length: 70 }, (_, i) => i + 1);
  await board.write(0x10, data);
  check(same(Array.from(fake.ee.slice(0x10, 0x10 + 70)), Array.from(data)), "a write of 70 bytes, in chunks");
  check(same(Array.from(await board.read(0x10, 70)), Array.from(data)), "read back");
  check(fake.log.filter(([c]) => c === B.F_WRITE).length === 3, "three WRITEs of at most 32");
  fake.interfere = 3;
  check(same(Array.from(await board.read(0x10, 4)), [1, 2, 3, 4]), "answers another program took: asked again");
  await board.setPassword("señha");
  check(fake.state() & B.ST_PASSWORD, "a password set");
  fake.unlocked = false;
  check(B.wantsPassword(await board.state()), "the board wants it");
  check(!(await board.unlock("wrong")), "a wrong password");
  check(await board.unlock("señha"), "the right one (UTF-8)");
  let tooLong = false;
  try {
    await board.setPassword("ççççççç");
  } catch (e) {
    tooLong = e instanceof RangeError;
  }
  check(tooLong, "14 bytes of password refused");
  await board.setClock(1767225600);
  check(fake.clock === 1767225600, "the clock, as four bytes");
  await board.setPassword(null);
  check(!(fake.state() & B.ST_PASSWORD), "no password");
  for (const idFirst of [false, true]) {
    const io = B.usbIo(fake.handle({ idFirst }));
    const b2 = new B.Board(io);
    check((await b2.info()).magic && same(Array.from(await b2.read(0x10, 3)), [1, 2, 3]),
          `over gk:usb, the id ${idFirst ? "in" : "not in"} the answer`);
  }
  check(same(B.parseLock(Uint8Array.from([3, 2, 6, 254, 255, 250])),
             { on: true, soft: 3, hard: 2, tens: 6, misses: 1, softs: 0, cleared: 5 }), "the lockout's bytes");
  check(B.serialText(Uint8Array.from([0x78, 0x56, 0x34, 0x12])) === "12345678", "the serial number");
}

// --- 4. lib/parse.js: Google Authenticator's export --------------------------
{
  // a valid export: an encoder independent of the decoder
  const varint = (n) => {
    const out = [];
    do {
      out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
      n = Math.floor(n / 128);
    } while (n > 0);
    return out;
  };
  const field = (num, wire, v) => (wire === 2 ? [...varint((num << 3) | 2), ...varint(v.length), ...v]
                                              : [...varint((num << 3) | wire), ...varint(v)]);
  const str = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const otp = (secret, name, issuer, alg, digits, type) =>
    [...field(1, 2, secret), ...field(2, 2, str(name)), ...field(3, 2, str(issuer)),
     ...field(4, 0, alg), ...field(5, 0, digits), ...field(6, 0, type)];
  const payload = (otps, size = 1, index = 0) =>
    [...otps.flatMap((o) => field(1, 2, o)), ...field(2, 0, 1), ...field(3, 0, size), ...field(4, 0, index), ...field(5, 0, 7)];
  const uri = (bytes) => "otpauth-migration://offline?data=" + encodeURIComponent(Buffer.from(bytes).toString("base64"));
  const S1 = str("12345678901234567890");
  const good = payload([otp(S1, "alice@example.com", "Example", 1, 1, 2), otp(S1, "bob", "ACME", 2, 2, 2), otp(S1, "carol", "Hotp", 1, 1, 1)]);
  const r = parseMigration(uri(good));
  check(r.accounts.length === 2 && r.refused.length === 1, "an export: two TOTP accounts, an HOTP one refused");
  check(r.accounts[0].issuer === "Example" && totpFits(r.accounts[0]) && !totpFits(r.accounts[1]),
        "the first fits the board, the SHA-256 one does not");
  const parsed = parseCode("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example");
  check(parsed.kind === "totp" && parsed.account.name === "alice" && totpFits(parsed.account), "a plain otpauth:// key");

  // edge cases: each refused with a ParseError
  const refuse = (text, what) => {
    try {
      parseCode(text);
      check(false, `${what}: accepted`);
    } catch (e) {
      check(e instanceof ParseError, `${what}: ${e}`);
    }
  };
  refuse("otpauth-migration://offline?data=", "no data");
  refuse(uri([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]), "a length of 4 GB");
  refuse(uri([0x0a, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), "a varint of 11 bytes");
  refuse(uri([0x0f]), "wire type 7");
  refuse(uri([0x00]), "field 0");
  refuse(uri(payload([], 0, 0)), "a batch of 0 parts");
  refuse(uri(payload([otp(S1, "x", "y", 1, 1, 2)], 2, 2)), "part 3 of 2");
  refuse(uri(payload([otp(S1, "\xff", "y", 1, 1, 2)])), "a name that is not UTF-8");
  refuse(uri([...field(1, 2, [...field(2, 2, str("x")), 0x08])]), "an account cut short");
  refuse("otpauth-migration://offline?data=%%%", "a broken %-escape");
  refuse("otpauth-migration://offline?data=A", "Base64 of one character");
  refuse("otpauth://hotp/x?secret=JBSWY3DP", "HOTP");
  refuse("otpauth://totp/x?secret=JBSWY3D1", "a secret that is not Base32");
  refuse("hello", "not a key at all");

  // random and mutated: parsed, or refused with a ParseError; never more
  const ok = (text) => {
    try {
      const out = parseCode(text);
      if (out.kind === "migration") {
        for (const a of out.accounts) {
          if (!(a.secret instanceof Uint8Array) || a.secret.length === 0) return "an account without a secret";
          if (![6, 8].includes(a.digits)) return "bad digits";
        }
      }
      return null;
    } catch (e) {
      return e instanceof ParseError ? null : `${e.name}: ${e.message}`;
    }
  };
  let parsedCount = 0;
  for (let i = 0; i < 20000; i++) {
    let bytes;
    if (i % 4 === 0) bytes = Array.from(randomBytes(below(200)));
    else {
      bytes = good.slice();
      for (let k = 1 + below(4); k > 0; k--) {
        const at = below(bytes.length + 1);
        const what = below(4);
        if (what === 0 && bytes.length) bytes[at % bytes.length] = below(256);
        else if (what === 1) bytes.splice(at, 0, [0, 1, 0x7f, 0x80, 0xff][below(5)]);
        else if (what === 2) bytes.splice(at, 1 + below(8));
        else bytes = bytes.slice(0, at);
      }
    }
    const err = ok(uri(bytes));
    if (err === null) parsedCount++;
    check(err === null, `mutated export ${i}: ${err}`);
    if (fails > 20) break;
  }
  console.log(`parse.js: 20000 random and mutated exports, ${parsedCount} handled as they should`);
}

// --- 5. secrets with a key; {IR} learned ---------------------------------------
{
  const key = Uint8Array.from({ length: 16 }, (_, i) => i * 17 + 3);
  const m = new Macros();
  m.setKey(key);
  m.rows = [{ code: ".", text: "user\\t{secret}hunter2{Enter}" }, { code: "-", text: "plain" }];
  check(m.snapshot() !== null && m.snapshot() === m.snapshot(), "secrets: the snapshot is the same each time");
  const t1 = m.table(), t2 = m.table();
  check(hex(t1) !== hex(t2), "secrets: written, sealed with fresh nonces");
  // the board's EEPROM, as readAll() builds it: the table, then the check value
  const ee = new Uint8Array(V.CHECK_ADDR + 8).fill(0xff);
  ee.set(t1, 0);
  ee.set(V.keyCheck(key), V.CHECK_ADDR);
  const plain = new Macros();
  plain.load(ee);
  check(plain.rows[0].sealed && !/hunter2/.test(JSON.stringify(plain.rows)), "secrets: without the key, sealed");
  check(plain.hasSealed() && plain.hasSecret(), "secrets: hasSealed");
  let threw = false;
  try { plain.table(); } catch (e) { threw = true; }
  check(!threw, "secrets: sealed rows written back as they are, without the key");
  const OPENED = "user\\t{secret}hunter2\\n";         // as decodeMacro() writes it back
  check(plain.setKey(key) === 1 && plain.rows[0].text === OPENED && !plain.hasSealed(),
        "secrets: the key opens them: " + JSON.stringify(plain.rows[0]));
  const other = new Macros();
  other.load(ee);
  check(other.setKey(Uint8Array.from({ length: 16 }, () => 9)) === 0 && other.hasSealed(), "secrets: another key opens none");
  const withKey = new Macros();
  withKey.setKey(key);
  withKey.load(ee);
  check(withKey.rows[0].text === OPENED, "secrets: loaded with the key, open");
  // what the page reads of it: the same macros
  if (existsSync(tree + "/web/table.js")) {
    const O = createRequire(import.meta.url)(tree + "/web/table.js");
    const got = O.decodeTable(ee, key);
    check(got.length === 2 && got[0].text === OPENED, "secrets: the page opens what the app sealed");
  }
  const nokey = new Macros();
  nokey.rows = [{ code: ".", text: "{secret}x" }];
  threw = false;
  try { nokey.table(); } catch (e) { threw = e instanceof MacroError; }
  check(threw, "secrets: {secret} without a key refused");

  // {IR}: the first without a button
  const ir = new Macros();
  ir.rows = [{ code: ".", text: "tv{IR 00 45}" }, { code: "-", text: "vol{ IR }up{IR}" }];
  const at = ir.emptyIR();
  check(at && at[0] === 1, "IR: the first empty {IR}");
  ir.fillIR(1, "{IR 80 c5}");
  check(ir.rows[1].text === "vol{IR 80 c5}up{IR}" && ir.emptyIR()[0] === 1, "IR: filled, the next one left");
  // the board types "80 c5" (LEARN), press and release each, as usages
  const usage = { "8": 0x25, "0": 0x27, " ": 0x2c, c: 0x06, "5": 0x22 };
  const r = new B.KeyReader();
  let typed = "";
  for (const ch of "80 c5") {
    typed += r.feed(Uint8Array.from([1, 0, 0, usage[ch], 0, 0]));
    typed += r.feed(Uint8Array.from([1, 0, 0, 0, 0, 0]));
  }
  typed += r.feed(Uint8Array.from([3, 0, 5, 5]));       // the mouse: none of LEARN's
  check(typed === "80 c5" && V.irHeard(typed) === "{IR 80 c5}", "IR: the typing read: " + JSON.stringify(typed));
  const r2 = new B.KeyReader();
  check(r2.feed(Uint8Array.from([1, 0, 0, 0x04, 0, 0])) + r2.feed(Uint8Array.from([1, 0, 0, 0x04, 0, 0])) === "a",
        "IR: a key held is one press");
}

// --- 6. backups, against the page's ---------------------------------------------
{
  const C = {
    scrypt: async (pass, salt, { N, r, p, length }) =>
      Uint8Array.from(scryptSync(Buffer.from(pass), Buffer.from(salt), length, { N, r, p, maxmem: 256 * 1024 * 1024 })),
    gcmEncrypt: (key, iv, ad, plain) => {
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(ad);
      return Uint8Array.from(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
    },
    gcmDecrypt: (key, iv, ad, data) => {
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAAD(ad);
      d.setAuthTag(data.slice(-16));
      return Uint8Array.from(Buffer.concat([d.update(data.slice(0, -16)), d.final()]));
    },
    random: (n) => Uint8Array.from(nodeRandom(n)),
  };
  const image = randomBytes(512);
  image.set(new Uint8Array(12).fill(0xff), K.PASS_ADDR);
  const meta = { serial: "7DD5DC7E", firmware: 18, saved: "2026-11-14" };
  const rejects = async (p, msg) => { try { await p; return false; } catch (e) { return e.message === msg; } };

  // base64, against Node's
  for (let n = 0; n < 8; n++) {
    const b = randomBytes(n);
    check(K.base64(b) === Buffer.from(b).toString("base64") && hex(K.unbase64(K.base64(b))) === hex(b), `base64 of ${n} bytes`);
  }
  check(K.unbase64("abc") === null && K.unbase64("a=bc") === null && K.unbase64("ab==ab==") === null && K.unbase64("a!==") === null,
        "unbase64: broken text refused");

  const plain = await K.makeBackup(image, null, meta, C);
  check(K.readBackupHeader(plain).encrypted === false && hex(await K.openBackup(plain, null, C)) === hex(image), "backup: in the clear, both ways");
  const pw = "correct horse";
  const enc = await K.makeBackup(image, pw, meta, C);
  check(K.readBackupHeader(enc).encrypted === true && hex(await K.openBackup(enc, pw, C)) === hex(image), "backup: encrypted, both ways");
  check(await rejects(K.openBackup(enc, "wrong", C), "backup-wrong-password"), "backup: a wrong password");
  const f = JSON.parse(enc);
  f.serial = "00000000";
  check(await rejects(K.openBackup(JSON.stringify(f), pw, C), "backup-wrong-password"), "backup: the header is bound in");
  const dear = JSON.parse(enc);
  dear.kdf.N = 1 << 20;
  check(await rejects(K.openBackup(JSON.stringify(dear), pw, C), "backup-not-one"), "backup: no dearer than the page's");
  check(await rejects(K.openBackup("{", null, C), "backup-not-one") && await rejects(K.openBackup('{"format":"x"}', null, C), "backup-not-one"),
        "backup: not one");
  check(await rejects(K.openBackup(JSON.stringify({ ...JSON.parse(plain), version: 2 }), null, C), "backup-other-map"), "backup: another version");
  const pimg = Uint8Array.from(image);
  pimg.set(Uint8Array.from([...Buffer.from(pw).subarray(0, 12)]), K.PASS_ADDR);
  check(K.passwordFits(image, null) && K.passwordFits(pimg, pw) && !K.passwordFits(pimg, "other") && !K.passwordFits(pimg, null),
        "backup: the password inside");

  if (existsSync(tree + "/web/backup.js") && globalThis.crypto && globalThis.crypto.subtle) {
    const P = createRequire(import.meta.url)(tree + "/web/backup.js");
    // the page's, opened here; ours, opened by the page
    const pageEnc = await P.makeBackup(image, pw, meta);
    const pagePlain = await P.makeBackup(image, null, meta);
    check(hex(await K.openBackup(pageEnc, pw, C)) === hex(image), "backup: the page's encrypted one opens here");
    check(hex(await K.openBackup(pagePlain, null, C)) === hex(image), "backup: the page's plain one opens here");
    check(hex(await P.openBackup(enc, pw)) === hex(image), "backup: ours opens on the page (encrypted)");
    check(hex(await P.openBackup(plain, null)) === hex(image), "backup: ours opens on the page (plain)");
    check(same(P.readBackupHeader(enc), K.readBackupHeader(enc)), "backup: the same header read");
  } else {
    console.log("backup.js: DigiMacroAsm's web/backup.js (or WebCrypto) not here: the page's side skipped");
  }

  // the key file
  const key = randomBytes(16);
  const text = K.keyFileText("7DD5DC7E", key, "DigiMacro key for board 7DD5DC7E");
  check(hex(K.keyFromFile(text, "7DD5DC7E").key) === hex(key), "key file: read back");
  check(hex(K.keyFromFile("# x\n11111111 " + hex(randomBytes(16)) + "\n7dd5dc7e " + hex(key), "7DD5DC7E").key) === hex(key), "key file: this board's line");
  check(K.keyFromFile("7DD5DC7E 0123456789abcdef", "7DD5DC7E").error === "key-v2-host", "key file: a v2 host key");
  check(K.keyFromFile("nothing here", "7DD5DC7E").error === "key-not-in-file", "key file: none");
}

// 7. The keyboard layout changed: the same keystrokes, read on the new one
{
  const m = new Macros();
  V.setLayout("us-intl");
  const bytes = V.encodeMacro("vários são");
  V.setLayout("us");
  m.rows = [{ code: ".", text: V.decodeMacro(bytes) }, { code: "-", text: "plain{Enter}{IR}x" },
            { code: "..", text: "a'b{totp #1}c" }];
  check(m.rows[0].text === "v'arios s~ao", "relayout: read on US first");
  m.relayout("us", "us-intl");
  check(V.getLayout() === "us-intl", "relayout: the layout left at the new one");
  check(m.rows[0].text === "vários são", "relayout: US International reads the accents");
  check(m.rows[1].text === "plain{Enter}{IR}x", "relayout: unaltered text as typed, {IR} kept");
  check(m.rows[2].text === "a{'}b{totp #1}c", "relayout: a lone mark, and the token kept");
  check(hex(V.encodeMacro(m.rows[0].text)) === hex(bytes), "relayout: the same keystrokes");
  m.relayout("us-intl", "us");
  check(m.rows[0].text === "v'arios s~ao" && m.rows[2].text === "a'b{totp #1}c", "relayout: and back");
  m.relayout("us", "abnt2");
  check(m.rows[0].text === "vãrios s\"ao", "relayout: ABNT2's keys differ");
  V.setLayout("us");
}

console.log(`digimacro node tests: ${checks - fails} of ${checks} passed`);
process.exit(fails ? 1 : 0);
