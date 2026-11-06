// The account's public key, for a watch-only wallet: BIP-84 (native segwit)
// account m/84'/0'/<account>', on mainnet, as a SLIP-132 zpub (Electrum's
// form), with the master key's fingerprint.
//
// BIP-39 and BIP-32 are the signer's (./bip39.js, ./bip32.js and what they
// import are copies made by tools/share_libs.py; their home is apps/signer).
// The caller gives them the cryptography first: setCrypto(zg:crypto), or a
// stand-in under Node.
//
// The output descriptor, wpkh([fingerprint/84h/0h/<account>h]xpub.../<0;1>/*)
// with its checksum (docs/plans/BITCOIN.md, "Public key export"), comes from
// the signer's library once it has it (milestone S1b): see `descriptor`
// below.
//
// Nothing here logs. The zpub and the fingerprint identify the wallet: the
// caller logs their lengths at most.

import { seedFromMnemonic } from "./bip39.js";
import { HARDENED, fromSeed, derive, neuter, wipe, fingerprintHex, serializeXpub } from "./bip32.js";

export const MAX_ACCOUNT = HARDENED - 1;

// words: the phrase's words; passphrase: the BIP-39 passphrase ("" is
// none); account: 0 to MAX_ACCOUNT. About 0.1 s on a Pi Zero (PBKDF2, 2048
// rounds of HMAC-SHA512), and blocks while it runs.
// -> { fingerprint (master, 8 hex digits), path, zpub, descriptor (null) }
export function accountKey(words, passphrase, account) {
  if (!Number.isInteger(account) || account < 0 || account > MAX_ACCOUNT) {
    throw new RangeError(`an account number is 0 to ${MAX_ACCOUNT}`);
  }
  const seed = seedFromMnemonic(words.join(" "), passphrase);
  let master;
  try {
    master = fromSeed(seed);
  } finally {
    seed.fill(0);
  }
  const path = `m/84'/0'/${account}'`;
  let node;
  try {
    node = derive(master, [84 + HARDENED, 0 + HARDENED, account + HARDENED]);
    const pub = neuter(node);
    return { fingerprint: fingerprintHex(master), path, zpub: serializeXpub(pub, "zpub"),
      descriptor: descriptor() };
  } finally {
    wipe(master);
    wipe(node);
  }
}

// The place for the account's output descriptor: null until the signer's
// library exports descriptors (S1b). Then: import its function, build
// wpkh([fingerprint/84h/0h/<account>h]xpub.../<0;1>/*)#checksum from the
// master fingerprint and the neutered account node, and main.js shows it
// next to the zpub (showPublicKey, "descriptor").
function descriptor() {
  return null;
}

// BIP-84's test vector: the all-"abandon" phrase, no passphrase, account 0.
export function pubkeySelfTest() {
  const words = new Array(11).fill("abandon").concat("about");
  const k = accountKey(words, "", 0);
  const want = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
  if (k.zpub !== want) throw new Error("BIP-84 vector: wrong zpub");
  if (k.fingerprint !== "73c5da0a") throw new Error("BIP-84 vector: wrong master fingerprint");
}
