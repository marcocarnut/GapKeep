// USB probe, test builds only: lists the USB devices claimed for it (its
// manifest's "usb"), and probes one: its device descriptor, the start of
// each HID interface's report descriptor, and, for a device it knows, one
// feature report exchange. Built to check gk:usb on real hardware (a
// DigiMacro, 16c0:27db, through a hub: docs/RIG.md) and in the simulator
// against tests/usb/usbip_stub.py's device (1209:0001).
//
// The screen shows what the device answered, in hex; the log has lengths
// only, never the bytes (a report may hold anything).
//
// Keys: Tab / Shift+Tab or the arrows move between devices, Enter probes
// the focused one. A device that comes is probed at once.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ui from "gk:ui";
import * as usb from "gk:usb";

// Feature reports to ask for, by device: the report id, the bytes after
// it to send with SET_REPORT, the length to read back with GET_REPORT, and
// what the answer should look like.
const PROBES = {
  // DigiMacro's INFO request: command 0x40 in a 36-byte report, id 2;
  // its answer echoes the command (and is 37 bytes at most)
  "16c0:27db": { id: 2, send: [0x40, ...new Array(35).fill(0)], length: 37,
                 expect: (a) => a.length > 0 && (a[0] === 0x40 || (a[0] === 2 && a[1] === 0x40)),
                 what: "the answer echoes INFO (0x40)" },
  // the test stub's report 1: what was set comes back, after the id
  "1209:0001": { id: 1, send: Array.from({ length: 32 }, (_, i) => i), length: 33,
                 expect: (a) => a.length === 33 && a[0] === 1 && a[32] === 31,
                 what: "the answer is what was set" },
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
const idOf = (d) => d.vid.toString(16).padStart(4, "0") + ":" + d.pid.toString(16).padStart(4, "0");

new ui.Label({ text: "USB probe", font: 24 });
const help = new ui.Label({ text: "Plug in a device this app lists: " + Object.keys(PROBES).join(", ") + ". Enter probes the focused one.", width: "100%" });
const list = new ui.Container({ layout: "column", width: "100%", height: "content", gap: 6 });
const result = new ui.Label({ text: "", mono: true, font: 14, width: "100%" });

let busy = false;

function refresh() {
  list.clear();
  const devices = usb.list();
  console.log(`usbprobe: ${devices.length} device(s)`);
  for (const d of devices) {
    const b = new ui.Button(list, {
      text: `${idOf(d)}  ${d.manufacturer} ${d.product}  (${d.speed} speed, ${d.interfaces.length} interfaces)`,
      onClick: () => probe(d),
    });
    if (d === devices[0]) b.focus();
  }
  if (devices.length === 0) result.text = "No device.";
}

async function probe(d) {
  if (busy) return;
  busy = true;
  const lines = [`Device ${d.id}: ${idOf(d)}`, `  manufacturer: ${d.manufacturer}`, `  product: ${d.product}`,
                 `  serial: ${d.serial ?? "(none)"}`, `  speed: ${d.speed}`];
  for (const i of d.interfaces) lines.push(`  interface ${i.number}: class ${i.class}, subclass ${i.subclass}, protocol ${i.protocol}`);
  result.text = lines.join("\n") + "\n...";
  console.log(`usbprobe: probing device ${d.id}, ${idOf(d)}, ${d.interfaces.length} interface(s)`);
  let dev = null;
  try {
    dev = usb.open(d);
    const desc = await dev.controlIn({ type: "standard", recipient: "device", request: 6, value: 0x0100 }, 18);
    console.log(`usbprobe: device descriptor: ${desc.length} bytes`);
    lines.push(`device descriptor (${desc.length}): ${hex(desc)}`);
    for (const i of d.interfaces.filter((i) => i.class === 3)) {
      const rd = await dev.controlIn({ type: "standard", recipient: "interface", request: 6, value: 0x2200, index: i.number }, 64);
      console.log(`usbprobe: interface ${i.number}: report descriptor, ${rd.length} bytes (64 asked)`);
      lines.push(`report descriptor ${i.number} (${rd.length}): ${hex(rd)}`);
    }
    const p = PROBES[idOf(d)];
    if (p) {
      await dev.setFeatureReport(p.id, p.send);
      const a = await dev.getFeatureReport(p.id, p.length);
      const good = p.expect(a);
      console.log(`usbprobe: feature report ${p.id}: sent ${p.send.length + 1} bytes, got ${a.length}; ${p.what}: ${good}`);
      lines.push(`feature report ${p.id} (${a.length}): ${hex(a)}`, `${p.what}: ${good ? "yes" : "NO"}`);
    }
    console.log(`usbprobe: device ${d.id} probed`);
  } catch (e) {
    console.log(`usbprobe: device ${d.id}: ${e.name}: ${e.code ?? ""} ${e.message}`);
    lines.push(`failed: ${e.code ?? e.name}: ${e.message}`);
  } finally {
    if (dev) dev.close();
    busy = false;
  }
  result.text = lines.join("\n");
}

usb.onAttach((d) => {
  refresh();
  probe(d);
});
usb.onDetach((d) => {
  console.log(`usbprobe: device ${d.id} detached`);
  refresh();
});
refresh();
console.log("usbprobe ready");
const first = usb.list()[0];
if (first) probe(first);
