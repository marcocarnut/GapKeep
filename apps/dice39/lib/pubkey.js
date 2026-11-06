// The account's public key, for a watch-only wallet: BIP-84 (native segwit)
// account m/84'/0'/<account>', on mainnet: its output descriptor,
// wpkh([fingerprint/84h/0h/<account>h]xpub.../<0;1>/*)#checksum
// (docs/plans/BITCOIN.md, "Public key export"), and the same key as a
// SLIP-132 zpub (Electrum's form), with the master key's fingerprint.
//
// BIP-39, BIP-32 and descriptors are the signer's (./bip39.js, ./bip32.js,
// ./descriptor.js and what they import are copies made by
// tools/share_libs.py; their home is apps/signer).
// The caller gives them the cryptography first: setCrypto(zg:crypto), or a
// stand-in under Node.
//
// Nothing here logs. The keys and the fingerprint identify the wallet: the
// caller logs their lengths at most.

import { seedFromMnemonic } from "./bip39.js";
import { HARDENED, fromSeed, derive, neuter, wipe, fingerprintHex, serializeXpub } from "./bip32.js";
import { accountDescriptor } from "./descriptor.js";

export const MAX_ACCOUNT = HARDENED - 1;

// words: the phrase's words; passphrase: the BIP-39 passphrase ("" is
// none); account: 0 to MAX_ACCOUNT. About 0.1 s on a Pi Zero (PBKDF2, 2048
// rounds of HMAC-SHA512), and blocks while it runs.
// -> { fingerprint (master, 8 hex digits), path, zpub, descriptor }
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
    const fingerprint = fingerprintHex(master);
    return { fingerprint, path, zpub: serializeXpub(pub, "zpub"),
      descriptor: accountDescriptor({ script: "p2wpkh", fingerprint, network: "mainnet", account,
        xpub: serializeXpub(pub, "xpub") }) };
  } finally {
    wipe(master);
    wipe(node);
  }
}

// BIP-84's test vector: the all-"abandon" phrase, no passphrase, account 0.
export function pubkeySelfTest() {
  const words = new Array(11).fill("abandon").concat("about");
  const k = accountKey(words, "", 0);
  const want = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
  if (k.zpub !== want) throw new Error("BIP-84 vector: wrong zpub");
  if (k.fingerprint !== "73c5da0a") throw new Error("BIP-84 vector: wrong master fingerprint");
  // the same key as a plain xpub, with BIP-380's checksum (computed by
  // tests/signer/check_descriptor.py)
  const descriptor = "wpkh([73c5da0a/84h/0h/0h]xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V/<0;1>/*)#qf45pmyh";
  if (k.descriptor !== descriptor) throw new Error("BIP-84 vector: wrong descriptor");
}
