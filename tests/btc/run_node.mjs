// Tests lib/js/bitcoin/btc.js under Node, with tests/signer/crypto_ref.mjs in
// place of gk:crypto, against the BIPs' own vectors (BIP-32 vectors 1;
// BIP-39 "abandon ... about", public, as BIP-44, 49, 84 and 86 use it):
//
//   node --experimental-default-type=module tests/btc/run_node.mjs [-v]
//
// SPDX-License-Identifier: GPL-3.0-or-later
import * as ref from "../signer/crypto_ref.mjs";
import { btc, setCrypto, BtcError } from "../../lib/js/bitcoin/btc.js";

setCrypto(ref);
const verbose = process.argv.includes("-v");
let passed = 0, failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r === true) {
      passed++;
      if (verbose) console.log("ok   " + name);
    } else {
      failed++;
      console.log("FAIL " + name + ": " + JSON.stringify(r));
    }
  } catch (e) {
    failed++;
    console.log("FAIL " + name + ": threw " + e.name + ": " + e.message);
  }
}
const eq = (got, want) => (got === want ? true : { got, want });
function throws(fn, has) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof BtcError)) return { threw: e.name + ": " + e.message };
    return e.message.includes(has) ? true : { message: e.message, want: has };
  }
  return "did not throw";
}

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const m = btc.words(ABANDON);

// BIP-32, test vector 1
const SEED1 = "000102030405060708090a0b0c0d0e0f";
check("BIP-32 1: master xpub", () => eq(btc.seed(SEED1).xpub(),
  "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8"));
