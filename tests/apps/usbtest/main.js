// Checks gk:usb against the fake device of tests/usb/usbip_stub.py
// (1209:0001), which tests/usb.txt plugs into the simulator: what the
// device says of itself, transfers that work, those the device refuses or
// never answers, and those gk:usb refuses before they reach it. Logs
// "usbtest: ok <name>" or "usbtest: FAIL <name>: ..." for each, then
// "usbtest done: N failed". After the scenario unplugs the device and it
// comes back: "usbtest: replugged ...".
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as usb from "gk:usb";

let failed = 0;
function ok(name) { console.log(`usbtest: ok ${name}`); }
function fail(name, e) {
  failed++;
  console.log(`usbtest: FAIL ${name}: ${e && e.message ? e.message : e}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn, type, pattern, what) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof type)) throw new Error(`${what}: not a ${type.name}: ${e}`);
    if (pattern && !pattern.test(e.message)) throw new Error(`${what}: message ${JSON.stringify(e.message)}`);
    return;
  }
  throw new Error(`${what}: did not throw`);
}
async function rejects(promise, code, what) {
  try {
    await promise;
  } catch (e) {
    if (e.code !== code) throw new Error(`${what}: code ${e.code}, expected ${code} (${e.message})`);
    return;
  }
  throw new Error(`${what}: did not reject`);
}

const vendorIn = (request, value = 0) => ({ type: "vendor", recipient: "device", request, value, index: 0 });
const status = new ui.Label({ text: "Waiting for the test device (1209:0001)..." });

usb.onAttach((d) => {
  console.log(`usbtest: attached ${d.vid.toString(16)}:${d.pid.toString(16)} as device ${d.id}`);
  if (finished) replugged(d);
});
usb.onDetach((d) => console.log(`usbtest: detached device ${d.id}`));

let started = false, finished = false;
function start() {
  const list = usb.list();
  if (started || list.length === 0) return;
  started = true;
  run(list[0]).then(() => {
    finished = true;
    status.text = `Done: ${failed} failed.`;
    console.log(`usbtest done: ${failed} failed`);
  });
}
usb.onAttach(start);
console.log("usbtest ready");
start();

async function run(info) {
  await check("what the device says", () => {
    eq([info.vid, info.pid, info.manufacturer, info.product, info.serial, info.speed],
       [0x1209, 1, "GapKeep tests", "USB test device", "TEST-0001", "full"], "info");
    eq(info.interfaces, [{ number: 0, class: 3, subclass: 1, protocol: 1 },
                         { number: 1, class: 255, subclass: 0, protocol: 0 }], "interfaces");
  });

  const dev = usb.open(info);
  await check("open twice", () => throws(() => usb.open(info.id), TypeError, /open already/, "again"));
  await check("open: not a device", () => throws(() => usb.open(9999), TypeError, /no device 9999/, "9999"));

  await check("the device descriptor", async () => {
    const d = await dev.controlIn({ type: "standard", recipient: "device", request: 6, value: 0x0100 }, 18);
    eq([d instanceof Uint8Array, d.length, d[0], d[1]], [true, 18, 18, 1], "descriptor");
  });
  await check("the HID report descriptor", async () => {
    const d = await dev.controlIn({ type: "standard", recipient: "interface", request: 6, value: 0x2200, index: 0 }, 64);
    eq(d.length, 25, "length");
  });
  await check("a feature report, set and got", async () => {
    const data = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
    eq(await dev.setFeatureReport(1, new Uint8Array(data)), undefined, "set");
    const back = await dev.getFeatureReport(1, 33);
    eq(Array.from(back), [1, ...data], "got");
  });
  await check("vendor IN", async () => {
    const d = await dev.controlIn(vendorIn(1), 4);
    eq([d.length, d[0], d[1]], [4, 0x47, 0x4b], "GK");
  });
  await check("vendor OUT, then IN", async () => {
    eq(await dev.controlOut({ type: "vendor", recipient: "device", request: 5 }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10, "out");
    eq(Array.from(await dev.controlIn(vendorIn(6), 10)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "in");
  });
  await check("a stall", () => rejects(dev.controlIn(vendorIn(2), 4), "stall", "stall"));
  await check("more data than asked for", () => rejects(dev.controlIn(vendorIn(4), 8), "error", "overrun"));

  // refused before they reach the device
  await check("standard OUT is the system's", () =>
    throws(() => dev.controlOut({ type: "standard", recipient: "device", request: 5, value: 9 }), TypeError, /standard request 5 is the system's/, "SET_ADDRESS"));
  await check("standard SET_FEATURE IN is no read", () =>
    throws(() => dev.controlIn({ type: "standard", recipient: "device", request: 3 }, 2), TypeError, /is the system's/, "3"));
  await check("too long IN", () => throws(() => dev.controlIn(vendorIn(1), 65), RangeError, /from 0 to 64/, "65"));
  await check("an empty IN", () => throws(() => dev.controlIn(vendorIn(1), 0), RangeError, /from 1 to 64/, "0"));
  await check("too long OUT", () =>
    throws(() => dev.controlOut({ type: "vendor", recipient: "device", request: 5 }, new Uint8Array(65)), RangeError, /at most 64 bytes/, "65"));
  await check("a report too long with its id", () =>
    throws(() => dev.setFeatureReport(1, new Uint8Array(64)), RangeError, /at most 63 bytes/, "64+1"));
  await check("no such interface", () =>
    throws(() => dev.controlIn({ type: "class", recipient: "interface", request: 1, index: 5 }, 8), RangeError, /no interface 5/, "5"));
  await check("an unknown type", () =>
    throws(() => dev.controlIn({ type: "bogus", recipient: "device", request: 1 }, 8), TypeError, /setup.type must be one of/, "bogus"));
  await check("an endpoint recipient", () =>
    throws(() => dev.controlIn({ type: "vendor", recipient: "endpoint", request: 1 }, 8), TypeError, /setup.recipient/, "endpoint"));
  await check("a byte out of range", () =>
    throws(() => dev.controlOut({ type: "vendor", recipient: "device", request: 5 }, [1, 256]), RangeError, /each byte/, "256"));
  await check("16 waiting, no more", async () => {
    const waiting = [];
    for (let i = 0; i < 16; i++) waiting.push(dev.controlIn(vendorIn(1), 4));
    throws(() => dev.controlIn(vendorIn(1), 4), RangeError, /16 transfers are waiting/, "17th");
    eq((await Promise.all(waiting)).length, 16, "all done");
  });

  // closing
  await check("a handle", () => {
    eq(Object.keys(dev).sort(), ["close", "controlIn", "controlOut", "device", "getFeatureReport", "setFeatureReport"], "keys");
    eq(dev.device.id, info.id, "its device");
  });
  dev.close();
  await check("after close", () => throws(() => dev.controlIn(vendorIn(1), 4), TypeError, /was closed/, "closed"));
  await check("a transfer waiting when closed", async () => {
    const d3 = usb.open(info);
    const p = d3.controlIn(vendorIn(1), 4);
    d3.close();
    await rejects(p, "closed", "closed");
  });

  // a device that doesn't answer: after two timeouts, no more transfers
  const dev2 = usb.open(info);
  await check("a timeout", () => rejects(dev2.controlIn(vendorIn(3), 4), "timeout", "timeout"));
  await check("it works after one timeout", async () => eq((await dev2.controlIn(vendorIn(1), 4)).length, 4, "length"));
  await check("a second timeout", () => rejects(dev2.controlOut({ type: "vendor", recipient: "device", request: 3 }), "timeout", "timeout"));
  await check("given up on until replugged", () => rejects(dev2.controlIn(vendorIn(1), 4), "timeout", "at once"));
}

async function replugged(d) {
  try {
    eq(usb.list().map((x) => x.id), [d.id], "listed");
    const dev = usb.open(d);
    const r = await dev.controlIn(vendorIn(1), 4);
    eq(r.length, 4, "length");
    console.log(`usbtest: replugged as device ${d.id}: transfers work again`);
  } catch (e) {
    fail("replugged", e);
  }
}
