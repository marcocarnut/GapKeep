// Output descriptors for an account: what a watch-only wallet imports.
//
//   accountDescriptor({ script, fingerprint, network, account, xpub })
//     -> "wpkh([73c5da0a/84h/0h/0h]xpub6.../<0;1>/*)#checksum"
//   cosignerKey({ fingerprint, network, account, xpub })
//     -> "[73c5da0a/48h/0h/0h/2h]xpub6...": BIP-48's P2WSH key, for one place
//     in a multisig wallet: a key expression, not a descriptor, as one signer
//     doesn't know the others
//   descriptorChecksum(text)  -> 8 characters (BIP-380)
//   checkDescriptor(text)     -> is its #checksum right?
//
// script: "p2wpkh" (BIP-84, wpkh), "p2sh-p2wpkh" (BIP-49, sh(wpkh)), "p2pkh"
// (BIP-44, pkh) or "p2tr" (BIP-86, tr, key path only). fingerprint: the MASTER key's, 8 hex digits: a
// wallet needs it to name its keys in PSBTs. network: "mainnet", or any other
// for coin type 1. account: 0 to 2^31 - 1. xpub: the account's public key, in
// the plain xpub or tpub form (descriptors don't use SLIP-132's), matching
// the network.
//
// `<0;1>` is BIP-389's: receive and change, in one descriptor. No imports,
// so tools/share_libs.py can copy it to any app.
//
// A descriptor is not secret, but it names every address of the account:
// log its length, not its content.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

const SCRIPTS = {
  p2wpkh: { purpose: 84, wrap: (key) => `wpkh(${key})` },
  "p2sh-p2wpkh": { purpose: 49, wrap: (key) => `sh(wpkh(${key}))` },
  p2pkh: { purpose: 44, wrap: (key) => `pkh(${key})` },
  p2tr: { purpose: 86, wrap: (key) => `tr(${key})` },
};

function polymod(symbols) {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
  }
  return chk;
}

function expand(text) {
  const symbols = [];
  let groups = [];
  for (const c of text) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) throw new RangeError("a descriptor has a character it can't have");
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups = [];
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  return symbols;
}

export function descriptorChecksum(text) {
  const sum = polymod([...expand(text), 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = "";
  for (let i = 0n; i < 8n; i++) out += CHECKSUM_CHARSET[Number((sum >> (5n * (7n - i))) & 31n)];
  return out;
}

export function checkDescriptor(text) {
  const at = text.length - 9;
  if (at < 0 || text[at] !== "#") return false;
  const sum = [...text.slice(at + 1)].map((c) => CHECKSUM_CHARSET.indexOf(c));
  if (sum.includes(-1)) return false;
  try {
    return polymod([...expand(text.slice(0, at)), ...sum]) === 1n;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}

function checkOrigin(fingerprint, network, account, xpub) {
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) throw new RangeError("a master fingerprint is 8 hex digits");
  if (!Number.isInteger(account) || account < 0 || account > 0x7fffffff) throw new RangeError("an account number is 0 to 2^31 - 1");
  const main = network === "mainnet";
  if (!xpub.startsWith(main ? "xpub" : "tpub")) throw new RangeError(`this needs a ${main ? "xpub" : "tpub"}`);
}

export function cosignerKey({ fingerprint, network, account, xpub }) {
  checkOrigin(fingerprint, network, account, xpub);
  return `[${fingerprint}/48h/${network === "mainnet" ? 0 : 1}h/${account}h/2h]${xpub}`;
}

export function accountDescriptor({ script, fingerprint, network, account, xpub }) {
  const s = SCRIPTS[script];
  if (!s) throw new RangeError(`no descriptor for ${script}`);
  checkOrigin(fingerprint, network, account, xpub);
  const key = `[${fingerprint}/${s.purpose}h/${network === "mainnet" ? 0 : 1}h/${account}h]${xpub}/<0;1>/*`;
  const body = s.wrap(key);
  return `${body}#${descriptorChecksum(body)}`;
}
