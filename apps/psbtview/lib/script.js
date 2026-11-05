// Output scripts: what kind they are, their addresses on each network, and
// back; multisig scripts; a readable disassembly.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { toHex, concat, DecodeError } from "./bytes.js";
import { segwitEncode, segwitDecode } from "./bech32.js";
import { base58CheckEncode, base58CheckDecode } from "./basen.js";

export const NETWORKS = {
  mainnet: { name: "Mainnet", hrp: "bc", p2pkh: 0x00, p2sh: 0x05, coinType: 0 },
  testnet: { name: "Testnet / Signet", hrp: "tb", p2pkh: 0x6f, p2sh: 0xc4, coinType: 1 },
  regtest: { name: "Regtest", hrp: "bcrt", p2pkh: 0x6f, p2sh: 0xc4, coinType: 1 },
};

export const TYPE_NAMES = {
  p2pkh: "P2PKH", p2sh: "P2SH", p2wpkh: "P2WPKH", p2wsh: "P2WSH", p2tr: "P2TR",
  witness: "Segwit (future version)", p2pk: "P2PK", multisig: "Bare multisig", op_return: "OP_RETURN",
  anchor: "P2A (anchor)", unknown: "Unknown",
};

const OP_0 = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d, OP_PUSHDATA4 = 0x4e, OP_1 = 0x51, OP_16 = 0x60;
const OP_RETURN = 0x6a, OP_DUP = 0x76, OP_EQUAL = 0x87, OP_EQUALVERIFY = 0x88, OP_HASH160 = 0xa9;
const OP_CHECKSIG = 0xac, OP_CHECKMULTISIG = 0xae;

// Splits a script into ops: [{ op, data? }]. null if a push runs past the end.
export function parseScript(script) {
  const ops = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let n = -1;
    if (op >= 1 && op <= 75) n = op;
    else if (op === OP_PUSHDATA1) {
      if (i + 1 > script.length) return null;
      n = script[i];
      i += 1;
    } else if (op === OP_PUSHDATA2) {
      if (i + 2 > script.length) return null;
      n = script[i] | (script[i + 1] << 8);
      i += 2;
    } else if (op === OP_PUSHDATA4) {
      if (i + 4 > script.length) return null;
      n = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] << 24)) >>> 0;
      i += 4;
    }
    if (n >= 0) {
      if (i + n > script.length) return null;
      ops.push({ op, data: script.subarray(i, i + n) });
      i += n;
    } else {
      ops.push({ op });
    }
  }
  return ops;
}

const OP_NAMES = {
  0x00: "OP_0", 0x4f: "OP_1NEGATE", 0x61: "OP_NOP", 0x63: "OP_IF", 0x64: "OP_NOTIF", 0x67: "OP_ELSE",
  0x68: "OP_ENDIF", 0x69: "OP_VERIFY", 0x6a: "OP_RETURN", 0x75: "OP_DROP", 0x76: "OP_DUP", 0x82: "OP_SIZE",
  0x87: "OP_EQUAL", 0x88: "OP_EQUALVERIFY", 0xa8: "OP_SHA256", 0xa9: "OP_HASH160", 0xaa: "OP_HASH256",
  0xac: "OP_CHECKSIG", 0xad: "OP_CHECKSIGVERIFY", 0xae: "OP_CHECKMULTISIG", 0xaf: "OP_CHECKMULTISIGVERIFY",
  0xb1: "OP_CHECKLOCKTIMEVERIFY", 0xb2: "OP_CHECKSEQUENCEVERIFY", 0xba: "OP_CHECKSIGADD",
};

export function disassemble(script) {
  const ops = parseScript(script);
  if (ops === null) return "(malformed) " + toHex(script);
  return ops.map(({ op, data }) => {
    if (data) return toHex(data) || "OP_0";
    if (op >= OP_1 && op <= OP_16) return "OP_" + (op - 0x50);
    return OP_NAMES[op] || "OP_UNKNOWN_" + op.toString(16);
  }).join(" ");
}

const smallInt = (op) => (op === OP_0 ? 0 : op >= OP_1 && op <= OP_16 ? op - 0x50 : -1);

// m-of-n CHECKMULTISIG with compressed or uncompressed keys:
// { m, n, pubkeys } or null.
export function parseMultisig(script) {
  const ops = parseScript(script);
  if (!ops || ops.length < 4 || ops[ops.length - 1].op !== OP_CHECKMULTISIG) return null;
  const m = smallInt(ops[0].op), n = smallInt(ops[ops.length - 2].op);
  if (ops[0].data || ops[ops.length - 2].data) return null;
  if (m < 1 || n < m || ops.length !== n + 3) return null;
  const pubkeys = [];
  for (let i = 1; i <= n; i++) {
    const k = ops[i].data;
    if (!k || (k.length !== 33 && k.length !== 65)) return null;
    pubkeys.push(k);
  }
  return { m, n, pubkeys };
}

