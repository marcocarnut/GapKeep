// Runtime self-test. Exercises the zg:ui object model, timers, promises,
// modules and permissions. Returns { passed, failed: [names] }.

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as crypto from "zg:crypto";
import { double } from "./lib/util.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSelfTest(parent) {
  let passed = 0;
  const failed = [];

  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed.push(`${name}: ${e && e.message ? e.message : e}`);
    }
  }
  function eq(a, b, what) {
    if (a !== b) throw new Error(`${what || "value"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
  function throws(fn, type, what) {
    try {
      fn();
    } catch (e) {
      if (type && !(e instanceof type)) throw new Error(`${what}: wrong error type ${e}`);
      return;
    }
    throw new Error(`${what}: did not throw`);
  }

  const box = new ui.Container(parent, { hidden: true });

  await test("relative import", () => eq(double(21), 42));

  await test("label text", () => {
    const l = new ui.Label(box, { text: "abc" });
    eq(l.text, "abc");
    l.text = "def";
    eq(l.text, "def");
    l.set({ text: 12 });
    eq(l.text, "12", "number coerced");
  });

  await test("set() chains", () => {
    const l = new ui.Label(box);
    eq(l.set({ text: "x" }), l);
  });

  await test("unknown property throws", () => {
    throws(() => new ui.Label(box, { txet: "typo" }), TypeError, "constructor");
    throws(() => new ui.Label(box).set({ checked: true }), TypeError, "wrong widget");
  });

  await test("bad values throw", () => {
    const c = new ui.Container(box);
    throws(() => c.set({ width: "wide" }), TypeError, "size");
    throws(() => c.set({ bg: "red" }), TypeError, "color");
    throws(() => c.set({ font: 13 }), TypeError, "font");
    throws(() => c.set({ layout: "grid" }), TypeError, "enum");
    c.set({ width: "50%", height: "content", bg: "#123", color: 0xffffff, font: 20, layout: "row" });
  });

  await test("instanceof and type", () => {
    const b = new ui.Button(box, { text: "b" });
    eq(b instanceof ui.Button, true);
    eq(b instanceof ui.Widget, true);
    eq(b instanceof ui.Label, false);
    eq(b.type, "Button");
    eq(b.text, "b");
  });

  await test("subclassing", () => {
    class Big extends ui.Label {
      shout() {
        this.text = this.text.toUpperCase();
      }
    }
    const l = new Big(box, { text: "hi" });
    l.shout();
    eq(l.text, "HI");
    eq(l instanceof Big, true);
  });

  await test("tree identity", () => {
    const c = new ui.Container(box);
    const l = new ui.Label(c);
    eq(l.parent, c);
    eq(c.children.length, 1);
    eq(c.children[0], l);
  });

  await test("delete", async () => {
    const c = new ui.Container(box);
    const l = new ui.Label(c, { text: "x" });
    l.delete();
    eq(l.alive, false);
    throws(() => (l.text = "y"), TypeError, "use after delete");
    l.delete(); // twice is fine
    eq(c.children.length, 0, "children after delete");
    c.clear();
    await sleep(20);
    eq(c.alive, true);
  });

  await test("clear", () => {
    const c = new ui.Container(box);
    new ui.Label(c);
    new ui.Label(c);
    const kids = c.children;
    c.clear();
    eq(kids[0].alive || kids[1].alive, false);
  });

  await test("textarea", () => {
    const t = new ui.TextArea(box, { oneLine: true, accept: "0123456789", maxLength: 4 });
    t.text = "12";
    eq(t.text, "12");
  });

  await test("checkbox and switch", () => {
    const c = new ui.Checkbox(box, { checked: true });
    eq(c.checked, true);
    c.checked = false;
    eq(c.checked, false);
    const s = new ui.Switch(box);
    eq(s.checked, false);
  });

  await test("dropdown", () => {
    const d = new ui.Dropdown(box, { options: ["a", "b", "c"], selected: 2 });
    eq(d.selected, 2);
  });

  await test("slider and bar", () => {
    const s = new ui.Slider(box, { min: 10, max: 20, value: 15 });
    eq(s.value, 15);
    eq(s.min, 10);
    s.value = 99;
    eq(s.value, 20, "clamped");
    const b = new ui.Bar(box, { max: 50, value: 25 });
    eq(b.value, 25);
  });

  await test("table", () => {
    const t = new ui.Table(box, { data: [["a", "b"], ["c"]] });
    eq(t.rows, 2);
    eq(t.cols, 2);
    eq(t.getCell(0, 1), "b");
    eq(t.getCell(1, 1), "");
    t.setCell(1, 1, "d");
    eq(t.getCell(1, 1), "d");
    eq(t.getCell(9, 9), undefined);
  });

  await test("qrcode", () => {
    const step = (name, f) => { try { f(); } catch (e) { throw new Error(name + ": " + e.message); } };
    let q;
    step("create", () => (q = new ui.QRCode(box, { size: 200, data: "hello" })));
    step("words", () => (q.data = "abandon ".repeat(24)));
    throws(() => (q.data = "x".repeat(5000)), RangeError, "too long");
    eq(q.modules, 57, "rejected data leaves the code unchanged");
    // SeedQR: 96 digits, numeric mode, ECC L -> version 3 (29 modules)
    step("digits", () => q.set({ ecc: "L", data: "0".repeat(96) }));
    eq(q.modules, 29, "SeedQR 24 words");
    // Compact SeedQR: 32 bytes, byte mode, ECC L -> version 2 (25 modules)
    step("bytes", () => (q.data = new Uint8Array(32).fill(0xa5)));
    eq(q.modules, 25, "Compact SeedQR");
    // codex32 share, uppercase -> alphanumeric, ECC M -> 33 modules (dice39 README)
    step("codex32", () => q.set({ ecc: "M", data: "MS12NAMEA320ZYXWVUTSRQPNMLKJHGFEDCAXRPP870HKKQRMXXXXXXXXXXXXXXXXXXXXXXXXXX" }));
    eq(q.modules, 33, "codex32 share");
    throws(() => q.set({ size: 40 }), RangeError, "too small");
    eq(q.modules, 33, "rejected size leaves the code unchanged");
  });

  await test("tabview", () => {
    const t = new ui.TabView(box);
    const a = t.addTab("A");
    t.addTab("B");
    eq(a instanceof ui.Container, true);
    t.active = 1;
    eq(t.active, 1);
  });

  await test("handlers via on() and props", () => {
    const b = new ui.Button(box);
    const f = () => {};
    b.on("click", f);
    eq(b.onClick, f);
    b.onClick = null;
    eq(b.onClick, undefined);
    throws(() => b.on("hover", f), TypeError, "unknown event");
  });

  await test("timers", async () => {
    const order = [];
    setTimeout(() => order.push("b"), 30);
    setTimeout(() => order.push("a"), 10);
    const cancelled = setTimeout(() => order.push("x"), 20);
    clearTimeout(cancelled);
    let n = 0;
    const iv = setInterval(() => {
      if (++n === 3) clearInterval(iv);
    }, 5);
    await sleep(80);
    eq(order.join(""), "ab", "order");
    eq(n, 3, "interval count");
  });

  await test("promises and async", async () => {
    const v = await Promise.all([1, Promise.resolve(2), sleep(5).then(() => 3)]);
    eq(v.join(","), "1,2,3");
  });

  await test("sys", () => {
    eq(typeof sys.version.zerogap, "string");
    eq(sys.app.id, "gallery");
    const m = sys.memory();
    if (!(m.used > 0 && m.limit > m.used)) throw new Error("memory: " + JSON.stringify(m));
    const t0 = sys.uptime();
    if (!(t0 > 0)) throw new Error("uptime");
  });

  await test("permissions", async () => {
    let err = null;
    try {
      await import("zg:apps");
    } catch (e) {
      err = e;
    }
    if (!err || !/permission/.test(err.message)) throw new Error("zg:apps was importable: " + err);
  });

  await test("bare imports rejected", async () => {
    let err = null;
    try {
      await import("lodash");
    } catch (e) {
      err = e;
    }
    if (!err) throw new Error("bare import worked");
  });

  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  await test("sha256 vectors", () => {
    eq(hex(crypto.sha256("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty");
    eq(hex(crypto.sha256("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "abc");
    eq(hex(crypto.sha256(new Uint8Array([0x61, 0x62, 0x63]))), hex(crypto.sha256("abc")), "bytes");
    const buf = new Uint8Array([0, 0x61, 0x62, 0x63, 0]);
    eq(hex(crypto.sha256(buf.subarray(1, 4))), hex(crypto.sha256("abc")), "subarray");
    eq(hex(crypto.sha256(buf.buffer.slice(1, 4))), hex(crypto.sha256("abc")), "ArrayBuffer");
    eq(hex(crypto.sha256("\u00e9")), hex(crypto.sha256(new Uint8Array([0xc3, 0xa9]))), "UTF-8");
    throws(() => crypto.sha256(42), TypeError, "number");
  });

  await test("random bytes", () => {
    eq(crypto.rngStatus().healthy, true, "healthy");
    const a = crypto.randomBytes(32), b = crypto.randomBytes(32);
    eq(a.length, 32);
    eq(a instanceof Uint8Array, true);
    if (hex(a) === hex(b)) throw new Error("two draws are equal");
    const big = crypto.randomBytes(4096);
    const seen = new Set(big);
    if (seen.size < 200) throw new Error("only " + seen.size + " distinct byte values in 4096");
    const u = new Uint32Array(4);
    eq(crypto.getRandomValues(u), u, "in place");
    if (u.every((x) => x === 0)) throw new Error("not filled");
    throws(() => crypto.randomBytes(70000), RangeError, "too many");
  });

  await test("modern JS", () => {
    const { a, ...rest } = { a: 1, b: 2, c: 3 };
    eq(Object.keys(rest).join(), "b,c");
    eq(10n ** 20n > 0n, true, "BigInt");
    eq([1, [2, [3]]].flat(Infinity).join(), "1,2,3");
    eq("x".padStart(3, "-"), "--x");
    eq(new Uint8Array([1, 2, 3]).reduce((s, v) => s + v), 6);
    // regression: miscompiled under strict aliasing on arm-none-eabi
    eq([..."héllo"].join("|"), "h|é|l|l|o", "string iteration");
  });

  box.delete();
  return { passed, failed };
}