check("BIP-32 1: master xprv", () => eq(btc.seed(SEED1).xprv(),
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"));
check("BIP-32 1: m/0H xpub", () => eq(btc.seed(SEED1).derive("m/0'").xpub(),
  "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw"));
check("BIP-32 1: m/0H/1/2H/2/1000000000 xpub, in steps", () => eq(btc.seed(SEED1).derive("m/0h/1").derive("2'/2").derive("1000000000").xpub(),
  "xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy"));
check("BIP-32 1: m/0H/1/2H/2/1000000000 xprv", () => eq(btc.seed(SEED1).derive("m/0'/1/2'/2/1000000000").xprv(),
  "xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76"));
check("BIP-32 1: public derivation matches private", () => eq(btc.xpub(btc.seed(SEED1).derive("m/0'/1").xpub()).derive("2/7").publicKey,
  btc.seed(SEED1).derive("m/0'/1/2/7").publicKey));

// BIP-39 and the account BIPs
check("BIP-39: master fingerprint", () => eq(m.fingerprint(), "73c5da0a"));
check("BIP-39: passphrase TREZOR, master xprv (BIP-39 vectors)", () => eq(
  btc.words(ABANDON, "TREZOR").xprv(),
  "xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF"));
check("BIP-39: entropy and back", () => eq(btc.mnemonic(btc.entropy(ABANDON)), ABANDON));
check("BIP-39: entropy", () => eq(btc.entropy(ABANDON), "00000000000000000000000000000000"));
check("BIP-44: m/44'/0'/0'/0/0", () => eq(m.derive("m/44'/0'/0'/0/0").address(), "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"));
check("BIP-84: m/84'/0'/0'/0/0", () => eq(m.derive("m/84'/0'/0'/0/0").address(), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"));
check("BIP-84: m/84'/0'/0'/1/0 (change)", () => eq(m.derive("m/84'/0'/0'/1/0").address(), "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"));
check("BIP-84: account zpub", () => eq(m.derive("m/84'/0'/0'").xpub("zpub"),
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"));
check("BIP-84: account zprv", () => eq(m.derive("m/84'/0'/0'").xprv("zprv"),
  "zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE"));
check("BIP-84: the zpub's own type, from a relative path", () => eq(
  btc.xpub(m.derive("m/84'/0'/0'").xpub("zpub")).derive("0/0").address(), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"));
check("BIP-84: WIF of m/84'/0'/0'/0/0", () => eq(m.derive("m/84'/0'/0'/0/0").wif(), "KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d"));
check("BIP-84: public key of m/84'/0'/0'/0/0", () => eq(m.derive("m/84'/0'/0'/0/0").publicKey,
  "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c"));
check("BIP-86: m/86'/0'/0'/0/0", () => eq(m.derive("m/86'/0'/0'/0/0").address(),
  "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"));
check("BIP-86: m/86'/0'/0'/1/0", () => eq(m.derive("m/86'/0'/0'/1/0").address(),
  "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7"));
check("BIP-86: account xpub", () => eq(m.derive("m/86'/0'/0'").xpub(),
  "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ"));

btc.network = "testnet";
const tm = btc.words(ABANDON);
check("BIP-49 (testnet): m/49'/1'/0'/0/0", () => eq(tm.derive("m/49'/1'/0'/0/0").address(), "2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2"));
check("BIP-49 (testnet): account tprv", () => eq(tm.derive("m/49'/1'/0'").xprv("uprv").slice(0, 4), "uprv"));
check("testnet: m/84'/1'/0'/0/0", () => eq(tm.derive("m/84'/1'/0'/0/0").address(), "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"));
check("testnet: descriptor", () => eq(tm.derive("m/84'/1'/0'").descriptor().split("#")[0],
  "wpkh([73c5da0a/84h/1h/0h]tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M/<0;1>/*)"));
check("testnet: an xpub version of mainnet is refused", () => throws(() => tm.xpub("zpub"), "testnet key"));
btc.network = "mainnet";
check("descriptor (BIP-84 account)", () => eq(m.derive("m/84'/0'/0'").descriptor(),
  "wpkh([73c5da0a/84h/0h/0h]xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V/<0;1>/*)#qf45pmyh"));

// Single keys
const K1 = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";   // private key 1
check("WIF: private key 1, its address", () => eq(btc.wif(K1).address("p2pkh"), "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"));
check("WIF: and back", () => eq(btc.wif(K1).wif(), K1));
check("WIF: uncompressed key 1", () => eq(btc.wif("5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf").address(), "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm"));
check("WIF: no type said", () => throws(() => btc.wif(K1).address(), "address type"));
check("pubkey: segwit address", () => eq(btc.pubkey("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798").address("segwit"),
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"));

// Addresses and amounts
check("address: segwit", () => eq(JSON.stringify(btc.address("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")),
  '{"type":"p2wpkh","network":"mainnet","script":"0014751e76e8199196d454941c45d1b3a323f1433bd6"}'));
check("address: testnet P2SH", () => eq(btc.address("2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2").type, "p2sh"));
check("address: refused", () => throws(() => btc.address("bc1qnotanaddress"), "not an address"));
check("sats", () => eq(btc.sats(0.00119), 119000));
check("sats, text", () => eq(btc.sats("21000000"), 21e14));
check("sats, 0.1 + 0.2", () => eq(btc.sats(0.1 + 0.2), 30000000));
check("sats, too many decimals", () => throws(() => btc.sats("0.123456789"), "8 decimals"));
check("btc", () => eq(btc.btc(119000), "0.00119000"));
check("btc, negative", () => eq(btc.btc(-5), "-0.00000005"));

// Errors: what is wrong, never what was typed
const BAD = ABANDON.replace("about", "abandon");   // every word in the list, the checksum wrong
check("words: checksum", () => throws(() => btc.words(BAD), "checksum"));
check("words: a word not in the list, by position", () => throws(() => btc.words(ABANDON.replace("about", "zzzz")), "word 12"));
for (const [name, fn] of [["words", () => btc.words(ABANDON.replace("about", "secretword"))],
  ["xprv", () => btc.xprv("xprvSECRETSECRET")], ["wif", () => btc.wif("KwSECRETSECRET")]]) {
  check(`${name}: the error quotes nothing typed`, () => {
    try {
      fn();
    } catch (e) {
      return /secret/i.test(e.message) ? { message: e.message } : true;
    }
    return "did not throw";
  });
}
check("public: no hardened child", () => throws(() => btc.xpub(m.derive("m/84'/0'/0'").xpub()).derive("0'"), "hardened"));
check("public: no xprv", () => throws(() => m.neuter().xprv(), "public key"));
check("path: not below this key", () => throws(() => m.derive("m/84'/0'/0'").derive("m/44'/0'"), "not below"));
check("path: below this key", () => eq(m.derive("m/84'/0'").derive("m/84'/0'/0'/0/0").address(), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"));
check("path: no type for m/0/1", () => throws(() => m.derive("m/0/1").address(), "address type"));
check("type: unknown", () => throws(() => m.derive("m/84'/0'/0'/0/0").address("p2xyz"), "no address type"));
check("network: unknown", () => throws(() => (btc.network = "moon"), "no network"));
check("printing a key shows no secret", () => {
  const k = m.derive("m/84'/0'/0'");
  const s = String(k) + JSON.stringify({ k });
  return !s.includes(k.xprv().slice(4, 20)) && s === "Key (private, mainnet, m/84'/0'/0', fingerprint " + k.fingerprint() + ")" +
    JSON.stringify({ k: String(k) }) ? true : { s };
});
check("wipe: then public", () => {
  const k = m.derive("m/84'/0'/0'/0/0");
  const addr = k.address();
  k.wipe();
  return !k.isPrivate && k.address() === addr ? true : { isPrivate: k.isPrivate };
});
check("help, at most 56 columns", () => String(btc.help()).split("\n").every((l) => l.length <= 56) && /btc\.words/.test(String(btc.help())) && JSON.stringify(btc.help()) === JSON.stringify(String(btc.help())));

console.log(`btc tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
