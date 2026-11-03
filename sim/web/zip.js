// zip.js - a minimal ZIP writer: "stored" entries only (no compression),
// which every unzip tool reads. Enough to export an app for an SD card.
//
//   const blob = makeZip ([{ name: "hello/main.js", data: "..." }, ...]);
//
// SPDX-License-Identifier: GPL-3.0-or-later

const CRC_TABLE = (() => {
  const t = new Uint32Array (256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}) ();

export function crc32 (bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date and time, as ZIP stores them (local time, 2 s resolution).
function dosDateTime (date) {
  const year = Math.max (1980, date.getFullYear ());
  return {
    time: (date.getHours () << 11) | (date.getMinutes () << 5) | (date.getSeconds () >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth () + 1) << 5) | date.getDate (),
  };
}

// entries: [{ name, data: string | Uint8Array }]. Returns a Blob.
export function makeZip (entries, date = new Date ()) {
  const enc = new TextEncoder ();
  const { time, date: day } = dosDateTime (date);
  const parts = [], central = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode (e.name);
    const data = typeof e.data === "string" ? enc.encode (e.data) : e.data;
    const crc = crc32 (data);

    // Local file header (30 bytes + name). Flag bit 11: names are UTF-8.
    const lh = new DataView (new ArrayBuffer (30));
    lh.setUint32 (0, 0x04034B50, true);
    lh.setUint16 (4, 10, true);           // version needed: 1.0
    lh.setUint16 (6, 0x0800, true);       // flags
    lh.setUint16 (8, 0, true);            // method: stored
    lh.setUint16 (10, time, true);
    lh.setUint16 (12, day, true);
    lh.setUint32 (14, crc, true);
    lh.setUint32 (18, data.length, true); // compressed size
    lh.setUint32 (22, data.length, true); // uncompressed size
    lh.setUint16 (26, name.length, true);
    lh.setUint16 (28, 0, true);           // extra field length
    parts.push (lh, name, data);

    // Central directory entry (46 bytes + name).
    const ch = new DataView (new ArrayBuffer (46));
    ch.setUint32 (0, 0x02014B50, true);
    ch.setUint16 (4, 0x031E, true);       // made by: Unix, spec 3.0
    ch.setUint16 (6, 10, true);
    ch.setUint16 (8, 0x0800, true);
    ch.setUint16 (10, 0, true);
    ch.setUint16 (12, time, true);
    ch.setUint16 (14, day, true);
    ch.setUint32 (16, crc, true);
    ch.setUint32 (20, data.length, true);
    ch.setUint32 (24, data.length, true);
    ch.setUint16 (28, name.length, true);
    // 30: extra, 32: comment, 34: disk number, 36: internal attributes: 0
    ch.setUint32 (38, (0o100644 << 16) >>> 0, true);  // external: -rw-r--r--
    ch.setUint32 (42, offset, true);      // where the local header is
    central.push (ch, name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce ((n, p) => n + p.byteLength, 0);
  const end = new DataView (new ArrayBuffer (22));
  end.setUint32 (0, 0x06054B50, true);
  end.setUint16 (8, entries.length, true);   // entries on this disk
  end.setUint16 (10, entries.length, true);  // entries in total
  end.setUint32 (12, centralSize, true);
  end.setUint32 (16, offset, true);          // where the central directory is
  return new Blob ([...parts, ...central, end], { type: "application/zip" });
}
