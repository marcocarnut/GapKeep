// A DigiMacro board in JavaScript, as DigiMacroAsm's README ("The
// protocol", "The EEPROM") describes firmware 18 on core 4: enough of it
// to check apps/digimacro/lib/board.js and the app's flows under Node
// without a board. The real firmware runs in the scenario
// (tests/digimacro.txt, against simavr-softusb); this is the quick check.
//
//   const b = new FakeBoard(); b.open = true; const io = b.io();
//
// SPDX-License-Identifier: GPL-3.0-or-later

const F_INFO = 0x40, F_READ = 0x60, F_WRITE = 0x61, F_UNLOCK = 0x62, F_SETPASS = 0x63;
const F_CLOCK = 0x6c, F_REFUSED = 0xee;

export class FakeBoard {
  constructor({ firmware = 18 } = {}) {
    this.firmware = firmware;
    this.ee = new Uint8Array(512).fill(0xff);
    this.ee.set([0x78, 0x56, 0x34, 0x12], 0x1e0);    // the serial number
    this.open = false;          // the window: the pad was held
    this.unlocked = false;      // the password given since the window opened
    this.clock = null;          // seconds, once set
    this.report = new Uint8Array(36);
    this.log = [];              // [command, address, count] of each request
    this.fuses = [0x62, 0xd7, 0xfe, 0xfc];
    this.interfere = 0;         // answers another program takes first
  }

  get password() {
    if (this.ee[0x1f4] === 0xff) return null;
    let n = 0;
    while (n < 12 && this.ee[0x1f4 + n] !== 0) n++;
    return this.ee.slice(0x1f4, 0x1f4 + n);
  }

  state() {
    const pw = this.password !== null;
    return (this.open ? 0x01 : 0) | (pw ? 0x02 : 0) | (!pw || this.unlocked ? 0x04 : 0);
  }

  gated() {
    return this.open && (this.password === null || this.unlocked);
  }

  request(out) {
    const cmd = out[0], addr = out[1] | (out[2] << 8), count = out[3], data = out.slice(4, 4 + count);
    this.log.push([cmd, addr, count]);
    const a = new Uint8Array(36);
    a.set(out.slice(0, 4));
    const refuse = () => {
      a[0] = F_REFUSED;
    };
    if (cmd === F_INFO) {
      a.set([F_INFO, 0x44, 0x4d, 3, 4, 0x00, 0x02, this.state(), ...this.fuses, 0x01, this.firmware, 4]);
    } else if (cmd === F_UNLOCK) {
      const pw = this.password;
      if (!this.open) refuse();
      else if (pw === null || (pw.length === data.length && pw.every((v, i) => v === data[i]))) this.unlocked = true;
      else refuse();
    } else if (!this.gated()) {
      refuse();
    } else if (cmd === F_READ) {
      for (let i = 0; i < Math.min(count, 32); i++) a[4 + i] = addr + i < 512 ? this.ee[addr + i] : 0xff;
    } else if (cmd === F_WRITE) {
      for (let i = 0; i < Math.min(count, 32) && addr + i < 512; i++) this.ee[addr + i] = data[i];
    } else if (cmd === F_SETPASS) {
      this.ee.fill(0xff, 0x1f4, 0x200);
      if (count > 0) {
        this.ee.fill(0, 0x1f4, 0x200);
        this.ee.set(data.slice(0, 12), 0x1f4);
      }
      this.unlocked = true;
    } else if (cmd === F_CLOCK && this.firmware >= 18) {
      this.clock = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
    } else {
      refuse();
    }
    this.report = a;
  }

  // the transport board.js's Board takes: one report each way
  io() {
    return {
      send: async (out) => {
        this.request(out);
        if (this.interfere > 0) {                     // another program asks in between
          this.interfere--;
          this.request(Uint8Array.from([F_INFO, 0, 0, 0, ...new Array(32).fill(0)]));
        }
      },
      receive: async () => this.report.slice(),
    };
  }

  // The same over a gk:usb handle's feature reports, the report id first in
  // answers as Linux gives them when idFirst
  handle({ idFirst = false } = {}) {
    return {
      setFeatureReport: async (id, data) => {
        if (id !== 2 || data.length !== 36) throw new Error("bad SET_REPORT");
        this.request(Uint8Array.from(data));
      },
      getFeatureReport: async (id, len) => {
        const r = idFirst ? Uint8Array.from([2, ...this.report]) : this.report.slice();
        return r.slice(0, len);
      },
    };
  }
}
