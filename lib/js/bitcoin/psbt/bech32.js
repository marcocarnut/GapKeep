// Bech32 (BIP-173) and Bech32m (BIP-350), and segwit addresses.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { DecodeError } from "./bytes.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_INV = new Int8Array(128).fill(-1);
for (let i = 0; i < 32; i++) CHARSET_INV[CHARSET.charCodeAt(i)] = i;

export const BECH32 = 1, BECH32M = 0x2bc830a3;
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// data: 5-bit values. encoding: BECH32 or BECH32M.
export function bech32Encode(hrp, data, encoding) {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ encoding;
  let s = hrp + "1";
  for (const d of data) s += CHARSET[d];
  for (let i = 0; i < 6; i++) s += CHARSET[(mod >>> (5 * (5 - i))) & 31];
  return s;
}

// -> { hrp, data (5-bit values), encoding }. Throws DecodeError.
export function bech32Decode(text, limit = 90) {
  if (text.length > limit) throw new DecodeError("Bech32: too long");
  let lower = false, upper = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 33 || c > 126) throw new DecodeError("Bech32: invalid character");
    if (c >= 97 && c <= 122) lower = true;
    if (c >= 65 && c <= 90) upper = true;
  }
  if (lower && upper) throw new DecodeError("Bech32: mixed case");
  const s = text.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1) throw new DecodeError("Bech32: no human-readable part");
  if (pos + 7 > s.length) throw new DecodeError("Bech32: checksum too short");
  const hrp = s.slice(0, pos);
  const data = [];
  for (let i = pos + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? CHARSET_INV[c] : -1;
    if (v < 0) throw new DecodeError("Bech32: invalid data character");
    data.push(v);
  }
  const mod = polymod(hrpExpand(hrp).concat(data));
  const encoding = mod === BECH32 ? BECH32 : mod === BECH32M ? BECH32M : null;
  if (encoding === null) throw new DecodeError("Bech32: wrong checksum");
  return { hrp, data: data.slice(0, -6), encoding };
}

// Regroups bits (8 -> 5 with pad, 5 -> 8 without). Returns null when the
// padding is not valid.
export function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

export function segwitEncode(hrp, version, program) {
  return bech32Encode(hrp, [version].concat(convertBits(program, 8, 5, true)), version === 0 ? BECH32 : BECH32M);
}

// -> { hrp, version, program } or throws DecodeError. `hrp`: the expected
// one, or null for any.
export function segwitDecode(address, hrp = null) {
  const d = bech32Decode(address);
  if (hrp !== null && d.hrp !== hrp) throw new DecodeError("segwit address: wrong human-readable part");
  if (d.data.length < 1) throw new DecodeError("segwit address: empty");
  const version = d.data[0];
  if (version > 16) throw new DecodeError("segwit address: invalid witness version");
  const program = convertBits(d.data.slice(1), 5, 8, false);
  if (program === null) throw new DecodeError("segwit address: invalid padding");
  if (program.length < 2 || program.length > 40) throw new DecodeError("segwit address: invalid program length");
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new DecodeError("segwit address: invalid program length for version 0");
  }
  if ((version === 0) !== (d.encoding === BECH32)) {
    throw new DecodeError(version === 0 ? "segwit address: version 0 must use Bech32" : "segwit address: version 1+ must use Bech32m");
  }
  return { hrp: d.hrp, version, program: Uint8Array.from(program) };
}