// The kind of an output script: { type, hash? (the hash or key it pays to),
// version?, program? }.
export function classify(script) {
  const s = script, n = s.length;
  if (n === 25 && s[0] === OP_DUP && s[1] === OP_HASH160 && s[2] === 20 && s[23] === OP_EQUALVERIFY && s[24] === OP_CHECKSIG) {
    return { type: "p2pkh", hash: s.subarray(3, 23) };
  }
  if (n === 23 && s[0] === OP_HASH160 && s[1] === 20 && s[22] === OP_EQUAL) return { type: "p2sh", hash: s.subarray(2, 22) };
  // witness programs: a version (OP_0, OP_1..OP_16), then one push of 2-40 bytes
  if (n >= 4 && n <= 42 && (s[0] === OP_0 || (s[0] >= OP_1 && s[0] <= OP_16)) && s[1] === n - 2) {
    const version = smallInt(s[0]), program = s.subarray(2);
    if (version === 0 && program.length === 20) return { type: "p2wpkh", version, program, hash: program };
    if (version === 0 && program.length === 32) return { type: "p2wsh", version, program, hash: program };
    if (version === 0) return { type: "unknown" }; // v0 must be 20 or 32 bytes
    if (version === 1 && program.length === 32) return { type: "p2tr", version, program };
    if (version === 1 && program.length === 2 && program[0] === 0x4e && program[1] === 0x73) {
      return { type: "anchor", version, program };
    }
    return { type: "witness", version, program };
  }
  if (n >= 1 && s[0] === OP_RETURN) return { type: "op_return" };
  if ((n === 35 && s[0] === 33 && (s[1] === 2 || s[1] === 3) && s[34] === OP_CHECKSIG) ||
      (n === 67 && s[0] === 65 && s[1] === 4 && s[66] === OP_CHECKSIG)) {
    return { type: "p2pk", pubkey: s.subarray(1, n - 1) };
  }
  if (parseMultisig(s)) return { type: "multisig" };
  return { type: "unknown" };
}

// The address of an output script on `network` (a key of NETWORKS), or null
// when it has none (OP_RETURN, P2PK, bare multisig, unknown).
export function scriptToAddress(script, network) {
  const net = NETWORKS[network];
  const c = classify(script);
  switch (c.type) {
    case "p2pkh": return base58CheckEncode(concat([Uint8Array.of(net.p2pkh), c.hash]));
    case "p2sh": return base58CheckEncode(concat([Uint8Array.of(net.p2sh), c.hash]));
    case "p2wpkh": case "p2wsh": case "p2tr": case "anchor": case "witness":
      return segwitEncode(net.hrp, c.version, c.program);
    default: return null;
  }
}

// The output script an address pays to, on `network`. Throws DecodeError.
export function addressToScript(address, network) {
  const net = NETWORKS[network];
  if (address.toLowerCase().startsWith(net.hrp + "1")) {
    const { version, program } = segwitDecode(address, net.hrp);
    return concat([Uint8Array.of(version === 0 ? 0 : 0x50 + version, program.length), program]);
  }
  const payload = base58CheckDecode(address);
  if (payload.length !== 21) throw new DecodeError("address: wrong length");
  const hash = payload.subarray(1);
  if (payload[0] === net.p2pkh) return concat([Uint8Array.of(OP_DUP, OP_HASH160, 20), hash, Uint8Array.of(OP_EQUALVERIFY, OP_CHECKSIG)]);
  if (payload[0] === net.p2sh) return concat([Uint8Array.of(OP_HASH160, 20), hash, Uint8Array.of(OP_EQUAL)]);
  throw new DecodeError("address: not for this network");
}

// Script templates, for checks against scripts given in a PSBT.
export const p2wpkhScript = (hash20) => concat([Uint8Array.of(0, 20), hash20]);
export const p2wshScript = (hash32) => concat([Uint8Array.of(0, 32), hash32]);
export const p2shScript = (hash20) => concat([Uint8Array.of(OP_HASH160, 20), hash20, Uint8Array.of(OP_EQUAL)]);
export const p2pkhScript = (hash20) => concat([Uint8Array.of(OP_DUP, OP_HASH160, 20), hash20, Uint8Array.of(OP_EQUALVERIFY, OP_CHECKSIG)]);
