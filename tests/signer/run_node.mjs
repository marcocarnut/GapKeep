// Tests lib/js/bitcoin (BIP-39, BIP-32, sighashes, signing PSBTs) and the signer's own lib under
// Node, with tests/signer/crypto_ref.mjs in place of gk:crypto, against
// tests/signer/vectors.json, tests/signer/electrum.json and BIP-174's
// vectors in tests/psbt/vectors.json (sources: tests/signer/README.md):
//
//   node --experimental-default-type=module tests/signer/run_node.mjs [-v]
//        [--electrum-out FILE]   (writes what we signed, for make_electrum_vectors.py --check)
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import * as ref from "./crypto_ref.mjs";
import { setCrypto, taggedHash, hash160 } from "../../lib/js/bitcoin/crypto.js";
import { mnemonicFromEntropy, entropyFromMnemonic, seedFromMnemonic, Bip39Error } from "../../lib/js/bitcoin/bip39.js";
import {
  fromSeed, derive, deriveChild, parsePath, formatPath, neuter, fingerprint, serializeXpub, parseXpub, decodeExtendedKey,
  wipe, VERSIONS, versionFor, Bip32Error, HARDENED,
} from "../../lib/js/bitcoin/bip32.js";
import { legacySighash, segwitV0Sighash, taprootSighash, taprootSigMsg, p2wpkhScriptCode } from "../../lib/js/bitcoin/sighash.js";
import { plan, signPsbt, verifyChange, finalize, planKeys, signKeys, partialSigGood, SignError, CHANGE_NEAR, CHANGE_GAP } from "../../lib/js/bitcoin/sign.js";
import { parsePrivateKey, parseWif, KeyError } from "../../lib/js/bitcoin/keys.js";
import { combine, CombineError } from "../../lib/js/bitcoin/combine.js";
import { applyPlan } from "../../apps/signer/lib/review.js";
import { SignedMemory, MAX_ENTRIES } from "../../apps/signer/lib/memory.js";
import { analyze } from "../../lib/js/bitcoin/psbt/analyze.js";
import { base58CheckEncode, base58CheckDecode } from "../../lib/js/bitcoin/psbt/basen.js";
import { CodeReader, seriesFor, sizeProblem } from "../../apps/signer/lib/codes.js";
// codes.js is the signer's own: it throws the DecodeError of the signer's copy of bytes.js
import { DecodeError as CodesDecodeError } from "../../apps/signer/lib/psbt/bytes.js";
import { split, deflateRaw, toBase32, Joiner } from "../../lib/js/bbqr.js";
import { accountDescriptor, cosignerKey, descriptorChecksum, checkDescriptor } from "../../lib/js/bitcoin/descriptor.js";
import { selfTest } from "../../apps/signer/lib/selftest.js";
import { fromHex, toHex, equal, concat, Writer, fromBase64, DecodeError } from "../../lib/js/bitcoin/psbt/bytes.js";
import { parseTx, serializeTx, txid as txidOf } from "../../lib/js/bitcoin/psbt/tx.js";
import { parsePsbt, serializePsbt, setEntry, IN, OUT, GLOBAL, MAGIC } from "../../lib/js/bitcoin/psbt/psbt.js";
import { readPayload, electrumQrText } from "../../lib/js/bitcoin/psbt/transport.js";
import { scriptToAddress, p2wpkhScript, p2shScript, p2pkhScript, p2wshScript, parseMultisig, classify } from "../../lib/js/bitcoin/psbt/script.js";
import { multisigScript } from "../../lib/js/bitcoin/multisig.js";

setCrypto(ref);

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const E = JSON.parse(readFileSync(new URL("./electrum.json", import.meta.url), "utf8"));
const PSBT_V = JSON.parse(readFileSync(new URL("../psbt/vectors.json", import.meta.url), "utf8"));
const KAT = readFileSync(new URL("../../src/crypto/secp_kat.h", import.meta.url), "utf8");
const BIP340 = readFileSync(new URL("../native/bip340-vectors.csv", import.meta.url), "utf8");

const verbose = process.argv.includes("-v");
const outIdx = process.argv.indexOf("--electrum-out");
const electrumOut = outIdx > 0 ? process.argv[outIdx + 1] : null;
const madeIdx = process.argv.indexOf("--made-out");
const madeOut = madeIdx > 0 ? process.argv[madeIdx + 1] : null;
const counts = {};
const failures = [];

function check(group, name, fn) {
  counts[group] = counts[group] || { passed: 0, failed: 0 };
  try {
    const r = fn();
    if (r === false) throw new Error("check returned false");
    counts[group].passed++;
    if (verbose) console.log("ok  ", group, name);
  } catch (e) {
    counts[group].failed++;
    failures.push(`${group}: ${name}: ${e && e.message}`);
  }
}

function eq(a, b, what = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${what} got ${sa.slice(0, 300)}, want ${sb.slice(0, 300)}`);
}

function throws(fn, cls, what = "") {
  try {
    fn();
  } catch (e) {
    if (!cls || e instanceof cls) return e;
    throw new Error(`${what} threw ${e && e.name}: ${e && e.message}`);
  }
  throw new Error(`${what} did not throw`);
}

const has = (text, part) => {
  if (!text || !text.includes(part)) throw new Error(`"${text}" doesn't say "${part}"`);
  return true;
};

const hexOf = (x) => (typeof x === "string" ? x : toHex(x));

// --- the reference secp256k1 itself, against libsecp256k1's answers ------------

for (const m of KAT.matchAll(/\{ "([0-9a-f]{64})", "([0-9a-f]{64})", "([0-9a-f]{64})",\s*"([0-9a-f]{130})",\s*"([0-9a-f]+)",\s*"([0-9a-f]{64})", "([0-9a-f]{66})",\s*"([0-9a-f]{64})", "([0-9a-f]{64})", (\d) \}/g)) {
  const [, sk, tw, h, pub65, der, tweaked, tweakedPub, tap, tapPub, parity] = m;
  check("reference", "secp_kat.h " + sk.slice(0, 8), () => {
    const k = fromHex(sk), t = fromHex(tw);
    eq(toHex(ref.publicKey(k, false)), pub65, "pubkey");
    eq(toHex(ref.ecdsaSign(fromHex(h), k)), der, "ecdsa (low R)");
    eq(toHex(ref.privateKeyTweakAdd(k, t)), tweaked, "tweak add");
    eq(toHex(ref.publicKeyTweakAdd(ref.publicKey(k), t)), tweakedPub, "pub tweak add");
    eq(toHex(ref.taprootTweakPrivateKey(k, t)), tap, "taproot seckey");
    const q = ref.taprootTweakPublicKey(ref.xOnlyPublicKey(k), t);
    eq([toHex(q.key), q.parity], [tapPub, Number(parity)], "taproot pubkey");
    return ref.ecdsaVerify(fromHex(der), fromHex(h), ref.publicKey(k));
  });
}
for (const line of BIP340.trim().split("\n").slice(1)) {
  const [i, sk, pk, aux, msg, sig, res] = line.split(",");
  if (sk && msg.length === 64) {
    check("reference", "BIP-340 sign " + i, () => eq(toHex(ref.schnorrSign(fromHex(msg), fromHex(sk), fromHex(aux))).toUpperCase(), sig));
  }
  check("reference", "BIP-340 verify " + i, () => ref.schnorrVerify(fromHex(sig), fromHex(msg), fromHex(pk)) === (res === "TRUE"));
}

// --- BIP-39 ----------------------------------------------------------------------

for (const [entropy, mnemonic, seed, xprv] of V.bip39_trezor) {
  check("bip39", mnemonic.split(" ").slice(0, 3).join(" ") + "...", () => {
    eq(mnemonicFromEntropy(fromHex(entropy)), mnemonic, "mnemonic");
    eq(toHex(entropyFromMnemonic(mnemonic)), entropy, "entropy");
    eq(toHex(entropyFromMnemonic("  " + mnemonic.toUpperCase().replace(/ /g, "\n  ") + " ")), entropy, "spaces, case");
    const s = seedFromMnemonic(mnemonic, "TREZOR");
    eq(toHex(s), seed, "seed");
    const m = fromSeed(s), x = decodeExtendedKey(xprv).node;
    return equal(m.privateKey, x.privateKey) && equal(m.chainCode, x.chainCode) && x.depth === 0;
  });
}
for (const [, mnemonic, seed, xprv] of V.bip39_japanese) {
  check("bip39", "Japanese (NFKD of the words) " + seed.slice(0, 8), () => {
    eq(toHex(seedFromMnemonic(mnemonic, "TREZOR")), seed);
    return equal(fromSeed(fromHex(seed)).chainCode, decodeExtendedKey(xprv).node.chainCode);
  });
}
check("bip39", "passphrase NFKD (é, ㍍)", () => {
  const m = V.bip39_trezor[0][1];
  const want = ref.pbkdf2("SHA-512", m, "mnemonic" + "éメートル", 2048, 64);
  eq(toHex(seedFromMnemonic(m, "é㍍")), toHex(want));
  return toHex(seedFromMnemonic(m, "é㍍")) === toHex(want);
});
check("bip39", "empty passphrase is the default", () => toHex(seedFromMnemonic(V.bip39_trezor[0][1])) ===
  toHex(seedFromMnemonic(V.bip39_trezor[0][1], "")));
check("bip39", "wrong checksum", () => has(throws(() => entropyFromMnemonic("abandon ".repeat(12).trim()), Bip39Error).message, "checksum"));
check("bip39", "unknown word, by position only", () => {
  const e = throws(() => entropyFromMnemonic("abandon ".repeat(11) + "bitcoinz"), Bip39Error);
  return has(e.message, "word 12") && !e.message.includes("bitcoinz");
});
check("bip39", "word count", () => has(throws(() => entropyFromMnemonic("abandon about"), Bip39Error).message, "not 2"));
check("bip39", "entropy length", () => throws(() => mnemonicFromEntropy(new Uint8Array(17)), Bip39Error));

// --- BIP-32 ----------------------------------------------------------------------

V.bip32.valid.forEach((tv, n) => {
  const master = fromSeed(fromHex(tv.seed));
  for (const c of tv.chains) {
    check("bip32", `TV${n + 1} ${c.path}`, () => {
      const node = derive(master, c.path);
      eq(serializeXpub(node), c.xpub, "xpub");
      const x = decodeExtendedKey(c.xprv);
      eq([x.private, x.version, toHex(x.node.privateKey), toHex(x.node.chainCode), x.node.depth, toHex(x.node.parentFingerprint),
        x.node.childNumber], [true, "xpub", toHex(node.privateKey), toHex(node.chainCode), node.depth, toHex(node.parentFingerprint),
        node.childNumber], "xprv");
      const p = parseXpub(c.xpub);
      eq([toHex(p.node.publicKey), p.version, p.network, p.node.privateKey], [toHex(node.publicKey), "xpub", "mainnet", null]);
      // public derivation agrees, for a last step that isn't hardened
      const path = parsePath(c.path);
      if (path.length && path[path.length - 1] < HARDENED) {
        const parent = neuter(derive(master, path.slice(0, -1)));
        eq(serializeXpub(deriveChild(parent, path[path.length - 1])), c.xpub, "CKDpub");
      }
      return true;
    });
  }
});
for (const { key, why } of V.bip32.invalid) {
  check("bip32", "TV5 invalid: " + why, () => {
    throws(() => decodeExtendedKey(key), Bip32Error, why);
    throws(() => parseXpub(key), Bip32Error, why);
    return true;
  });
}
check("bip32", "parsePath ' and h", () => {
  eq(parsePath("m/84'/0h/0H/1/7"), [84 + HARDENED, HARDENED, HARDENED, 1, 7]);
  eq(formatPath(parsePath("m/84h/0'/0'/0/1")), "m/84'/0'/0'/0/1");
  return parsePath("m").length === 0;
});
for (const bad of ["84'/0'", "m/x", "m/2147483648", "m/-1", "m//1", "m/1''"]) {
  check("bip32", "parsePath refuses " + bad, () => throws(() => parsePath(bad), Bip32Error));
}
check("bip32", "seed lengths", () => {
  throws(() => fromSeed(new Uint8Array(15)), Bip32Error);
  throws(() => fromSeed(new Uint8Array(65)), Bip32Error);
  return fromSeed(new Uint8Array(64)).depth === 0;
});
check("bip32", "hardened step from a public node", () => throws(() => derive(neuter(fromSeed(new Uint8Array(16))), "m/0'"), Bip32Error));
check("bip32", "parseXpub refuses private keys", () => has(throws(() => parseXpub(V.bip32.valid[0].chains[0].xprv), Bip32Error).message, "private"));
check("bip32", "wipe zeroes the key and chain code", () => {
  const m = fromSeed(fromHex(V.bip32.valid[0].seed));
  const k = m.privateKey, c = m.chainCode;
  wipe(m);
  return m.privateKey === null && k.every((b) => b === 0) && c.every((b) => b === 0);
});
check("bip32", "derive leaves its node as it was", () => {
  const m = fromSeed(fromHex(V.bip32.valid[0].seed)), before = toHex(m.privateKey);
  derive(m, "m/0'/1");
  return toHex(m.privateKey) === before && derive(m, "m").privateKey !== m.privateKey;
});

// --- SLIP-132, BIP-84, BIP-49, BIP-86 ---------------------------------------------

for (const s of V.slip132) {
  const v = VERSIONS[s.pubName];
  if (!v) continue; // multisig versions (Ypub, Zpub, ...): not used
  check("slip132", s.pubName, () => eq([v.pub.toString(16).padStart(8, "0"), v.prv.toString(16).padStart(8, "0")], [s.pub, s.prv]));
}
check("slip132", "every version of ours is in SLIP-132", () => Object.keys(VERSIONS).every((n) => V.slip132.some((s) => s.pubName === n)));
check("slip132", "versionFor", () => eq(["p2wpkh", "p2sh-p2wpkh", "p2pkh", "p2tr"].flatMap((s) => [versionFor(s, "mainnet"),
  versionFor(s, "testnet")]), ["zpub", "vpub", "ypub", "upub", "xpub", "tpub", "xpub", "tpub"]));

const abandon = fromSeed(seedFromMnemonic(V.bip84.mnemonic));
check("bip84", "root zpub", () => eq(serializeXpub(abandon, "zpub"), V.bip84.rootpub));
check("bip84", "account zpub " + V.bip84.account, () => {
  eq(serializeXpub(derive(abandon, V.bip84.account), "zpub"), V.bip84.xpub);
  const p = parseXpub(V.bip84.xpub);
  return p.version === "zpub" && p.script === "p2wpkh" && p.network === "mainnet";
});
for (const a of V.bip84.addresses) {
  check("bip84", a.path, () => {
    const n = derive(abandon, a.path);
    eq(toHex(n.publicKey), a.pubkey);
    return scriptToAddress(p2wpkhScript(hash160(n.publicKey)), "mainnet") === a.address;
  });
}
check("bip49", "account upub " + V.bip49.account, () => eq(serializeXpub(derive(abandon, V.bip49.account), "upub"), V.bip49.xpub));
check("bip49", V.bip49.path, () => {
  const n = derive(abandon, V.bip49.path);
  eq(toHex(n.publicKey), V.bip49.pubkey);
  return scriptToAddress(p2shScript(hash160(p2wpkhScript(hash160(n.publicKey)))), "testnet") === V.bip49.address;
});
check("bip86", "root and account xpub", () => {
  eq(serializeXpub(abandon), V.bip86.rootpub);
  return serializeXpub(derive(abandon, V.bip86.account)) === V.bip86.xpub;
});
for (const a of V.bip86.addresses) {
  check("bip86", a.path, () => {
    const n = derive(abandon, a.path), x = n.publicKey.subarray(1);
    eq(toHex(x), a.internal_key, "internal key");
    const q = ref.taprootTweakPublicKey(x, taggedHash("TapTweak", x)).key;
    eq(toHex(q), a.output_key, "output key");
    eq("5120" + toHex(q), a.scriptPubKey);
    return scriptToAddress(fromHex(a.scriptPubKey), "mainnet") === a.address;
  });
}

// --- sighashes: BIP-143, legacy, BIP-341 ----------------------------------------------

for (const c of V.bip143) {
  check("bip143", c.name + ": sighash and signature", () => {
    const tx = parseTx(fromHex(c.unsigned));
    const key = fromHex(c.keys[c.keys.length - 1]);
    const h = segwitV0Sighash(tx, c.input, fromHex(c.scriptCode), c.amount, 1);
    eq(toHex(h), c.sighash, "sighash");
    eq(toHex(p2wpkhScriptCode(hash160(ref.publicKey(key)))), c.scriptCode, "scriptCode");
    eq(toHex(ref.ecdsaSign(h, key)) + "01", c.signature, "signature");
    // the signed transaction has the same signature in its witness
    const signed = parseTx(fromHex(c.signed));
    return toHex(signed.inputs[c.input].witness[0]) === c.signature;
  });
}
check("legacy", "BIP-143's P2PK input: its signature verifies against our legacy sighash", () => {
  const c = V.bip143[0];
  const tx = parseTx(fromHex(c.unsigned)), signed = parseTx(fromHex(c.signed));
  const script = fromHex(c.spent[0].script);
  const sig = signed.inputs[0].scriptSig.subarray(1, 1 + signed.inputs[0].scriptSig[0]);
  const h = legacySighash(tx, 0, script, sig[sig.length - 1]);
  const pub = script.subarray(1, 34);
  if (!ref.ecdsaVerify(sig.subarray(0, -1), h, pub)) return false;
  // and not against another sighash type
  return !ref.ecdsaVerify(sig.subarray(0, -1), legacySighash(tx, 0, script, 2), pub);
});
check("legacy", "SIGHASH_SINGLE without its output hashes to 1", () => {
  const tx = parseTx(fromHex(V.bip143[1].unsigned));
  tx.outputs = tx.outputs.slice(0, 0);
  const h = legacySighash(tx, 0, new Uint8Array(0), 3);
  return h[0] === 1 && h.subarray(1).every((b) => b === 0);
});

{
  const b = V.bip341;
  const tx = parseTx(fromHex(b.given.rawUnsignedTx));
  const prevouts = b.given.utxosSpent.map((u) => ({ script: fromHex(u.scriptPubKey), value: u.amountSats }));
  for (const s of b.inputSpending) {
    const g = s.given, im = s.intermediary;
    check("bip341", `keyPathSpending input ${g.txinIndex} (hash type 0x${g.hashType.toString(16)})`, () => {
      eq(toHex(taprootSigMsg(tx, g.txinIndex, prevouts, g.hashType)), im.sigMsg, "sigMsg");
      const h = taprootSighash(tx, g.txinIndex, prevouts, g.hashType);
      eq(toHex(h), im.sigHash, "sigHash");
      const k = fromHex(g.internalPrivkey), x = ref.xOnlyPublicKey(k);
      eq(toHex(x), im.internalPubkey, "internal key");
      const tweak = taggedHash("TapTweak", g.merkleRoot ? concat([x, fromHex(g.merkleRoot)]) : x);
      eq(toHex(tweak), im.tweak, "tweak");
      const tk = ref.taprootTweakPrivateKey(k, tweak);
      eq(toHex(tk), im.tweakedPrivkey, "tweaked key");
      const sig = ref.schnorrSign(h, tk, new Uint8Array(32));
      return toHex(sig) + (g.hashType ? g.hashType.toString(16).padStart(2, "0") : "") === s.expected.witness[0];
    });
  }
  for (const s of b.scriptPubKey) {
    check("bip341", "output key of " + s.internalPubkey.slice(0, 8), () => {
      const x = fromHex(s.internalPubkey);
      const t = taggedHash("TapTweak", s.merkleRoot ? concat([x, fromHex(s.merkleRoot)]) : x);
      eq(toHex(t), s.tweak);
      return toHex(ref.taprootTweakPublicKey(x, t).key) === s.tweakedPubkey;
    });
  }
  check("bip341", "invalid hash type refused", () => throws(() => taprootSigMsg(tx, 0, prevouts, 4), RangeError));
}

// --- BIP-174's signer test vector (2-of-2 multisig: our sighashes, not signPsbt) ---------

{
  const wf = PSBT_V.bip174.workflow;
  const updated = parsePsbt(fromHex(wf[2].hex)), first = parsePsbt(fromHex(wf[3].hex));
  const master = decodeExtendedKey("tprv8ZgxMBicQKsPd9TeAdPADNnSyH9SSUUbTVeFszDE23Ki6TBB5nCefAdHkK8Fm3qMQR6sHwA56zqRmKmxnHk37JkiFzvncDqoKmPWubu7hDF").node;
  check("bip174", "the first signer's signatures (m/0'/0'/0' and m/0'/0'/2')", () => {
    const tx = updated.tx;
    const f0 = updated.inputs[0].fields, f1 = updated.inputs[1].fields;
    const k0 = derive(master, "m/0'/0'/0'"), k2 = derive(master, "m/0'/0'/2'");
    const s0 = concat([ref.ecdsaSign(legacySighash(tx, 0, f0.redeemScript, 1), k0.privateKey), [1]]);
    const s1 = concat([ref.ecdsaSign(segwitV0Sighash(tx, 1, concat([[f1.witnessScript.length], f1.witnessScript]).subarray(1),
      f1.witnessUtxo.value, 1), k2.privateKey), [1]]);
    const want0 = first.inputs[0].fields.partialSigs.find((s) => equal(s.pubkey, k0.publicKey));
    const want1 = first.inputs[1].fields.partialSigs.find((s) => equal(s.pubkey, k2.publicKey));
    eq(toHex(s0), toHex(want0.signature), "P2SH multisig");
    return toHex(s1) === toHex(want1.signature);
  });
  check("bip174", "signPsbt: bare P2SH multisig left alone, saying why; P2SH-P2WSH as the BIP signs it", () => {
    const r = signPsbt(updated, master, {});
    eq(r.signed.map((s) => s.input), [1, 1]); // this master holds both of its keys
    has(r.skipped[0].reason, "not supported");
    eq(r.psbt.inputs[0].fields.partialSigs.length, 0);
    const want = first.inputs[1].fields.partialSigs[0];
    eq(toHex(r.psbt.inputs[1].fields.partialSigs.find((s) => equal(s.pubkey, want.pubkey)).signature), toHex(want.signature));
  });
  check("bip174", "the combined PSBT's P2SH-P2WSH input finalizes as the BIP's transaction does", () => {
    const both = parsePsbt(fromHex(wf[5].hex));
    const f = both.inputs[1].fields;
    const coin = f.witnessUtxo;
    const ms = parseMultisig(f.witnessScript);
    const got = planKeys(both, [], {}).inputs[1].multisig;
    eq([got.m, got.n, got.have], [ms.m, ms.n, 2]);
    const want = parseTx(fromHex(PSBT_V.bip174.extracted_tx.hex ?? PSBT_V.bip174.extracted_tx)).inputs[1].witness;
    const single = parsePsbt(serializePsbt(both));
    single.inputs[0].fields.finalScriptSig = Uint8Array.of(0); // finalize() checks the second input here
    const tx = parseTx(finalize(single).tx);
    eq(tx.inputs[1].witness.map(toHex), want.map(toHex));
    return coin.value > 0;
  });
}

// --- PSBTs made here: every rule, one at a time ---------------------------------------

const ABANDON_FP = toHex(fingerprint(abandon));
const sha = (s) => ref.sha256(s);

function writeMap(w, entries) {
  for (const [type, key, value] of entries) {
    w.varBytes(concat([[type], key])).varBytes(value);
  }
  w.u8(0);
}
const origin = (fp, path) => {
  const w = new Writer();
  w.bytes(typeof fp === "string" ? fromHex(fp) : fp);
  for (const p of path) w.u32(p);
  return w.done();
};
const txOut = (value, script) => new Writer().u64(value).varBytes(script).done();

// A PSBT spending coins of `master` (default: "abandon ... about").
//   inputs:  [{ kind, path, amount, fp?, pubkey?, script?, utxo?: false, sighash?, merkleRoot?, internalKey?, extra?,
//              noOrigin?: true, prevOutputs? (more outputs in a P2PKH coin's previous transaction),
//              full?: true (a segwit coin's previous transaction too), witnessAmount? (its witness UTXO's, a lie) }]
//   outputs: [{ kind, path, amount, fp?, pubkey?, script? } | { script, amount }]
// salt: other made-up coins (their txids), for PSBTs that must not share coins
function build({ inputs, outputs, master = abandon, version = 2, locktime = 0, globals = [], salt = "" }) {
  const ins = [], inMaps = [];
  inputs.forEach((x, i) => {
    const path = parsePath(x.path || "m/84'/1'/0'/0/" + i);
    const node = derive(master, path);
    const pub = node.publicKey, xonly = pub.subarray(1);
    const h = hash160(pub);
    let script;
    if (x.kind === "p2tr") script = concat([[0x51, 32], ref.taprootTweakPublicKey(xonly, taggedHash("TapTweak", xonly)).key]);
    else if (x.kind === "p2sh-p2wpkh") script = p2shScript(hash160(p2wpkhScript(h)));
    else if (x.kind === "p2pkh") script = p2pkhScript(h);
    else script = p2wpkhScript(h);
    if (x.script) script = x.script;
    const entries = [];
    let txid = sha(salt + "coin " + i), vout = i;
    if (x.kind === "p2pkh" || x.full) {
      const prev = { version: 2, inputs: [{ txid: sha("from " + i), vout: 0, scriptSig: new Uint8Array(0), sequence: 0, witness: [] }],
        outputs: [{ value: 1, script: p2pkhScript(new Uint8Array(20)) }, { value: x.amount, script },
          ...Array.from({ length: x.prevOutputs || 0 }, (_, n) => ({ value: 1000 + n, script: p2pkhScript(new Uint8Array(20).fill(n & 255)) }))], locktime: 0 };
      vout = 1;
      txid = fromHex(txidOf(prev)).reverse();
      if (x.utxo !== false) entries.push([IN.NON_WITNESS_UTXO, [], serializeTx(prev)]);
    }
    if (x.kind !== "p2pkh" && x.utxo !== false && x.witnessUtxo !== false) {
      entries.push([IN.WITNESS_UTXO, [], txOut(x.witnessAmount ?? x.amount, script)]);
    }
    if (x.sighash !== undefined) entries.push([IN.SIGHASH_TYPE, [], new Writer().u32(x.sighash).done()]);
    if (x.kind === "p2sh-p2wpkh") entries.push([IN.REDEEM_SCRIPT, [], x.redeemScript || p2wpkhScript(h)]);
    const fp = x.fp || ABANDON_FP;
    const dpath = x.claimPath ? parsePath(x.claimPath) : path;
    if (x.kind === "p2tr") {
      entries.push([IN.TAP_BIP32_DERIVATION, x.pubkey || xonly, concat([[0], origin(fp, dpath)])]);
      entries.push([IN.TAP_INTERNAL_KEY, [], x.internalKey || xonly]);
      if (x.merkleRoot) entries.push([IN.TAP_MERKLE_ROOT, [], x.merkleRoot]);
    } else if (!x.noOrigin) {
      entries.push([IN.BIP32_DERIVATION, x.pubkey || pub, origin(fp, dpath)]);
    }
    for (const e of x.extra || []) entries.push(e);
    ins.push({ txid, vout, scriptSig: new Uint8Array(0), sequence: 0xfffffffd, witness: [] });
    inMaps.push(entries);
  });
  const outs = [], outMaps = [];
  for (const o of outputs) {
    const entries = [];
    let script = o.script;
    if (o.path) {
      const node = derive(master, o.path), pub = node.publicKey, xonly = pub.subarray(1);
      const h = hash160(pub);
      if (!script) {
        if (o.kind === "p2tr") script = concat([[0x51, 32], ref.taprootTweakPublicKey(xonly, taggedHash("TapTweak", xonly)).key]);
        else if (o.kind === "p2sh-p2wpkh") script = p2shScript(hash160(p2wpkhScript(h)));
        else if (o.kind === "p2pkh") script = p2pkhScript(h);
        else script = p2wpkhScript(h);
      }
      const fp = o.fp || ABANDON_FP;
      if (o.kind === "p2tr") entries.push([OUT.TAP_BIP32_DERIVATION, o.pubkey || xonly, concat([[0], origin(fp, parsePath(o.claimPath || o.path))])]);
      else entries.push([OUT.BIP32_DERIVATION, o.pubkey || pub, origin(fp, parsePath(o.claimPath || o.path))]);
    }
    for (const e of o.extra || []) entries.push(e);
    outs.push({ value: o.amount, script });
    outMaps.push(entries);
  }
  const tx = { version, inputs: ins, outputs: outs, locktime, segwit: false };
  const w = new Writer(1024);
  w.bytes(MAGIC);
  writeMap(w, [[0, [], serializeTx(tx, { withWitness: false })], ...globals]);
  for (const m of inMaps) writeMap(w, m);
  for (const m of outMaps) writeMap(w, m);
  return parsePsbt(w.done());
}

const ZERO_AUX = { aux: new Uint8Array(32), network: "testnet" };
const EXTERNAL = { script: p2wpkhScript(new Uint8Array(20).fill(7)), amount: 50000 };
const CHANGE = { kind: "p2wpkh", path: "m/84'/1'/0'/1/0", amount: 40000 };

// Signs, then checks every signature with the reference (independently of
// what signPsbt checked) and that finalize() gives a transaction.
function signAndCheck(psbt, options = ZERO_AUX) {
  const r = signPsbt(psbt, abandon, options);
  const prevouts = r.psbt.inputs.map((m) => m.fields.witnessUtxo || m.fields.nonWitnessUtxo?.outputs[r.psbt.tx.inputs[0].vout]);
  for (const s of r.signed) {
    const f = r.psbt.inputs[s.input].fields;
    if (f.tapKeySig) {
      const q = prevouts[s.input].script.subarray(2);
      const msg = taprootSighash(r.psbt.tx, s.input, prevouts, f.tapKeySig.length === 65 ? f.tapKeySig[64] : 0);
      if (!ref.schnorrVerify(f.tapKeySig.subarray(0, 64), msg, q)) throw new Error("bad schnorr signature");
    } else if (!f.partialSigs.length) throw new Error("no signature added");
  }
  return r;
}

check("rules", "P2WPKH with change: signs, change verified", () => {
  const p = build({ inputs: [{ kind: "p2wpkh", amount: 100000 }, { kind: "p2wpkh", amount: 20000 }], outputs: [EXTERNAL, CHANGE] });
  const pl = plan(p, abandon, ZERO_AUX);
  eq(pl.inputs.map((i) => [i.sign, i.path, i.oddities]), [[true, "m/84'/1'/0'/0/0", []], [true, "m/84'/1'/0'/0/1", []]]);
  eq(pl.outputs.map((o) => [o.ours, o.role, o.path, o.problem]), [[false, null, null, null], [true, "change", "m/84'/1'/0'/1/0", null]]);
  eq([pl.signable, pl.complete, pl.fingerprint], [2, true, ABANDON_FP]);
  const r = signAndCheck(p);
  eq(r.signed.map((s) => s.path), pl.inputs.map((i) => i.path), "signs what plan says");
  const f = finalize(r.psbt);
  const tx = parseTx(f.tx);
  return tx.inputs.every((i) => i.witness.length === 2) && f.txid === txidOf(tx);
});
check("rules", "P2SH-P2WPKH and P2PKH (with its previous transaction)", () => {
  const p = build({ inputs: [{ kind: "p2sh-p2wpkh", path: "m/49'/1'/0'/0/0", amount: 30000 },
    { kind: "p2pkh", path: "m/44'/1'/0'/0/0", amount: 70000 }], outputs: [EXTERNAL] });
  const r = signAndCheck(p);
  eq(r.signed.length, 2);
  const tx = parseTx(finalize(r.psbt).tx);
  // the scriptSig of P2SH-P2WPKH pushes the redeemScript; P2PKH's pushes signature and key
  const h = hash160(derive(abandon, "m/49'/1'/0'/0/0").publicKey);
  eq(toHex(tx.inputs[0].scriptSig), "16" + toHex(p2wpkhScript(h)));
  return tx.inputs[1].witness.length === 0 && tx.inputs[1].scriptSig.length > 100;
});
check("rules", "P2TR key path (BIP-86): signs with SIGHASH_DEFAULT, 64 bytes", () => {
  const p = build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 80000 }, { kind: "p2tr", path: "m/86'/1'/0'/0/1", amount: 1000 }],
    outputs: [EXTERNAL, { kind: "p2tr", path: "m/86'/1'/0'/1/0", amount: 30000 }] });
  const pl = plan(p, abandon, ZERO_AUX);
  eq(pl.outputs[1].ours && pl.outputs[1].role, "change");
  const r = signAndCheck(p);
  eq(r.psbt.inputs.map((m) => m.fields.tapKeySig.length), [64, 64]);
  const tx = parseTx(finalize(r.psbt).tx);
  return tx.inputs.every((i) => i.witness.length === 1);
});
check("rules", "P2TR with explicit SIGHASH_ALL: 65 bytes", () => {
  const r = signAndCheck(build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 80000, sighash: 1 }], outputs: [EXTERNAL] }));
  return r.psbt.inputs[0].fields.tapKeySig.length === 65 && r.psbt.inputs[0].fields.tapKeySig[64] === 1;
});
check("rules", "taproot aux: a function per input; default is the crypto's own", () => {
  const p = build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 80000 }], outputs: [EXTERNAL] });
  const seen = [];
  signPsbt(p, abandon, { aux: (i) => (seen.push(i), new Uint8Array(32)) });
  eq(seen, [0]);
  // crypto_ref refuses to make up randomness: the default reaches it
  return has(throws(() => signPsbt(p, abandon, {})).message, "aux");
});
check("rules", "the caller's PSBT is not changed", () => {
  const p = build({ inputs: [{ kind: "p2wpkh", amount: 100000 }], outputs: [EXTERNAL] });
  const before = toHex(serializePsbt(p));
  signPsbt(p, abandon, ZERO_AUX);
  return toHex(serializePsbt(p)) === before;
});

// each rule, broken
const reasonOf = (p, i = 0, options = ZERO_AUX) => {
  const pl = plan(p, abandon, options);
  const r = signPsbt(p, abandon, options);
  if (pl.inputs[i].sign || r.signed.some((s) => s.input === i)) throw new Error("signed");
  eq(r.skipped.find((s) => s.input === i).reason, pl.inputs[i].reason, "plan and signPsbt agree");
  if (r.psbt.inputs[i].fields.partialSigs.length || r.psbt.inputs[i].fields.tapKeySig) throw new Error("a signature was added");
  return pl.inputs[i].reason;
};
const one = (x, outputs = [EXTERNAL]) => build({ inputs: [x], outputs });

check("negative", "wrong fingerprint", () => has(reasonOf(one({ kind: "p2wpkh", amount: 1000, fp: "01020304" })), "another wallet"));
check("negative", "no derivation at all", () => {
  const p = one({ kind: "p2wpkh", amount: 1000 });
  p.inputs[0].fields.bip32 = [];
  return has(reasonOf(p), "names no key");
});
check("negative", "pubkey not the one at its path", () =>
  has(reasonOf(one({ kind: "p2wpkh", amount: 1000, claimPath: "m/84'/1'/0'/0/9" })), "is not the one the PSBT names"));
check("negative", "pubkey of another wallet at our path", () =>
  has(reasonOf(one({ kind: "p2wpkh", amount: 1000, pubkey: ref.publicKey(sha("other")) })), "is not the one the PSBT names"));
check("negative", "script doesn't pay to the key (P2WPKH)", () =>
  has(reasonOf(one({ kind: "p2wpkh", amount: 1000, script: p2wpkhScript(new Uint8Array(20).fill(9)) })), "doesn't pay to the key"));
check("negative", "script doesn't pay to the key (P2PKH)", () =>
  has(reasonOf(one({ kind: "p2pkh", path: "m/44'/1'/0'/0/0", amount: 1000, script: p2pkhScript(new Uint8Array(20).fill(9)) })),
    "doesn't pay to the key"));
check("negative", "redeemScript not the coin's (P2SH-P2WPKH)", () =>
  has(reasonOf(one({ kind: "p2sh-p2wpkh", path: "m/49'/1'/0'/0/0", amount: 1000, redeemScript: p2wpkhScript(new Uint8Array(20)) })),
    "redeemScript is not the one"));
check("negative", "redeemScript right, key not in it", () => {
  const other = p2wpkhScript(new Uint8Array(20).fill(3));
  return has(reasonOf(one({ kind: "p2sh-p2wpkh", path: "m/49'/1'/0'/0/0", amount: 1000, redeemScript: other,
    script: p2shScript(hash160(other)) })), "doesn't pay to the key");
});
check("negative", "taproot: output key not BIP-86's (a script tree hidden)", () => {
  const x = derive(abandon, "m/86'/1'/0'/0/0").publicKey.subarray(1);
  const hidden = concat([[0x51, 32], ref.taprootTweakPublicKey(x, taggedHash("TapTweak", concat([x, sha("tree")]))).key]);
  return has(reasonOf(one({ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 1000, script: hidden })), "not BIP-86's");
});
check("negative", "taproot: a merkle root", () =>
  has(reasonOf(one({ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 1000, merkleRoot: sha("tree") })), "script tree"));
check("negative", "taproot: x-only key not at its path", () =>
  has(reasonOf(one({ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 1000, claimPath: "m/86'/1'/0'/0/1" })), "not the one the PSBT names"));
check("negative", "taproot: internal key differs", () =>
  has(reasonOf(one({ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 1000, internalKey: ref.xOnlyPublicKey(sha("x")) })), "internal key"));
check("negative", "missing amount (no UTXO)", () => has(reasonOf(one({ kind: "p2wpkh", amount: 1000, utxo: false })), "not described"));
check("negative", "taproot: another input's amount missing", () => {
  const p = build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 1000 }, { kind: "p2wpkh", amount: 5, utxo: false }],
    outputs: [EXTERNAL] });
  return has(reasonOf(p, 0), "input 2's coin is not known");
});
check("negative", "P2PKH without its previous transaction", () =>
  has(reasonOf(one({ kind: "p2pkh", path: "m/44'/1'/0'/0/0", amount: 1000, utxo: false })), "not described"));
check("negative", "P2PKH with only a witness UTXO (as Electrum's QR)", () => {
  const h = hash160(derive(abandon, "m/44'/1'/0'/0/0").publicKey);
  return has(reasonOf(one({ kind: "p2pkh", path: "m/44'/1'/0'/0/0", amount: 1000, utxo: false,
    extra: [[IN.WITNESS_UTXO, [], txOut(1000, p2pkhScript(h))]] })), "previous transaction");
});
check("negative", "previous transaction with the wrong txid", () => {
  const p = one({ kind: "p2pkh", path: "m/44'/1'/0'/0/0", amount: 1000 });
  p.tx.inputs[0].txid = sha("elsewhere");
  return has(reasonOf(p), "wrong txid");
});
check("negative", "previous transaction and witness UTXO disagree", () => {
  const p = one({ kind: "p2pkh", path: "m/44'/1'/0'/0/0", amount: 1000 });
  p.inputs[0].fields.witnessUtxo = { value: 999, script: p.inputs[0].fields.nonWitnessUtxo.outputs[1].script };
  return has(reasonOf(p), "disagree");
});
for (const t of [0, 2, 3, 0x81, 0x82, 0x83]) {
  check("negative", "sighash 0x" + t.toString(16) + " (ECDSA)", () => has(reasonOf(one({ kind: "p2wpkh", amount: 1000, sighash: t })), "only ALL"));
}
for (const t of [2, 3, 0x81]) {
  check("negative", "sighash 0x" + t.toString(16) + " (taproot)", () =>
    has(reasonOf(one({ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 1000, sighash: t })), "only ALL"));
}
check("negative", "already final", () => {
  const p = one({ kind: "p2wpkh", amount: 1000, extra: [[IN.FINAL_SCRIPTWITNESS, [], Uint8Array.of(0)]] });
  const pl = plan(p, abandon, ZERO_AUX);
  return pl.inputs[0].final && pl.complete && has(reasonOf(p), "final");
});
check("negative", "a bad derivation next to a good one: the good one signs", () => {
  const p = one({ kind: "p2wpkh", amount: 1000, extra: [[IN.BIP32_DERIVATION, ref.publicKey(sha("z")), origin(ABANDON_FP, [1, 2])]] });
  const r = signAndCheck(p);
  return r.signed.length === 1 && r.signed[0].path === "m/84'/1'/0'/0/0";
});
check("negative", "absurdly deep path", () => {
  const p = one({ kind: "p2wpkh", amount: 1000, claimPath: "m" + "/1".repeat(40) });
  return has(reasonOf(p), "longer than 16 steps");
});
check("negative", "a public key can't sign", () => throws(() => plan(one({ kind: "p2wpkh", amount: 1000 }), neuter(abandon), {}), SignError));
check("negative", "finalize refuses an unsigned input", () => has(throws(() => finalize(one({ kind: "p2wpkh", amount: 1000 })), SignError).message,
  "input 1 is not signed"));

// change: fingerprints prove nothing
const outPlan = (o) => verifyChange(build({ inputs: [{ kind: "p2wpkh", amount: 100000 }], outputs: [EXTERNAL, o] }), abandon, ZERO_AUX)[1];
check("change", "fake change: our fingerprint and path, someone else's script", () => {
  const o = outPlan({ ...CHANGE, script: p2wpkhScript(new Uint8Array(20).fill(5)) });
  return !o.ours && has(o.problem, "doesn't pay to that key");
});
check("change", "fake change: our fingerprint, their key and script", () => {
  const theirs = ref.publicKey(sha("thief"));
  const o = outPlan({ ...CHANGE, pubkey: theirs, script: p2wpkhScript(hash160(theirs)) });
  return !o.ours && has(o.problem, "not this wallet's key");
});
check("change", "fake change: another wallet's fingerprint is just external", () => {
  const o = outPlan({ ...CHANGE, fp: "deadbeef" });
  return !o.ours && o.problem === null;
});
check("change", "fake taproot change", () => {
  const o = outPlan({ kind: "p2tr", path: "m/86'/1'/0'/1/0", amount: 1, script: concat([[0x51, 32], sha("q")]) });
  return !o.ours && has(o.problem, "doesn't pay");
});
check("change", "change to another script type of our key: ours, flagged", () => {
  const o = outPlan({ kind: "p2pkh", path: "m/84'/1'/0'/1/0", amount: 5000 });
  return o.ours && o.type === "p2pkh" && o.oddities.some((s) => s.includes("P2PKH"));
});
check("change", "receive branch", () => outPlan({ ...CHANGE, path: "m/84'/1'/0'/0/4" }).role === "receive");

// odd paths are signed, and flagged
const oddOf = (x, options = ZERO_AUX) => {
  const pl = plan(build({ inputs: [{ kind: "p2wpkh", amount: 1000 }, x], outputs: [EXTERNAL] }), abandon, options);
  if (!pl.inputs[1].sign) throw new Error("not signed: " + pl.inputs[1].reason);
  return pl.inputs[1].oddities.join(" | ");
};
check("oddities", "index above 10^6", () => has(oddOf({ kind: "p2wpkh", path: "m/84'/1'/0'/0/1000001", amount: 1 }), "unusually high"));
check("oddities", "index up to 10^6 is fine", () => oddOf({ kind: "p2wpkh", path: "m/84'/1'/0'/0/1000000", amount: 1 }) === "");
check("oddities", "maxIndex option", () => has(oddOf({ kind: "p2wpkh", path: "m/84'/1'/0'/0/50", amount: 1 }, { ...ZERO_AUX, maxIndex: 20 }), "unusually high"));
check("oddities", "branch not 0/1", () => has(oddOf({ kind: "p2wpkh", path: "m/84'/1'/0'/7/0", amount: 1 }), "branch 7"));
check("oddities", "account differs from the others'", () => has(oddOf({ kind: "p2wpkh", path: "m/84'/1'/5'/0/0", amount: 1 }), "account m/84'/1'/5'"));
check("oddities", "purpose doesn't match the script", () => has(oddOf({ kind: "p2wpkh", path: "m/44'/1'/0'/0/1", amount: 1 }), "not the usual 84'"));
check("oddities", "coin type against the network", () => has(oddOf({ kind: "p2wpkh", path: "m/84'/0'/0'/0/1", amount: 1 }), "for mainnet, not testnet"));
check("oddities", "short path", () => has(oddOf({ kind: "p2wpkh", path: "m/0/1", amount: 1 }), "not the usual"));
check("oddities", "hardened index", () => has(oddOf({ kind: "p2wpkh", path: "m/84'/1'/0'/0/1'", amount: 1 }), "hardened address index"));
check("oddities", "output with an absurd index", () => outPlan({ ...CHANGE, path: "m/84'/1'/0'/1/9999999" }).oddities.some((s) => s.includes("high")));

check("selftest", "selfTest(crypto)", () => {
  const r = selfTest(ref);
  eq(r.checks.map((c) => c.ok), [true, true, true, true]);
  return r.ok;
});

// --- Electrum end to end ------------------------------------------------------------

const signedForElectrum = {};
for (const c of E.cases) {
  const net = c.network;
  const signedCase = () => {
    const payload = readPayload(c.qr);
    const psbt = parsePsbt(payload.bytes);
    return { psbt, r: signPsbt(psbt, abandon, { network: net }), pl: plan(psbt, abandon, { network: net }) };
  };
  check("electrum", c.name + ": exported account xpub is Electrum's", () => {
    const script = c.xpub.startsWith("z") || c.xpub.startsWith("v") ? "p2wpkh"
      : c.xpub.startsWith("y") || c.xpub.startsWith("u") ? "p2sh-p2wpkh" : "p2pkh";
    eq(serializeXpub(neuter(derive(abandon, c.account)), versionFor(script, net)), c.xpub);
    return parseXpub(c.xpub).script === script;
  });
  check("electrum", c.name + ": derivations as Electrum writes them", () => {
    const watch = c.name.includes("watch-only");
    const acct = derive(abandon, c.account);
    for (const [fp, path] of c.derivations) {
      if (watch) {
        // the account's own fingerprint, and the path below the account
        eq(fp, toHex(fingerprint(acct)), "fingerprint");
        eq(path.split("/").length, 2, "relative path");
      } else {
        eq(fp, ABANDON_FP, "master fingerprint");
        eq(formatPath(path.split("/").map(Number)).startsWith(c.account), true, "full path");
      }
    }
    return true;
  });
  check("electrum", c.name + ": plan", () => {
    const { pl } = signedCase();
    if (c.name === "testnet-p2pkh-qr") {
      return pl.inputs.every((i) => !i.sign && i.reason.includes("previous transaction")) && pl.signable === 0;
    }
    eq(pl.inputs.map((i) => i.sign), pl.inputs.map(() => true), "every input signed");
    for (const i of pl.inputs) {
      if (!i.path.startsWith(c.account + "/")) throw new Error("path " + i.path);
      eq(i.oddities, [], "oddities");
    }
    // ours and change: as Electrum's own wallet says
    eq(pl.outputs.map((o) => [o.ours, o.ours ? o.role === "change" : false]), c.outputs.map((o) => [o.mine, o.change]));
    return pl.outputs.filter((o) => o.ours).every((o) => o.path.startsWith(c.account + "/") && o.oddities.length === 0);
  });
  if (c.name === "testnet-p2pkh-qr") continue;
  check("electrum", c.name + ": signatures byte for byte as Electrum's", () => {
    const { r } = signedCase();
    eq(r.skipped, []);
    eq(c.electrum_sigs.length, r.psbt.inputs.length);
    r.psbt.inputs.forEach((m, i) => {
      const ours = Object.fromEntries(m.fields.partialSigs.map((s) => [toHex(s.pubkey), toHex(s.signature)]));
      eq(ours, c.electrum_sigs[i], `input ${i}`);
    });
    return true;
  });
  check("electrum", c.name + ": final transaction as Electrum's", () => {
    const { r } = signedCase();
    const f = finalize(r.psbt);
    eq(toHex(f.tx), c.electrum_final_tx);
    const signedQr = electrumQrText(serializePsbt(r.psbt));
    signedForElectrum[c.name] = { signed_qr: signedQr, final_tx: toHex(f.tx), final_tx_qr: electrumQrText(f.tx), txid: f.txid };
    // smaller than the PSBT, so a smaller QR code
    return f.tx.length < serializePsbt(r.psbt).length;
  });
  const accepted = E.electrum_accepted?.[c.name];
  check("electrum", c.name + ": Electrum accepted exactly this", () => {
    if (!accepted) throw new Error("not checked with Electrum yet (make_electrum_vectors.py --check)");
    const mine = signedForElectrum[c.name];
    eq([mine.signed_qr, mine.final_tx], [accepted.signed_qr, accepted.final_tx]);
    return accepted.complete && accepted.signatures_verified === c.electrum_sigs.reduce((n, s) => n + Object.keys(s).length, 0) &&
      accepted.final_txid === mine.txid;
  });
}
check("electrum", "watch-only PSBTs need the account in `accounts`", () => {
  const c = E.cases.find((x) => x.name === "mainnet-p2wpkh-watch-only");
  const psbt = parsePsbt(readPayload(c.qr).bytes);
  const pl = plan(psbt, abandon, { accounts: ["m/84'/0'/1'"] });
  eq(pl.signable, 0);
  has(pl.inputs[0].reason, "another wallet");
  return plan(psbt, abandon, { accounts: [c.account] }).signable === psbt.inputs.length;
});
check("electrum", "an exported account's own fingerprint needs that account listed", () => {
  const a = derive(abandon, "m/84'/1'/1'");
  const p = build({ inputs: [{ kind: "p2wpkh", path: "m/84'/1'/1'/0/0", amount: 1000, fp: fingerprint(a).slice(), claimPath: "m/0/0" }], outputs: [EXTERNAL] });
  eq(plan(p, abandon, {}).signable, 0);
  eq(plan(p, abandon, { accounts: ["m/84'/1'/1'"] }).inputs[0].path, "m/84'/1'/1'/0/0");
});
check("electrum", "a hostile watch-only PSBT: right account fingerprint, wrong key", () => {
  const c = E.cases.find((x) => x.name === "mainnet-p2wpkh-watch-only");
  const psbt = parsePsbt(readPayload(c.qr).bytes);
  // claim the input key is at 0/7: derivation is checked, not trusted
  const d = psbt.inputs[0].fields.bip32[0];
  setEntry(psbt.inputs[0], IN.BIP32_DERIVATION, d.pubkey, origin(d.fingerprint, [0, 7]));
  return has(plan(parsePsbt(serializePsbt(psbt)), abandon, {}).inputs[0].reason, "m/84'/0'/0'/0/7");
});

// --- keys other than a master key -------------------------------------------------

const TWO = { inputs: [{ kind: "p2wpkh", amount: 100000 }, { kind: "p2wpkh", amount: 20000 }], outputs: [EXTERNAL, CHANGE] };
const wifOf = (node, prefix = 0x80) => base58CheckEncode(concat([[prefix], node.privateKey, [1]]));
const single = (path) => parseWif(wifOf(derive(abandon, path))).key;
const ACCOUNT = "m/84'/1'/0'";
const serialize = (p) => toHex(serializePsbt(p));
const privBase58 = (node, prefix) => {
  const w = new Writer();
  w.bytes(prefix).u8(node.depth).bytes(node.parentFingerprint).bytes(Uint8Array.of(node.childNumber >>> 24,
    (node.childNumber >>> 16) & 255, (node.childNumber >>> 8) & 255, node.childNumber & 255));
  w.bytes(node.chainCode).u8(0).bytes(node.privateKey);
  return base58CheckEncode(w.done());
};
const XPRV = [0x04, 0x88, 0xad, 0xe4], TPRV = [0x04, 0x35, 0x83, 0x94];

check("keys", "WIF: Bitcoin's key 1, compressed", () => {
  const r = parsePrivateKey("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
  eq([r.kind, r.network, toHex(r.key.publicKey)], ["wif", "mainnet", "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]);
});
check("keys", "WIF: testnet, and whitespace", () => {
  const n = derive(abandon, "m/84'/1'/0'/0/0");
  const r = parsePrivateKey("  " + wifOf(n, 0xef).replace(/(.{8})/g, "$1 "));
  eq([r.network, equal(r.key.privateKey, n.privateKey), r.key.single], ["test", true, true]);
});
check("keys", "WIF: Bitcoin's key 1, uncompressed", () => {
  const r = parsePrivateKey("5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf");
  eq([r.kind, r.network, r.compressed, r.key.publicKey.length, toHex(r.key.publicKey).slice(0, 66)],
    ["wif", "mainnet", false, 65, "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]);
});
const SECRET_TEXT = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWo";
check("keys", "a mistyped WIF is refused, and not quoted", () =>
  !throws(() => parsePrivateKey(SECRET_TEXT), KeyError).message.includes(SECRET_TEXT.slice(0, 8)));
check("keys", "characters outside Base58 are refused", () => throws(() => parsePrivateKey("Kw0OIl"), KeyError));
check("keys", "empty", () => throws(() => parsePrivateKey("  "), KeyError));
check("keys", "xprv: master and account, by depth", () => {
  const m = parsePrivateKey(privBase58(abandon, XPRV));
  const acct = derive(abandon, ACCOUNT);
  const a = parsePrivateKey(privBase58(acct, TPRV));
  eq([m.kind, m.network, m.key.depth, a.network, a.key.depth, a.key.childNumber],
    ["xprv", "mainnet", 0, "test", 3, acct.childNumber]);
});
check("keys", "an xpub can't sign", () => {
  const text = serializeXpub(neuter(abandon), "xpub");
  return has(throws(() => parsePrivateKey("xprv" + text.slice(4)), KeyError).message, "mistyped");
});

check("keys", "wipe leaves nothing of a WIF key or an xprv", () => {
  const w = parseWif(wifOf(derive(abandon, "m/84'/1'/0'/0/0"))).key, pk = w.privateKey;
  wipe(w);
  const x = parsePrivateKey(privBase58(derive(abandon, ACCOUNT), XPRV)).key, xk = x.privateKey, cc = x.chainCode;
  wipe(x);
  eq([w.privateKey, x.privateKey, pk.every((b) => b === 0), xk.every((b) => b === 0), cc.every((b) => b === 0)],
    [null, null, true, true, true]);
});

check("keyring", "an account xprv signs what the master signs, byte for byte (full paths)", () => {
  const p = build(TWO);
  const acct = derive(abandon, ACCOUNT);
  const pl = plan(p, acct, ZERO_AUX);
  // the steps above the account are the PSBT's word: shown below the key only
  eq([pl.signable, pl.complete, pl.outputs[1].ours, pl.outputs[1].path, pl.outputs[1].role], [2, true, true, "key/1/0", "change"]);
  eq(serialize(signPsbt(p, acct, ZERO_AUX).psbt), serialize(signPsbt(p, abandon, ZERO_AUX).psbt));
});
check("keyring", "an account xprv: the path above it is the PSBT's word, not shown nor judged", () => {
  // the master's fingerprint, and a purpose and coin type that are lies: only account 0' is checked
  const lie = (i) => ({ kind: "p2wpkh", amount: 50000, path: `${ACCOUNT}/0/${i}`, claimPath: `m/49'/0'/0'/0/${i}` });
  const pl = plan(build({ inputs: [lie(0), lie(1)], outputs: [EXTERNAL] }), derive(abandon, ACCOUNT), ZERO_AUX);
  eq([pl.signable, pl.inputs.map((r) => r.path), pl.inputs.flatMap((r) => r.oddities)], [2, ["key/0/0", "key/0/1"], []]);
});
check("keyring", "an account xprv: another account, same number, is another wallet", () => {
  const other = fromSeed(new Uint8Array(32).fill(5));
  const pl = plan(build(TWO), derive(other, ACCOUNT), ZERO_AUX);
  eq([pl.signable, pl.inputs[0].mine, pl.outputs[1].ours, pl.outputs[1].problem], [0, false, false, null]);
  return has(pl.inputs[0].reason, "another wallet");
});
check("keyring", "an account xprv: a lie below its own fingerprint is a problem", () => {
  const acct = derive(abandon, ACCOUNT);
  const fp = fingerprint(acct).slice();
  const change = { ...CHANGE, fp, claimPath: "m/1/9" };
  const pl = plan(build({ ...TWO, outputs: [EXTERNAL, change] }), acct, ZERO_AUX);
  return has(pl.outputs[1].problem, "key/1/9") && !pl.outputs[1].ours;
});
check("keyring", "an account xprv: Electrum's watch-only PSBT, by its own fingerprint", () => {
  const c = E.cases.find((x) => x.name === "mainnet-p2wpkh-watch-only");
  const psbt = parsePsbt(readPayload(c.qr).bytes);
  const pl = plan(psbt, derive(abandon, c.account), {});
  eq([pl.signable, pl.inputs[0].path.startsWith("key/0/") || pl.inputs[0].path.startsWith("key/1/")], [psbt.inputs.length, true]);
  eq(serialize(signPsbt(psbt, derive(abandon, c.account), {}).psbt), serialize(signPsbt(psbt, abandon, {}).psbt));
});
check("keyring", "a WIF signs only its own coin, and needs no derivation", () => {
  const p = build(TWO);
  const k = single("m/84'/1'/0'/0/1");
  const pl = plan(p, k, ZERO_AUX);
  eq(pl.inputs.map((i) => [i.sign, i.path]), [[false, null], [true, null]]);
  has(pl.inputs[0].reason, "doesn't control");
  eq([pl.complete, pl.outputs[1].ours], [false, false]);
  const q = parsePsbt(serializePsbt(p));
  q.inputs[1].entries = q.inputs[1].entries.filter((e) => e.type !== IN.BIP32_DERIVATION);
  eq(plan(parsePsbt(serializePsbt(q)), k, ZERO_AUX).signable, 1);
});
check("keyring", "a WIF proves an output that pays to it, in any script", () => {
  for (const kind of ["p2wpkh", "p2sh-p2wpkh", "p2tr"]) {
    const change = { kind, path: "m/84'/1'/0'/1/0", amount: 40000 };
    const o = plan(build({ ...TWO, outputs: [EXTERNAL, change] }), single("m/84'/1'/0'/1/0"), ZERO_AUX).outputs[1];
    eq([o.ours, o.type, o.path], [true, kind, null]);
  }
});
check("keyring", "two keys: 1 of 2 each, complete together, as the master signs", () => {
  const p = build(TWO);
  const ks = [single("m/84'/1'/0'/0/0"), single("m/84'/1'/0'/0/1")];
  const pl = planKeys(p, ks, ZERO_AUX);
  eq([pl.keys.map((k) => k.signs), pl.signable, pl.complete], [[1, 1], 2, true]);
  const r = signKeys(p, ks, ZERO_AUX);
  eq([r.signed.length, r.plan.complete, r.plan.signable], [2, true, 0]);
  eq(toHex(finalize(r.psbt).tx), toHex(finalize(signPsbt(p, abandon, ZERO_AUX).psbt).tx));
});
check("keyring", "the same coin under two keys is signed once", () => {
  const r = signKeys(build(TWO), [abandon, derive(abandon, ACCOUNT)], ZERO_AUX);
  eq([r.signed.length, r.plan.complete], [2, true]);
});
check("keyring", "no keys: nothing signable, claims unchecked", () => {
  const pl = planKeys(build(TWO), [], ZERO_AUX);
  eq([pl.signable, pl.complete, pl.outputs[1].ours, pl.outputs[1].claimed, pl.outputs[0].claimed], [0, false, false, true, false]);
});

// --- merging ---------------------------------------------------------------------

const halfSigned = (p, path) => signPsbt(p, single(path), ZERO_AUX).psbt;
const merged = (p) => combine(halfSigned(p, "m/84'/1'/0'/0/0"), halfSigned(p, "m/84'/1'/0'/0/1"));

check("combine", "two half-signed copies finish the transaction", () => {
  const p = build(TWO);
  const { psbt, added } = merged(p);
  eq(added, 1);
  eq(planKeys(psbt, [], ZERO_AUX).complete, true); // no key needed: every signature is there
  eq(planKeys(halfSigned(p, "m/84'/1'/0'/0/0"), [], ZERO_AUX).complete, false);
  const held = plan(psbt, abandon, ZERO_AUX);
  eq([held.signable, held.complete, held.inputs[0].signed, held.inputs[0].reason], [0, true, true, "it is signed already"]);
  eq(toHex(finalize(psbt).tx), toHex(finalize(signPsbt(p, abandon, ZERO_AUX).psbt).tx));
});
check("combine", "the same copy twice adds nothing", () => {
  const p = build(TWO);
  const r = combine(p, p);
  eq([r.added, serialize(r.psbt)], [0, serialize(p)]);
});
check("combine", "keeps what each copy added", () => merged(build(TWO)).psbt.inputs.every((m) => m.fields.partialSigs.length === 1));
check("combine", "an entry nobody knows travels too (BIP-174: unknown keys are kept)", () => {
  const p = build(TWO), b = parsePsbt(serializePsbt(p));
  setEntry(b.inputs[0], 0xfc, Uint8Array.of(1, 2), Uint8Array.of(3));
  const r = combine(p, parsePsbt(serializePsbt(b)));
  return r.added === 1 && r.psbt.inputs[0].entries.some((e) => e.type === 0xfc);
});
check("combine", "leaves its arguments as they were", () => {
  const p = build(TWO), a = halfSigned(p, "m/84'/1'/0'/0/0"), before = serialize(a);
  combine(a, halfSigned(p, "m/84'/1'/0'/0/1"));
  eq(serialize(a), before);
});
check("combine", "a different transaction is refused", () => {
  const q = build({ ...TWO, outputs: [{ ...EXTERNAL, amount: 49999 }, CHANGE] });
  return has(throws(() => combine(build(TWO), q), CombineError).message, "different transaction");
});
check("combine", "a different version is refused", () => {
  const p = build(TWO), q = parsePsbt(serializePsbt(p));
  q.version = 2;
  return has(throws(() => combine(p, q), CombineError).message, "versions");
});
const flipped = (sig) => {
  const bad = sig.slice();
  bad[12] ^= 1;
  return bad;
};
const sigOf = (psbt) => psbt.inputs[0].fields.partialSigs[0];
const replaced = (psbt, value) => {
  const q = parsePsbt(serializePsbt(psbt));
  setEntry(q.inputs[0], IN.PARTIAL_SIG, sigOf(psbt).pubkey, value);
  return parsePsbt(serializePsbt(q));
};
const P0 = "m/84'/1'/0'/0/0";
// the same key's signature with another nonce: valid too
const otherNonce = (p) => {
  const s = halfSigned(p, P0), node = derive(abandon, P0);
  const h = segwitV0Sighash(s.tx, 0, p2wpkhScriptCode(hash160(node.publicKey)), p.inputs[0].fields.witnessUtxo.value, 1);
  const der = ref.ecdsaSign(h, node.privateKey, 3);
  return replaced(s, concat([der, [1]]));
};
check("combine", "two valid signatures by one key: the first stays, with a note", () => {
  const p = build(TWO), a = halfSigned(p, P0), b = otherNonce(p);
  if (equal(sigOf(a).signature, sigOf(b).signature)) throw new Error("the test needs two different signatures");
  const r = combine(a, b);
  eq([toHex(sigOf(r.psbt).signature), r.notes], [toHex(sigOf(a).signature),
    [{ level: "info", text: "Input 1: two valid signatures from the same key; kept one." }]]);
  return plan(r.psbt, abandon, ZERO_AUX).inputs[0].signed;
});
check("combine", "a bad signature in the second copy is dropped, in red", () => {
  const p = build(TWO), a = halfSigned(p, P0);
  const r = combine(a, replaced(a, flipped(sigOf(a).signature)));
  eq([toHex(sigOf(r.psbt).signature), r.notes.map((n) => n.level)], [toHex(sigOf(a).signature), ["danger"]]);
});
check("combine", "a bad signature in the first copy is replaced by the good one", () => {
  const p = build(TWO), good = halfSigned(p, P0), bad = replaced(good, flipped(sigOf(good).signature));
  const r = combine(bad, good);
  eq([toHex(sigOf(r.psbt).signature), r.notes.map((n) => n.level)], [toHex(sigOf(good).signature), ["danger"]]);
});
check("combine", "a signature that isn't SIGHASH_ALL counts as bad", () => {
  const p = build(TWO), a = halfSigned(p, P0), v = sigOf(a).signature.slice();
  v[v.length - 1] = 0x83;
  eq(combine(a, replaced(a, v)).notes.map((n) => n.level), ["danger"]);
});
check("combine", "both bad: the first stays, and the plan reports it", () => {
  const p = build(TWO), a = halfSigned(p, P0), v = sigOf(a).signature;
  const x = flipped(v), y = v.slice();
  y[14] ^= 1;
  const r = combine(replaced(a, x), replaced(a, y));
  eq([r.notes, toHex(sigOf(r.psbt).signature)], [[], toHex(x)]);
  return plan(r.psbt, single("m/84'/1'/0'/0/1"), ZERO_AUX).inputs[0].badSignature;
});
check("combine", "a signature it can't judge makes the copies disagree", () => {
  const p = build(TWO), a = halfSigned(p, P0);
  const b = parsePsbt(serializePsbt(a)), c = parsePsbt(serializePsbt(a));
  for (const q of [b, c]) q.inputs[0].entries = q.inputs[0].entries.filter((e) => e.type !== IN.WITNESS_UTXO);
  const nocoin = parsePsbt(serializePsbt(b));
  return has(throws(() => combine(nocoin, replaced(nocoin, flipped(sigOf(nocoin).signature))), CombineError).message, "input 1");
});
check("combine", "disagreeing coins are refused", () => {
  const p = build(TWO), b = parsePsbt(serializePsbt(p));
  setEntry(b.inputs[1], IN.WITNESS_UTXO, new Uint8Array(0), txOut(999999, p.inputs[1].fields.witnessUtxo.script));
  return has(throws(() => combine(p, parsePsbt(serializePsbt(b))), CombineError).message, "the coin spent in input 2");
});

const withSig = (psbt, i, change) => {
  const q = parsePsbt(serializePsbt(psbt));
  const s = q.inputs[i].fields.partialSigs[0];
  setEntry(q.inputs[i], IN.PARTIAL_SIG, s.pubkey, change(s.signature.slice()));
  return parsePsbt(serializePsbt(q));
};
check("combine", "a bad signature held doesn't count, and is reported", () => {
  const q = withSig(signPsbt(build(TWO), abandon, ZERO_AUX).psbt, 0, (b) => { b[12] ^= 1; return b; });
  const pl = plan(q, single("m/84'/1'/0'/0/1"), ZERO_AUX);
  eq([pl.inputs[0].signed, pl.inputs[0].badSignature, pl.complete], [false, true, false]);
  return plan(q, abandon, ZERO_AUX).inputs[0].sign; // and the right key replaces it
});
check("combine", "a held signature that isn't SIGHASH_ALL doesn't count", () => {
  const q = withSig(signPsbt(build(TWO), abandon, ZERO_AUX).psbt, 0, (b) => { b[b.length - 1] = 0x83; return b; });
  return plan(q, single("m/84'/1'/0'/0/1"), ZERO_AUX).inputs[0].badSignature;
});
check("combine", "a taproot signature held is verified", () => {
  const p = build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 100000 }], outputs: [EXTERNAL] });
  const s = signPsbt(p, abandon, ZERO_AUX).psbt;
  eq(plan(s, abandon, ZERO_AUX).inputs[0].signed, true);
  const q = parsePsbt(serializePsbt(s));
  const bad = s.inputs[0].fields.tapKeySig.slice();
  bad[3] ^= 1;
  setEntry(q.inputs[0], IN.TAP_KEY_SIG, new Uint8Array(0), bad);
  eq(plan(parsePsbt(serializePsbt(q)), abandon, ZERO_AUX).inputs[0].badSignature, true);
});

// --- change, after the keys ------------------------------------------------------

const notFee = (w) => w.level === "danger" && !w.text.includes("fee"); // (these test PSBTs pay a high one)
const reviewed = (p, keys) => applyPlan(analyze(p, { network: "testnet" }), planKeys(p, keys, ZERO_AUX));
check("review", "before keys it is a claim; a key proves it", () => {
  const p = build(TWO);
  eq(analyze(p, { network: "testnet" }).outputs[1].mine, true);
  const a = reviewed(p, [abandon]);
  eq([a.outputs[1].mine, a.outputs[1].role, a.outputs[1].checkedPath, a.toSelf, a.sent], [true, "change", "m/84'/1'/0'/1/0", 40000, 50000]);
  eq(a.warnings.filter(notFee), []);
});
check("review", "a refuted claim is red and counts as sent", () => {
  const change = { ...CHANGE, script: EXTERNAL.script };
  const a = reviewed(build({ ...TWO, outputs: [EXTERNAL, change] }), [abandon]);
  eq([a.outputs[1].mine, a.toSelf, a.sent], [false, 0, 90000]);
  return has(a.warnings.find(notFee)?.text ?? "", "pays someone else");
});
check("review", "a claim no key can check is amber and counts as sent", () => {
  const a = reviewed(build(TWO), [single("m/84'/1'/0'/0/0")]);
  eq([a.outputs[1].mine, a.outputs[1].unverified, a.toSelf, a.sent], [false, true, 0, 90000]);
  eq(a.warnings.filter(notFee), []);
  return has(a.warnings[0].text, "can check");
});
const output = (o, inputs = TWO.inputs) => ({ inputs, outputs: [EXTERNAL, { kind: "p2wpkh", amount: 40000, ...o }] });
const stray = (o, inputs) => planKeys(build(output(o, inputs)), [abandon], ZERO_AUX).outputs[1];
check("review", "change at home: same account, chain 1, near the inputs", () => {
  const o = stray({ path: "m/84'/1'/0'/1/1001" });
  eq([o.ours, o.stray, o.role], [true, null, "change"]);
});
check("review", "the receive chain is at home, and said to be", () => {
  const o = stray({ path: "m/84'/1'/0'/0/7" });
  eq([o.stray, o.role], [null, "receive"]);
});
check("review", "ransom: another account", () => has(stray({ path: "m/84'/1'/7'/1/0" }).stray, "another account"));
check("review", "ransom: another purpose", () => has(stray({ kind: "p2wpkh", path: "m/49'/1'/0'/1/0" }).stray, "another account"));
check("review", "ransom: another coin type", () => has(stray({ path: "m/84'/0'/0'/1/0" }).stray, "another account"));
check("review", "ransom: a chain other than 0 or 1", () => has(stray({ path: "m/84'/1'/0'/2/0" }).stray, "chain 2"));
check("review", "ransom: past the gap", () => has(stray({ path: "m/84'/1'/0'/1/1002" }).stray, "over 1001"));
check("review", "the gap counts from the highest input", () => {
  const inputs = [{ kind: "p2wpkh", path: "m/84'/1'/0'/0/5000", amount: 100000 }];
  eq(stray({ path: "m/84'/1'/0'/1/6000" }, inputs).stray, null);
  has(stray({ path: "m/84'/1'/0'/1/6001" }, inputs).stray, "over 6000");
});
check("review", "gap tiers, around the inputs' highest index", () => {
  const inputs = [{ kind: "p2wpkh", path: "m/84'/1'/0'/0/40", amount: 100000 }];
  const at = (past) => {
    const p = build(output({ path: `m/84'/1'/0'/1/${40 + past}` }, inputs));
    const a = reviewed(p, [abandon]), o = a.outputs[1];
    return [o.mine, o.far ?? null, o.stray !== undefined, a.toSelf, a.warnings.filter((w) => /gap limit|may not see/.test(w.text)).length];
  };
  eq(CHANGE_NEAR, 20);
  eq(at(CHANGE_NEAR), [true, null, false, 40000, 0]);
  eq(at(CHANGE_NEAR + 1), [true, 61, false, 40000, 1]);
  eq(at(CHANGE_GAP), [true, 1040, false, 40000, 1]);
  eq(at(CHANGE_GAP + 1), [false, null, true, 0, 1]);
});
check("review", "far: the highest input is over both chains, in that account", () => {
  const inputs = [{ kind: "p2wpkh", path: "m/84'/1'/0'/0/1", amount: 50000 }, { kind: "p2wpkh", path: "m/84'/1'/0'/1/100", amount: 50000 }];
  eq(stray({ path: "m/84'/1'/0'/1/120" }, inputs).far, null);
  eq(stray({ path: "m/84'/1'/0'/1/121" }, inputs).far, 121);
  eq(stray({ path: "m/84'/1'/0'/0/121" }, inputs).far, 121);
  const other = [...inputs, { kind: "p2wpkh", path: "m/84'/1'/7'/0/900", amount: 50000 }];
  eq(stray({ path: "m/84'/1'/0'/1/121" }, other).far, 121);
});
check("review", "far gives the index, and the receive chain is far too", () => {
  const a = reviewed(build(output({ path: "m/84'/1'/0'/0/900" })), [abandon]);
  eq([a.outputs[1].role, a.outputs[1].far, a.toSelf], ["receive", 900, 40000]);
  has(a.warnings[0].text, "index 900");
  return has(a.warnings[0].text, "looks that far ahead");
});
check("review", "with no input to compare with, far counts from zero", () => {
  const p = build({ inputs: [{ kind: "p2wpkh", path: "m/84'/1'/0'/0/1", amount: 100000, utxo: false }], outputs: [EXTERNAL, { ...CHANGE, path: "m/84'/1'/0'/1/21" }] });
  const o = planKeys(p, [abandon], ZERO_AUX).outputs[1];
  eq([o.ours, o.stray, o.far], [true, null, 21]);
});
check("review", "a stray output isn't far as well", () => {
  const o = stray({ path: "m/84'/1'/7'/1/500" });
  eq(o.far, null);
  has(o.stray, "another account");
});
const nothing = (a) => a.warnings.find((w) => w.text.startsWith("Nothing here"));
const foreign = { kind: "p2wpkh", amount: 50000, fp: "01020304" };
check("review", "another wallet's inputs: the first warning says why nothing can be signed", () => {
  const a = reviewed(build({ inputs: [foreign, foreign], outputs: [EXTERNAL] }), [abandon]);
  eq(a.warnings[0].level, "warn");
  has(a.warnings[0].text, "Nothing here can be signed with these keys. Inputs 1, 2: its key is from another wallet");
  return has(a.warnings[0].text, "01020304");
});
check("review", "nothing to sign, for different reasons, gives each", () => {
  const a = reviewed(build({ inputs: [foreign, { kind: "p2wpkh", amount: 50000, sighash: 2 }], outputs: [EXTERNAL] }), [abandon]);
  has(nothing(a).text, "Input 1: its key is from another wallet");
  has(nothing(a).text, "; input 2: it asks for sighash");
});
check("review", "no such warning when something can be signed, or all is signed", () => {
  eq(nothing(reviewed(build({ inputs: [foreign, { kind: "p2wpkh", amount: 50000 }], outputs: [EXTERNAL] }), [abandon])), undefined);
  const signed = signPsbt(build(TWO), abandon, ZERO_AUX).psbt;
  eq(nothing(reviewed(signed, [abandon])), undefined);
});
check("review", "partly signed by others, the rest not ours: it says so of the rest", () => {
  const p = signPsbt(build({ inputs: [foreign, { kind: "p2wpkh", amount: 50000 }], outputs: [EXTERNAL] }), abandon, ZERO_AUX).psbt;
  const a = reviewed(p, [abandon]);
  has(nothing(a).text, "Input 1: its key is from another wallet");
  return !nothing(a).text.includes("input 2");
});
check("review", "ransom: a hardened index", () => has(stray({ path: "m/84'/1'/0'/1/5'" }).stray, "hardened"));
check("review", "ransom: a short path", () => has(stray({ path: "m/84'" }).stray, "no account"));
check("review", "a stray output is amber with its path, and counts as sent", () => {
  const a = reviewed(build(output({ path: "m/84'/1'/7'/1/500000" })), [abandon]);
  eq([a.outputs[1].mine, a.outputs[1].stray, a.toSelf, a.sent], [false, "m/84'/1'/7'/1/500000", 0, 90000]);
  eq(a.warnings.filter(notFee), []);
  return has(a.warnings[0].text, "yours, but at m/84'/1'/7'/1/500000: the wallet may not see it");
});
check("review", "an account xprv: at home below its own fingerprint and not at another account", () => {
  const acct = derive(abandon, ACCOUNT);
  eq(planKeys(build(TWO), [acct], ZERO_AUX).outputs[1].stray, null);
  const c = E.cases.find((x) => x.name === "mainnet-p2wpkh-watch-only");
  const q = parsePsbt(readPayload(c.qr).bytes);
  eq(planKeys(q, [derive(abandon, c.account)], {}).outputs.filter((o) => o.ours).map((o) => o.stray), [null]);
});
check("review", "one account, named by its xprv's fingerprint in one place and the master's in another", () => {
  const acct = derive(abandon, ACCOUNT), own = fingerprint(acct).slice();
  const byOwn = { kind: "p2wpkh", path: "m/84'/1'/0'/0/0", amount: 100000, fp: own, claimPath: "m/0/0" };
  const byMaster = { kind: "p2wpkh", path: "m/84'/1'/0'/0/0", amount: 100000 };
  const changeOwn = { ...CHANGE, fp: own, claimPath: "m/1/0" };
  for (const [input, change] of [[byOwn, CHANGE], [byMaster, changeOwn]]) {
    const p = build({ inputs: [input], outputs: [EXTERNAL, change] });
    for (const keys of [[acct], [abandon, acct], [acct, abandon]]) {
      const o = planKeys(p, keys, ZERO_AUX).outputs[1];
      eq([o.ours, o.stray], [true, null]);
    }
  }
  // and another account still isn't that account
  const other = derive(abandon, "m/84'/1'/7'");
  const q = build({ inputs: [{ ...byOwn, fp: fingerprint(other).slice(), path: "m/84'/1'/7'/0/0" }], outputs: [EXTERNAL, CHANGE] });
  has(planKeys(q, [other, acct], ZERO_AUX).outputs[1].stray, "another account");
});
check("review", "an xprv on the chain level still names the account", () => {
  const chain = derive(abandon, ACCOUNT + "/1");
  const p = build({ inputs: [{ kind: "p2wpkh", path: "m/84'/1'/0'/1/3", amount: 100000 }], outputs: [EXTERNAL, CHANGE] });
  eq(planKeys(p, [chain, abandon], ZERO_AUX).outputs[1].stray, null);
});
check("review", "a single key: at home if it spends, else not", () => {
  const change = { kind: "p2wpkh", path: "m/84'/1'/0'/0/0", amount: 40000 };
  const p = build({ ...TWO, outputs: [EXTERNAL, change] });
  eq(planKeys(p, [single("m/84'/1'/0'/0/0")], ZERO_AUX).outputs[1].stray, null);
  const q = build({ inputs: [{ kind: "p2wpkh", path: "m/84'/1'/0'/0/1", amount: 100000 }], outputs: [EXTERNAL, change] });
  has(planKeys(q, [single("m/84'/1'/0'/0/1"), single("m/84'/1'/0'/0/0")], ZERO_AUX).outputs[1].stray, "spends nothing");
});
check("review", "merged and signed inputs still anchor the account", () => {
  const p = build(output({ path: "m/84'/1'/7'/1/0" }));
  const s = signPsbt(p, abandon, ZERO_AUX).psbt;
  has(planKeys(s, [abandon], ZERO_AUX).outputs[1].stray, "another account");
});
check("review", "a bad signature held is red", () => {
  const q = withSig(signPsbt(build(TWO), abandon, ZERO_AUX).psbt, 1, (b) => { b[12] ^= 1; return b; });
  return has(reviewed(q, [single("m/84'/1'/0'/0/0")]).warnings[0].text, "Input 2");
});

// --- legacy ------------------------------------------------------------------------

const LEGACY = "m/44'/1'/0'/0/0";
const secretOf = (path) => derive(abandon, path);
const uncompressed = (path) => {
  const n = secretOf(path);
  return parseWif(base58CheckEncode(concat([[0xef], n.privateKey]))).key;
};
const hash65 = (path) => hash160(uncompressed(path).publicKey);
const oneOut = [{ ...EXTERNAL, amount: 49000 }];
const spending = (kind, script, extra = {}) => build({ inputs: [{ kind, path: LEGACY, amount: 50000, script, ...extra }], outputs: oneOut });

// The segwit v0 fee attack (the security review's M2): an amber warning with
// what to do, and the Signer's memory of what it signed (memory below).
const FEE_ATTACK = "their amounts are only the PSBT's word";
const feeAttack = (a) => a.warnings.filter((w) => w.text.includes("leave out the previous transaction"));
check("rules", "segwit v0 with only WITNESS_UTXO signs, and two such inputs are amber", () => {
  const p = build(TWO);
  if (p.inputs.some((m) => !m.fields.witnessUtxo || m.fields.nonWitnessUtxo)) throw new Error("not the case under test");
  const pl = plan(p, abandon, ZERO_AUX);
  eq([pl.signable, pl.complete], [2, true]);
  eq(parseTx(finalize(signPsbt(p, abandon, ZERO_AUX).psbt).tx).inputs.map((i) => i.witness.length), [2, 2]);
  const w = feeAttack(reviewed(p, [abandon]));
  eq(w.map((x) => x.level), ["warn"]);
  has(w[0].text, "Inputs 1, 2: " + FEE_ATTACK);
  has(w[0].text, "much larger fee than shown");
  has(w[0].text, "sign the same coins again, don't, unless the amounts are the same");
});
check("rules", "the fee attack, as the review showed it: each round amber; the two signatures pay the real fee", () => {
  const REAL = 100000000, LIE = 10000, out = [{ ...EXTERNAL, amount: REAL }];
  const round = (amounts) => build({ inputs: amounts.map((amount) => ({ kind: "p2wpkh", amount })), outputs: out });
  const sigs = [];
  for (const [k, amounts] of [[0, [REAL, LIE]], [1, [LIE, REAL]]]) {
    const p = round(amounts), a = analyze(p, { network: "testnet" });
    eq(a.fee, LIE, "the fee shown");
    eq(feeAttack(a).map((x) => x.level), ["warn"]);
    sigs.push(signPsbt(p, abandon, ZERO_AUX).psbt.inputs[k].fields.partialSigs[0]);
  }
  const real = round([REAL, REAL]);
  sigs.forEach((s, i) => {
    const h = segwitV0Sighash(real.tx, i, p2wpkhScriptCode(hash160(s.pubkey)), REAL, 1);
    if (!ref.ecdsaVerify(s.signature.subarray(0, s.signature.length - 1), h, s.pubkey)) throw new Error("not the attack");
  });
});
check("rules", "with the previous transactions the amounts are proved: no warning, and a lie is refused", () => {
  const p = build({ inputs: [{ kind: "p2wpkh", amount: 100000, full: true }, { kind: "p2wpkh", amount: 20000, full: true, utxo: true }], outputs: [EXTERNAL, CHANGE] });
  const a = reviewed(p, [abandon]);
  eq([feeAttack(a), a.inputs.map((i) => i.utxo), a.fee], [[], ["both", "both"], 30000]);
  eq(plan(p, abandon, ZERO_AUX).signable, 2);
  // the witness UTXO understates input 2: the previous transaction says otherwise
  const lie = build({ inputs: [{ kind: "p2wpkh", amount: 100000, full: true }, { kind: "p2wpkh", amount: 20000, full: true, witnessAmount: 10 }], outputs: [EXTERNAL, CHANGE] });
  const b = reviewed(lie, [abandon]);
  eq([feeAttack(b), b.inputs[1].amount, b.fee], [[], 20000, 30000], "the previous transaction's amount");
  has(b.warnings.find((w) => w.level === "danger").text, "disagree");
  has(plan(lie, abandon, ZERO_AUX).inputs[1].reason, "disagree");
  // the previous transaction alone: its amount is the one shown
  const only = build({ inputs: [{ kind: "p2wpkh", amount: 100000, full: true, witnessUtxo: false }, { kind: "p2wpkh", amount: 20000, full: true, witnessUtxo: false }], outputs: [EXTERNAL, CHANGE] });
  const c = reviewed(only, [abandon]);
  eq([feeAttack(c), c.inputs.map((i) => [i.utxo, i.amount]), plan(only, abandon, ZERO_AUX).signable], [[], [["full", 100000], ["full", 20000]], 2]);
});
check("rules", "one input of two without its previous transaction is amber, naming it", () => {
  const a = reviewed(build({ inputs: [{ kind: "p2wpkh", amount: 100000, full: true }, { kind: "p2wpkh", amount: 20000 }], outputs: [EXTERNAL, CHANGE] }), [abandon]);
  eq(feeAttack(a).map((w) => w.level), ["warn"]);
  has(feeAttack(a)[0].text, "Input 2: its amount is only the PSBT's word");
});
check("rules", "one segwit v0 input: its signature covers its amount, no warning", () => {
  const a = reviewed(build({ inputs: [TWO.inputs[0]], outputs: oneOut }), [abandon]);
  eq(feeAttack(a), []);
});
check("rules", "taproot inputs are exempt: their signatures cover every amount", () => {
  const tr = (i, amount) => ({ kind: "p2tr", path: `m/86'/1'/0'/0/${i}`, amount });
  eq(feeAttack(reviewed(build({ inputs: [tr(0, 80000), tr(1, 1000)], outputs: oneOut }), [abandon])), []);
  // one segwit v0 input beside taproot: still only one v0 signature
  eq(feeAttack(reviewed(build({ inputs: [tr(0, 80000), { kind: "p2wpkh", amount: 1000 }], outputs: oneOut }), [abandon])), []);
  // two v0 inputs beside taproot: amber
  const a = reviewed(build({ inputs: [tr(0, 80000), { kind: "p2wpkh", amount: 1000 }, { kind: "p2wpkh", amount: 2000 }], outputs: oneOut }), [abandon]);
  has(feeAttack(a)[0].text, "Inputs 2, 3: ");
});
check("rules", "an input amount over 21 million BTC is red (the review's I2)", () => {
  const a = analyze(build({ inputs: [{ kind: "p2wpkh", amount: 2100000000000001 }], outputs: oneOut }), { network: "testnet" });
  has(a.warnings.find((w) => w.level === "danger").text, "Input 1: the amount is larger than all bitcoin there can be");
  eq([a.inputs[0].amount, a.fee], [null, null]);
  eq(analyze(build({ inputs: [{ kind: "p2wpkh", amount: 2100000000000000 }], outputs: oneOut }), { network: "testnet" })
    .warnings.filter((w) => w.text.includes("all bitcoin")), []);
});
// The Signer's memory of what it signed since power-on (apps/signer/lib/memory.js),
// over a stand-in for gk:session: values copied in and out, as there.
const sessionStore = () => {
  const m = new Map();
  return { get: (k) => structuredClone(m.get(k)), set: (k, v) => void m.set(k, structuredClone(v)), map: m };
};
const amountsOf = (p) => analyze(p, { network: "testnet" }).inputs.map((i) => i.amount);
{
  const REAL = 100000000, LIE = 10000, out = [{ ...EXTERNAL, amount: REAL }];
  const round = (amounts, more = {}) => build({ inputs: amounts.map((amount) => ({ kind: "p2wpkh", amount, ...more })), outputs: out });
  check("memory", "round 1 signs and records; round 2, the amounts swapped, is red and names both", () => {
    const memory = new SignedMemory(sessionStore());
    const one = round([REAL, LIE]);
    eq(memory.check(one, amountsOf(one)), { same: [], changed: [] });
    const r = signPsbt(one, abandon, ZERO_AUX);
    memory.record(one, r.signed.map((s) => s.input), amountsOf(one));
    const two = round([LIE, REAL]);
    const seen = memory.check(two, amountsOf(two));
    eq(seen, { same: [], changed: [{ index: 0, before: REAL, now: LIE }, { index: 1, before: LIE, now: REAL }] });
    const w = memory.warnings(seen);
    eq(w.map((x) => x.level), ["danger", "danger"]);
    has(w[0].text, "Input 1 was signed before, since this device was switched on, as spending 1.00000000 BTC; now it says 0.00010000 BTC.");
    has(w[1].text, "segwit fee attack");
    has(w[1].text, "It is not signed");
  });
  check("memory", "the same amounts again: an info line, nothing refused", () => {
    const memory = new SignedMemory(sessionStore());
    const p = round([REAL, LIE]);
    memory.record(p, [0, 1], amountsOf(p));
    const seen = memory.check(round([REAL, LIE]), amountsOf(p));
    eq(seen, { same: [0, 1], changed: [] });
    eq(memory.warnings(seen).map((x) => [x.level, String(x.text)]),
      [["info", "Inputs 1, 2: signed before since this device was switched on, with the same amounts."]]);
  });
  check("memory", "only what was signed is recorded, and only outpoints and amounts", () => {
    const store = sessionStore(), memory = new SignedMemory(store);
    const p = round([REAL, LIE]);
    memory.record(p, [1], amountsOf(p));
    eq(memory.check(round([LIE, REAL]), [LIE, REAL]).changed.map((c) => c.index), [1]);
    const kept = store.get("signed");
    eq(Object.values(kept), [LIE]);
    eq(Object.keys(kept), [`${toHex(p.tx.inputs[1].txid.slice().reverse())}:1`]);
    eq([...store.map.keys()], ["signed"]);
  });
  check("memory", "power-off (a fresh store) forgets it all", () => {
    const memory = new SignedMemory(sessionStore());
    const p = round([REAL, LIE]);
    memory.record(p, [0, 1], amountsOf(p));
    eq(new SignedMemory(sessionStore()).check(round([LIE, REAL]), [LIE, REAL]), { same: [], changed: [] });
  });
  check("memory", "proved amounts and taproot are recorded and checked too", () => {
    const memory = new SignedMemory(sessionStore());
    const full = round([REAL, LIE], { full: true });
    memory.record(full, [0, 1], amountsOf(full));
    eq(memory.check(full, amountsOf(full)).same, [0, 1]);
    const tr = build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 80000 }], outputs: oneOut });
    memory.record(tr, [0], amountsOf(tr));
    eq(memory.check(tr, [79999]).changed.map((c) => c.index), [0]);
  });
  check("memory", `at most ${MAX_ENTRIES} coins, the oldest forgotten; a full store keeps half`, () => {
    const store = sessionStore(), memory = new SignedMemory(store);
    const coin = (i) => ({ tx: { inputs: [{ txid: sha("m" + i), vout: 0 }] } });
    for (let i = 0; i <= MAX_ENTRIES; i++) memory.record(coin(i), [0], [i + 1]);
    eq([memory.check(coin(0), [1]).same, memory.check(coin(1), [2]).same, Object.keys(store.get("signed")).length], [[], [0], MAX_ENTRIES]);
    const small = { ...sessionStore(), set(k, v) {
      if (Object.keys(v).length > MAX_ENTRIES / 2) throw new RangeError("full");
      this.v = structuredClone(v);
    }, get() { return structuredClone(this.v); } };
    const m2 = new SignedMemory(small);
    for (let i = 0; i <= MAX_ENTRIES; i++) m2.record(coin(i), [0], [i + 1]);
    eq(m2.check(coin(MAX_ENTRIES), [MAX_ENTRIES + 1]).same, [0]);
  });
}
check("rules", "finalize takes no signature that doesn't verify (a merged copy's)", () => {
  const p = build(TWO), s = signPsbt(p, abandon, ZERO_AUX).psbt;
  const q = parsePsbt(serializePsbt(s)), sig = q.inputs[1].fields.partialSigs[0];
  setEntry(q.inputs[1], IN.PARTIAL_SIG, sig.pubkey, flipped(sig.signature));
  const bad = parsePsbt(serializePsbt(q));
  has(throws(() => finalize(bad), SignError).message, "input 2: its signature doesn't verify");
  eq(planKeys(bad, [], {}).complete, false);
  const t = build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 80000 }], outputs: oneOut });
  const ts = parsePsbt(serializePsbt(signPsbt(t, abandon, ZERO_AUX).psbt));
  setEntry(ts.inputs[0], IN.TAP_KEY_SIG, new Uint8Array(0), flipped(ts.inputs[0].fields.tapKeySig));
  has(throws(() => finalize(parsePsbt(serializePsbt(ts))), SignError).message, "input 1: its signature doesn't verify");
});
check("p2pkh", "an uncompressed key signs its P2PKH coin, checked apart from the library", () => {
  const k = uncompressed(LEGACY), script = p2pkhScript(hash65(LEGACY));
  const p = spending("p2pkh", script, { noOrigin: true });
  const pl = plan(p, k, ZERO_AUX);
  eq([pl.signable, pl.complete, pl.inputs[0].type, pl.inputs[0].pubkey.length], [1, true, "p2pkh", 130]);
  const s = signPsbt(p, k, ZERO_AUX).psbt, sig = s.inputs[0].fields.partialSigs[0];
  eq(sig.pubkey.length, 65);
  const der = sig.signature.subarray(0, sig.signature.length - 1);
  if (!ref.ecdsaVerify(der, legacySighash(s.tx, 0, script, 1), k.publicKey)) throw new Error("the reference refuses the signature");
  const tx = parseTx(finalize(s).tx), scriptSig = tx.inputs[0].scriptSig;
  eq([scriptSig[0], scriptSig[scriptSig.length - 66], toHex(scriptSig.subarray(scriptSig.length - 65))],
    [sig.signature.length, 65, toHex(k.publicKey)]);
});
check("p2pkh", "the compressed form of that key doesn't control it, and the reverse", () => {
  has(plan(spending("p2pkh", p2pkhScript(hash65(LEGACY))), single(LEGACY), ZERO_AUX).inputs[0].reason, "doesn't control");
  has(plan(spending("p2pkh"), uncompressed(LEGACY), ZERO_AUX).inputs[0].reason, "doesn't control");
});
check("p2pkh", "an uncompressed key never signs segwit, though the hash is its own", () => {
  const h = hash65(LEGACY), k = uncompressed(LEGACY);
  has(plan(spending("p2wpkh", p2wpkhScript(h)), k, ZERO_AUX).inputs[0].reason, "only legacy");
  const redeem = p2wpkhScript(h);
  has(plan(spending("p2sh-p2wpkh", p2shScript(hash160(redeem)), { redeemScript: redeem }), k, ZERO_AUX).inputs[0].reason, "only legacy");
  eq(plan(build({ inputs: [{ kind: "p2tr", path: "m/86'/1'/0'/0/0", amount: 50000 }], outputs: oneOut }), k, ZERO_AUX).signable, 0);
  eq(signPsbt(spending("p2wpkh", p2wpkhScript(h)), k, ZERO_AUX).signed, []);
});
check("p2pkh", "an uncompressed key proves only a P2PKH output", () => {
  const k = uncompressed(LEGACY), h = hash65(LEGACY);
  const out = (script) => plan(build({ inputs: [{ kind: "p2pkh", path: "m/44'/1'/0'/0/1", amount: 50000 }], outputs: [{ script, amount: 40000 }] }), k, ZERO_AUX).outputs[0];
  eq([out(p2pkhScript(h)).ours, out(p2pkhScript(h)).type, out(p2wpkhScript(h)).ours, out(p2shScript(hash160(p2wpkhScript(h)))).ours], [true, "p2pkh", false, false]);
});
check("p2pkh", "a held signature by an uncompressed key is verified, and finishes", () => {
  const p = spending("p2pkh", p2pkhScript(hash65(LEGACY))), s = signPsbt(p, uncompressed(LEGACY), ZERO_AUX).psbt;
  eq(planKeys(s, [], ZERO_AUX).complete, true);
  eq(combine(p, s).added, 1);
  const q = withSig(s, 0, (b) => { b[12] ^= 1; return b; });
  eq([planKeys(q, [], ZERO_AUX).complete, planKeys(q, [], ZERO_AUX).inputs[0].badSignature], [false, true]);
});
check("p2pkh", "a 65-byte signature's key on a segwit coin doesn't count", () => {
  const h = hash65(LEGACY), p = spending("p2wpkh", p2wpkhScript(h)), q = parsePsbt(serializePsbt(p));
  setEntry(q.inputs[0], IN.PARTIAL_SIG, uncompressed(LEGACY).publicKey, new Uint8Array(71).fill(1));
  eq(planKeys(parsePsbt(serializePsbt(q)), [], ZERO_AUX).complete, false);
});
check("p2pkh", "legacy, nested and native in one transaction", () => {
  const p = build({ inputs: [{ kind: "p2pkh", path: LEGACY, amount: 30000 }, { kind: "p2sh-p2wpkh", path: "m/49'/1'/0'/0/0", amount: 30000 },
    { kind: "p2wpkh", path: "m/84'/1'/0'/0/0", amount: 30000 }], outputs: [{ ...EXTERNAL, amount: 89000 }] });
  const r = signPsbt(p, abandon, ZERO_AUX);
  eq(r.plan.complete, true);
  const tx = parseTx(finalize(r.psbt).tx);
  eq(tx.inputs.map((i) => [i.scriptSig.length > 60 ? "sig" : i.scriptSig.length ? "redeem" : "none", i.witness.length]), [["sig", 0], ["redeem", 2], ["none", 2]]);
});
check("p2pkh", "change in the legacy account is at home; a segwit one isn't", () => {
  const inputs = [{ kind: "p2pkh", path: "m/44'/1'/0'/0/3", amount: 100000 }];
  const c = (o) => planKeys(build({ inputs, outputs: [EXTERNAL, { kind: "p2pkh", amount: 40000, ...o }] }), [abandon], ZERO_AUX).outputs[1];
  eq(c({ path: "m/44'/1'/0'/1/0" }).stray, null);
  has(c({ kind: "p2wpkh", path: "m/84'/1'/0'/1/0" }).stray, "another account");
});
check("p2pkh", "a large legacy PSBT through BBQr, signed as if it came whole", () => {
  const p = build({ inputs: [0, 1, 2].map((i) => ({ kind: "p2pkh", path: `m/44'/1'/0'/0/${i}`, amount: 30000, prevOutputs: 60 })), outputs: [{ ...EXTERNAL, amount: 89000 }] });
  const b = serializePsbt(p);
  if (b.length < 3500) throw new Error(`only ${b.length} bytes`);
  const { parts } = seriesFor(b, "psbt"), r = new CodeReader();
  const q = parsePsbt(parts.map((t) => r.read(t)).at(-1).payload.bytes);
  eq(toHex(finalize(signPsbt(q, abandon, ZERO_AUX).psbt).tx), toHex(finalize(signPsbt(p, abandon, ZERO_AUX).psbt).tx));
});
check("p2pkh", "a previous transaction with the wrong output is refused, whatever its size", () => {
  const p = build({ inputs: [{ kind: "p2pkh", path: LEGACY, amount: 30000, prevOutputs: 5 }], outputs: oneOut });
  const q = parsePsbt(serializePsbt(p));
  const prev = p.inputs[0].fields.nonWitnessUtxo;
  const forged = { ...prev, outputs: prev.outputs.map((o, i) => (i === 1 ? { ...o, value: o.value + 1 } : o)) };
  setEntry(q.inputs[0], IN.NON_WITNESS_UTXO, new Uint8Array(0), serializeTx(forged));
  return has(plan(parsePsbt(serializePsbt(q)), abandon, ZERO_AUX).inputs[0].reason, "wrong txid");
});

// --- descriptors -----------------------------------------------------------------

const D = JSON.parse(readFileSync(new URL("./descriptor_vectors.json", import.meta.url), "utf8"));
const bodyOf = (s) => s.slice(0, s.length - 9);
check("descriptor", "Bitcoin Core's valid checksums", () => {
  if (D.core_valid.length < 5) throw new Error("the vectors are missing");
  for (const s of D.core_valid) eq(`${bodyOf(s)}#${descriptorChecksum(bodyOf(s))}`, s);
  return D.core_valid.every(checkDescriptor);
});
check("descriptor", "Bitcoin Core's invalid checksums", () => D.core_invalid.length >= 5 && !D.core_invalid.some(checkDescriptor));
check("descriptor", "BIP-380's valid checksum", () => D.bip380_valid.every(checkDescriptor));
for (const s of D.bip380_invalid) check("descriptor", `BIP-380 refuses ${JSON.stringify(s)}`, () => !checkDescriptor(s));
check("descriptor", "multipath, against an independent BIP-380 in Python", () => {
  for (const s of D.multipath) eq(descriptorChecksum(bodyOf(s)), s.slice(-8));
  return D.multipath.length === 4;
});
check("descriptor", "BIP-84's account, in the plan's form", () => {
  const acct = neuter(derive(abandon, "m/84'/0'/0'"));
  const d = accountDescriptor({ script: "p2wpkh", fingerprint: ABANDON_FP, network: "mainnet", account: 0, xpub: serializeXpub(acct, "xpub") });
  eq(d, D.multipath[0]);
});
check("descriptor", "BIP-49 on a test network, nested", () => {
  const acct = neuter(derive(abandon, "m/49'/1'/0'"));
  const d = accountDescriptor({ script: "p2sh-p2wpkh", fingerprint: ABANDON_FP, network: "testnet", account: 0, xpub: serializeXpub(acct, "tpub") });
  return d.startsWith(`sh(wpkh([${ABANDON_FP}/49h/1h/0h]tpub`) && d.includes("/<0;1>/*))#") && checkDescriptor(d);
});
// What a wallet does with tr(KEY): the output script, from BIP-341's tweak with no script tree.
const trScript = (x) => "5120" + toHex(ref.taprootTweakPublicKey(x, taggedHash("TapTweak", x)).key);
const taprootExport = (network, account) => accountDescriptor({ script: "p2tr", fingerprint: ABANDON_FP, network, account,
  xpub: serializeXpub(neuter(derive(abandon, `m/86'/${network === "mainnet" ? 0 : 1}'/${account}'`)), network === "mainnet" ? "xpub" : "tpub") });
check("descriptor", "BIP-86's account, in the plan's form, against an independent BIP-380 in Python", () => {
  const d = taprootExport("mainnet", 0);
  eq(d, D.multipath[3]);
  eq(d, accountDescriptor({ script: "p2tr", fingerprint: ABANDON_FP, network: "mainnet", account: 0, xpub: V.bip86.xpub }));
  return checkDescriptor(d);
});
check("descriptor", "tr() as exported derives BIP-86's published addresses", () => {
  const m = /^tr\(\[73c5da0a\/86h\/0h\/0h\]([1-9A-HJ-NP-Za-km-z]+)\/<0;1>\/\*\)#[a-z0-9]{8}$/.exec(taprootExport("mainnet", 0));
  if (!m) throw new Error("not tr(KEY/<0;1>/*)");
  const acct = parseXpub(m[1]).node;
  for (const a of V.bip86.addresses) {
    const [chain, index] = a.path.split("/").slice(-2).map(Number);
    const x = deriveChild(deriveChild(acct, chain), index).publicKey.subarray(1);
    eq(toHex(x), a.internal_key);
    eq(trScript(x), a.scriptPubKey);
    eq(scriptToAddress(fromHex(trScript(x)), "mainnet"), a.address);
  }
});
check("descriptor", "BIP-386: tr(KEY) with a raw key and a WIF gives the BIP's script", () => {
  const want = "512077aab6e066f8a7419c5ab714c12c67d25007ed55a43cadcacb4d7a970a093f11";
  eq(trScript(fromHex("a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd")), want);
  const k = parseWif("L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1");
  eq(trScript(ref.publicKey(k.key.privateKey).subarray(1)), want);
});
check("descriptor", "taproot on a test network, in its account", () => {
  const d = taprootExport("testnet", 7);
  return d.startsWith(`tr([${ABANDON_FP}/86h/1h/7h]tpub`) && d.includes("/<0;1>/*)#") && checkDescriptor(d);
});
check("descriptor", "the account number goes in the path", () => {
  const xpub = serializeXpub(neuter(derive(abandon, "m/44'/0'/7'")), "xpub");
  return accountDescriptor({ script: "p2pkh", fingerprint: ABANDON_FP, network: "mainnet", account: 7, xpub }).startsWith(`pkh([${ABANDON_FP}/44h/0h/7h]`);
});
check("descriptor", "refuses what would make a wrong one", () => {
  const xpub = serializeXpub(neuter(abandon), "xpub"), good = { script: "p2wpkh", fingerprint: ABANDON_FP, network: "mainnet", account: 0, xpub };
  throws(() => accountDescriptor({ ...good, script: "p2wsh" }), RangeError);
  throws(() => accountDescriptor({ ...good, fingerprint: "73C5DA0A" }), RangeError);
  throws(() => accountDescriptor({ ...good, fingerprint: null }), RangeError);
  throws(() => accountDescriptor({ ...good, account: -1 }), RangeError);
  throws(() => accountDescriptor({ ...good, account: 2 ** 31 }), RangeError);
  throws(() => accountDescriptor({ ...good, network: "testnet" }), RangeError);
  throws(() => accountDescriptor({ ...good, xpub: serializeXpub(neuter(abandon), "zpub") }), RangeError);
  return true;
});

// --- what the camera reads: BBQr ----------------------------------------------------

const BIG = serializePsbt(build({ inputs: Array.from({ length: 12 }, (_, i) => ({ kind: "p2wpkh", path: `m/84'/1'/0'/0/${i}`, amount: 10000 })),
  outputs: [EXTERNAL] }));
const readAll = (r, parts) => parts.map((t) => r.read(t)).at(-1);
for (const encoding of ["H", "2", "Z"]) {
  check("codes", `a PSBT in BBQr, encoding ${encoding}, in any order`, () => {
    const { parts } = split(BIG, "P", { encoding, maxVersion: 8, maxParts: 20 });
    if (parts.length < 2) throw new Error("the test needs several parts");
    const r = new CodeReader();
    const got = readAll(r, [...parts.slice(1), parts[1], parts[0]]);
    eq([got.payload.kind, got.payload.encoding, toHex(got.payload.bytes)], ["psbt", "BBQr", toHex(BIG)]);
    return !r.started;
  });
}
check("codes", "one part is enough for a small one", () => {
  const p = build(TWO), b = serializePsbt(p);
  const { parts } = split(b, "P", { minVersion: 25 });
  eq(parts.length, 1);
  return equal(new CodeReader().read(parts[0]).payload.bytes, b);
});
check("codes", "progress, and a repeated code counts once", () => {
  const { parts } = split(BIG, "P", { encoding: "2", maxVersion: 8, maxParts: 20 });
  const r = new CodeReader();
  eq(r.read(parts[0]).part, { have: 1, total: parts.length, added: true });
  eq(r.read(parts[0]).part, { have: 1, total: parts.length, added: false });
  return r.started;
});
check("codes", "a transaction in BBQr", () => {
  const tx = finalize(signPsbt(build(TWO), abandon, ZERO_AUX).psbt).tx;
  eq(new CodeReader().read(split(tx, "T", { encoding: "2", minVersion: 20 }).parts[0]).payload.kind, "tx");
});
check("codes", "Electrum's code goes by as before", () => {
  const c = E.cases[0], got = new CodeReader().read(c.qr);
  eq([got.payload.kind, got.payload.encoding, got.payload.chars], ["psbt", "base43", c.qr.length]);
});
check("codes", "another series is refused, the first goes on, or starts over", () => {
  const { parts } = split(BIG, "P", { encoding: "2", maxVersion: 8, maxParts: 20 });
  const tx = finalize(signPsbt(build(TWO), abandon, ZERO_AUX).psbt).tx;
  const other = split(tx, "T", { encoding: "2", minVersion: 25 }).parts[0];
  const r = new CodeReader();
  r.read(parts[0]);
  has(throws(() => r.read(other), CodesDecodeError).message, "another series");
  eq(r.started, true);
  eq(toHex(readAll(r, parts).payload.bytes), toHex(BIG));
  r.read(parts[0]);
  r.reset();
  eq(r.read(other).payload.kind, "tx");
});
check("codes", "other files are refused, saying what they are", () => {
  const u = split(new TextEncoder().encode("hello"), "U", { encoding: "2", minVersion: 20 }).parts[0];
  return has(throws(() => new CodeReader().read(u), CodesDecodeError).message, "text");
});
check("codes", "a series that says PSBT and isn't one", () => {
  const u = split(new Uint8Array(40).fill(7), "P", { encoding: "2", minVersion: 20 }).parts[0];
  return has(throws(() => new CodeReader().read(u), CodesDecodeError).message, "isn't one");
});
check("codes", "a damaged deflate stream is refused, and the reader is free again", () => {
  const z = "B$ZP0100" + toBase32(new Uint8Array(16).fill(0xff));
  const r = new CodeReader();
  has(throws(() => r.read(z), CodesDecodeError).message, "don't make a file");
  return !r.started;
});
check("codes", "a deflate bomb stops at the limit", () => {
  const big = new Uint8Array(3 << 20);
  const text = "B$ZP0100" + toBase32(deflateRaw(big));
  return has(throws(() => new CodeReader().read(text), CodesDecodeError).message, "don't make a file");
});
check("codes", "a PSBT over 256 KiB is refused, also uncompressed (the review's L3)", () => {
  const big = concat([MAGIC, new Uint8Array((256 << 10) + 1 - MAGIC.length).fill(0x41)]);
  const r = new CodeReader();
  let e = null;
  for (const t of split(big, "P", { encoding: "2" }).parts) {
    try {
      r.read(t);
    } catch (x) {
      e = x;
    }
  }
  has(e && e.message, "More than 262144 bytes");
  const text = "B$ZP0100" + toBase32(deflateRaw(new Uint8Array(300 << 10)));
  has(throws(() => new CodeReader().read(text), CodesDecodeError).message, "more than 262144 bytes");
});
check("codes", "more than 200 inputs or 500 outputs are refused, saying so", () => {
  const tx = (ins, outs) => ({ inputs: new Array(ins).fill({}), outputs: new Array(outs).fill({}) });
  eq([sizeProblem(tx(200, 500)), sizeProblem(tx(1, 1))], [null, null]);
  eq(String(sizeProblem(tx(201, 1))), "This transaction has 201 inputs: this signer checks at most 200.");
  eq(String(sizeProblem(tx(1, 501))), "This transaction has 501 outputs: this signer checks at most 500.");
});
check("codes", "two contents for one part are refused", () => {
  const { parts } = split(BIG, "P", { encoding: "2", maxVersion: 8, maxParts: 20 });
  const r = new CodeReader();
  r.read(parts[0]);
  const bad = parts[0].slice(0, -8) + "AAAAAAAA";
  return has(throws(() => r.read(bad), CodesDecodeError).message, "can't be used");
});
for (const [name, size, most] of [["small", 900, 8], ["large", 6000, 40]]) {
  check("codes", `what the signer shows: a ${name} file, at one version up to 12`, () => {
    const bytes = new Uint8Array(size).map((_, i) => (i * 2654435761) >>> 13);
    const s = seriesFor(bytes, "tx");
    if (s.version > 12 || s.parts.length > most) throw new Error(`version ${s.version}, ${s.parts.length} parts`);
    const j = new Joiner();
    for (const p of s.parts) j.add(p);
    return equal(j.result().bytes, bytes) && j.result().type === "T";
  });
}
check("codes", "a PSBT's series says it is one, and reads back", () => {
  const got = new CodeReader();
  const { parts } = seriesFor(BIG, "psbt");
  return equal(parts.map((t) => got.read(t)).at(-1).payload.bytes, BIG);
});
check("codes", "a BBQr-looking text with a bad header isn't a part", () =>
  throws(() => new CodeReader().read("B$ZP!!!!"), CodesDecodeError));

// The codes tests/signer.txt shows the camera (tests/signer/make_scenario.py)
// --- multisig -----------------------------------------------------------------------

const COSIGNERS = [abandon, fromSeed(new Uint8Array(32).fill(1)), fromSeed(new Uint8Array(32).fill(2))];
const MS = "m/48'/1'/0'/2'";
const msPub = (c, at) => derive(COSIGNERS[c], `${MS}/${at}`).publicKey;
const xpubEntry = (c, { fp = fingerprint(COSIGNERS[c]), path = MS } = {}) => {
  const raw = decodeBase58(serializeXpub(neuter(derive(COSIGNERS[c], path)), "tpub"));
  return [GLOBAL.XPUB, raw, origin(fp, parsePath(path))];
};
const decodeBase58 = (text) => base58CheckDecode(text);
const XPUBS = [0, 1, 2].map((c) => xpubEntry(c));
const compare = (a, b) => (toHex(a) < toHex(b) ? -1 : 1);
// The keys of a script: [cosigner, relative path, options], sorted
// (sortedmulti), or as they come (sort false: plain multi).
function msScript(places, m = 2, sort = true) {
  const keys = places.map(([c, at, o = {}]) => ({ pub: o.pub || msPub(c, at), fp: o.fp || fingerprint(COSIGNERS[c]), path: o.path || `${MS}/${at}` }));
  if (sort) keys.sort((a, b) => compare(a.pub, b.pub));
  return { ws: multisigScript(m, keys.map((k) => k.pub)), keys };
}
const coinScript = (ws, type) => (type === "p2sh-p2wsh" ? p2shScript(hash160(p2wshScript(ref.sha256(ws)))) : p2wshScript(ref.sha256(ws)));
const msInput = (places, { m = 2, type = "p2wsh", amount = 100000, ws: over, sort = true } = {}) => {
  const { ws, keys } = msScript(places, m, sort), script = over || ws;
  return { kind: "p2wpkh", amount, noOrigin: true, script: coinScript(script, type), extra: [[IN.WITNESS_SCRIPT, [], script],
    ...(type === "p2sh-p2wsh" ? [[IN.REDEEM_SCRIPT, [], p2wshScript(ref.sha256(script))]] : []),
    ...keys.map((k) => [IN.BIP32_DERIVATION, k.pub, origin(k.fp, parsePath(k.path))])] };
};
const msOutput = (places, { m = 2, type = "p2wsh", amount = 40000, sort = true } = {}) => {
  const { ws, keys } = msScript(places, m, sort);
  return { script: coinScript(ws, type), amount, extra: [[OUT.WITNESS_SCRIPT, [], ws],
    ...(type === "p2sh-p2wsh" ? [[OUT.REDEEM_SCRIPT, [], p2wshScript(ref.sha256(ws))]] : []),
    ...keys.map((k) => [OUT.BIP32_DERIVATION, k.pub, origin(k.fp, parsePath(k.path))])] };
};
const WALLET = (at) => [[0, at], [1, at], [2, at]];
const SPEND = (o = {}) => ({ inputs: [msInput(WALLET("0/3"))], outputs: [EXTERNAL, msOutput(WALLET("1/3"))], globals: XPUBS, ...o });

// BIP-147 and OP_CHECKMULTISIG, written here from their definition: the
// witness a node would run.
function runsOnChain(p, tx, i) {
  const w = tx.inputs[i].witness, ws = w[w.length - 1];
  const { m, pubkeys } = parseMultisig(ws);
  if (w[0].length !== 0 || w.length !== m + 2) return false;
  const coin = p.inputs[i].fields.witnessUtxo;
  const inner = classify(coin.script).type === "p2sh" ? p.inputs[i].fields.redeemScript : coin.script;
  if (toHex(inner) !== "0020" + toHex(ref.sha256(ws))) return false;
  let k = 0;
  for (const sig of w.slice(1, -1)) {
    if (sig[sig.length - 1] !== 1) return false;
    const hash = segwitV0Sighash(tx, i, ws, coin.value, 1);
    while (k < pubkeys.length && !ref.ecdsaVerify(sig.subarray(0, sig.length - 1), hash, pubkeys[k])) k++;
    if (k++ >= pubkeys.length) return false;
  }
  return true;
}
const sigsOf = (p, i = 0) => p.inputs[i].fields.partialSigs;

check("multisig", "finalize's txid: SHA-256 twice of the transaction without its witness, reversed", () => {
  const r = signKeys(build(SPEND()), COSIGNERS.slice(0, 2), {});
  const { txid, tx } = finalize(r.psbt);
  const t = parseTx(tx), bare = serializeTx(t, { withWitness: false });
  eq(txid, toHex(ref.sha256(ref.sha256(bare)).reverse()));
  eq(txid, txidOf(r.psbt.tx)); // what the witness doesn't change
});
check("multisig", "BIP-143's P2SH-P2WSH 6-of-6, with SIGHASH_ALL", () => {
  const t = parseTx(fromHex("010000000136641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e0100000000ffffffff0200e9a435000000001976a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688acc0832f05000000001976a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac00000000"));
  const ws = fromHex("56210307b8ae49ac90a048e9b53357a2354b3334e9c8bee813ecb98e99a7e07e8c3ba32103b28f0c28bfab54554ae8c658ac5c3e0ce6e79ad336331f78c428dd43eea8449b21034b8113d703413d57761b8b9781957b8c0ac1dfe69f492580ca4195f50376ba4a21033400f6afecb833092a9a21cfdf1ed1376e58c5d1f47de74683123987e967a8f42103a6d48b1131e94ba04d9737d61acdaa1322008af9602b3b14862c07a1789aac162102d8b661b0b3302ee2f162b09e07a55ad5dfbe673a9f01d9f0c19617681024306b56ae");
  eq(toHex(segwitV0Sighash(t, 0, ws, 987654321, 1)), "185c0be5263dce5b4bb50a047973c1b6272bfbd0103a89444597dc40b248ee7c");
  eq(multisigScript(6, parseMultisig(ws).pubkeys), ws);
});
for (const type of ["p2wsh", "p2sh-p2wsh"]) {
  const spend = { inputs: [msInput(WALLET("0/3"), { type })], outputs: [EXTERNAL] };
  check("multisig", `${type}: one key of 2-of-3 signs, and says 1 of 2`, () => {
    const p = build(spend);
    const pl = planKeys(p, [abandon], {});
    eq([pl.inputs[0].sign, pl.inputs[0].multisig, pl.complete], [true, { m: 2, n: 3, have: 0, will: 1 }, false]);
    eq(pl.inputs[0].path, `${MS}/0/3`);
    const r = signKeys(p, [abandon], {});
    eq([r.signed.length, r.plan.inputs[0].multisig.have, r.plan.inputs[0].signed, r.plan.complete, r.plan.inputs[0].sign], [1, 1, false, false, false]);
    has(r.plan.inputs[0].reason, "1 of the 2");
    has(throws(() => finalize(r.psbt), SignError).message, "1 of the 2");
  });
  check("multisig", `${type}: two copies combined finalize to what a node would run`, () => {
    const p = build(spend);
    const a = signPsbt(p, COSIGNERS[0], {}).psbt, b = signPsbt(p, COSIGNERS[2], {}).psbt;
    const both = combine(a, b).psbt;
    eq(planKeys(both, [], {}).inputs[0].multisig.have, 2);
    eq(planKeys(both, [], {}).complete, true);
    const tx = parseTx(finalize(both).tx);
    if (!runsOnChain(both, tx, 0)) throw new Error("the witness doesn't run");
    eq(toHex(tx.inputs[0].scriptSig), type === "p2wsh" ? "" : "22" + toHex(p2wshScript(ref.sha256(both.inputs[0].fields.witnessScript))));
  });
  check("multisig", `${type}: two keys in one go are complete, a third adds nothing`, () => {
    const p = build(spend);
    const pl = planKeys(p, COSIGNERS.slice(0, 2), {});
    eq([pl.inputs[0].multisig.will, pl.complete], [2, true]);
    eq(planKeys(p, COSIGNERS, {}).inputs[0].multisig.will, 2);
    const r = signKeys(p, COSIGNERS, {});
    eq([sigsOf(r.psbt).length, r.plan.complete], [2, true]);
    if (!runsOnChain(r.psbt, parseTx(finalize(r.psbt).tx), 0)) throw new Error("the witness doesn't run");
  });
}
check("multisig", "exactly m signatures in the witness, in the script's order, whatever the PSBT holds", () => {
  const p = build({ inputs: [msInput(WALLET("0/3"))], outputs: [EXTERNAL] });
  const a = signPsbt(p, COSIGNERS[0], {}).psbt, b = signPsbt(p, COSIGNERS[1], {}).psbt, c = signPsbt(p, COSIGNERS[2], {}).psbt;
  for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
    const all = combine(combine(order[0], order[1]).psbt, order[2]).psbt;
    eq(sigsOf(all).length, 3);
    const tx = parseTx(finalize(all).tx);
    eq(tx.inputs[0].witness.length, 4);
    if (!runsOnChain(all, tx, 0)) throw new Error("the witness doesn't run");
  }
});
const flip = (s) => {
  const b = s.slice();
  b[10] ^= 1;
  return b;
};
const msWithSig = (p, pubkey, signature) => {
  const q = parsePsbt(serializePsbt(p));
  setEntry(q.inputs[0], IN.PARTIAL_SIG, pubkey, signature);
  return parsePsbt(serializePsbt(q));
};
check("multisig", "a bad signature doesn't count, is flagged, and doesn't reach the witness", () => {
  const p = build({ inputs: [msInput(WALLET("0/3"))], outputs: [EXTERNAL] });
  const a = signPsbt(p, COSIGNERS[0], {}).psbt, s = sigsOf(a)[0];
  const bad = msWithSig(p, s.pubkey, flip(s.signature));
  const pl = planKeys(bad, [COSIGNERS[1]], {});
  eq([pl.inputs[0].badSignature, pl.inputs[0].multisig.have, pl.complete], [true, 0, false]);
  has(throws(() => finalize(bad), SignError).message, "0 of the 2");
  const signedBy = signPsbt(bad, COSIGNERS[1], {}).psbt;
  has(throws(() => finalize(signedBy), SignError).message, "1 of the 2");
  // with two good ones besides, the bad one is left out
  const good = signPsbt(signedBy, COSIGNERS[2], {}).psbt;
  const tx = parseTx(finalize(good).tx);
  if (!runsOnChain(good, tx, 0)) throw new Error("the witness doesn't run");
});
check("multisig", "a signature by a key outside the script doesn't count", () => {
  const p = build({ inputs: [msInput(WALLET("0/3"))], outputs: [EXTERNAL] });
  const s = sigsOf(signPsbt(p, COSIGNERS[0], {}).psbt)[0];
  const q = msWithSig(p, derive(abandon, "m/1").publicKey, s.signature);
  eq(planKeys(q, [], {}).inputs[0].multisig.have, 0);
});
check("multisig", "SIGHASH other than ALL: refused to sign, and a cosigner's doesn't count", () => {
  const i = msInput(WALLET("0/3"));
  i.sighash = 2;
  has(reasonOf(build({ inputs: [i], outputs: [EXTERNAL] })), "only ALL");
  const p = build({ inputs: [msInput(WALLET("0/3"))], outputs: [EXTERNAL] });
  const s = sigsOf(signPsbt(p, COSIGNERS[0], {}).psbt)[0];
  const none = msWithSig(p, s.pubkey, concat([s.signature.subarray(0, s.signature.length - 1), [2]]));
  eq([planKeys(none, [], {}).inputs[0].multisig.have, planKeys(none, [], {}).inputs[0].badSignature], [0, true]);
});
check("multisig", "inputs in different states show each their own", () => {
  const p = build({ inputs: [msInput(WALLET("0/3")), msInput(WALLET("0/4"), { m: 1 })], outputs: [EXTERNAL] });
  const first = signPsbt(p, COSIGNERS[1], {}).psbt;
  eq(planKeys(first, [abandon], {}).inputs.map((i) => [i.multisig.m, i.multisig.have, i.multisig.will, i.signed, i.sign]),
    [[2, 1, 1, false, true], [1, 1, 0, true, false]]);
});
check("multisig", "one seed twice in a script gives both signatures", () => {
  const p = build({ inputs: [msInput([[0, "0/3"], [0, "1/3"], [1, "0/3"]])], outputs: [EXTERNAL] });
  const r = signKeys(p, [abandon], {});
  eq([sigsOf(r.psbt).length, r.plan.complete], [2, true]);
  if (!runsOnChain(r.psbt, parseTx(finalize(r.psbt).tx), 0)) throw new Error("the witness doesn't run");
});
check("multisig", "a WIF and an account xprv find their key", () => {
  const p = build({ inputs: [msInput(WALLET("0/3"))], outputs: [EXTERNAL] });
  const k = derive(abandon, `${MS}/0/3`);
  eq(planKeys(p, [{ single: true, privateKey: k.privateKey, publicKey: k.publicKey }], {}).inputs[0].sign, true);
  eq(planKeys(p, [derive(abandon, MS)], {}).inputs[0].path, "key/0/3");
  const own = build({ inputs: [msInput([[0, "0/3", { fp: fingerprint(derive(abandon, MS)), path: "m/0/3" }], [1, "0/3"], [2, "0/3"]])], outputs: [EXTERNAL] });
  eq(planKeys(own, [abandon], {}).inputs[0].sign, true); // the account's own fingerprint, as Electrum names a key from an xpub
});
check("multisig", "someone else's: says so; our fingerprint with another key: says so", () => {
  has(reasonOf(build({ inputs: [msInput([[1, "0/3"], [2, "0/3"]], { m: 1 })], outputs: [EXTERNAL] })), "another wallet");
  const liar = msInput([[0, "0/3", { pub: msPub(1, "0/9") }], [1, "0/3"], [2, "0/3"]]);
  has(reasonOf(build({ inputs: [liar], outputs: [EXTERNAL] })), "not the one the PSBT names");
  const none = msInput(WALLET("0/3"));
  none.extra = none.extra.filter((e) => e[0] !== IN.BIP32_DERIVATION);
  has(reasonOf(build({ inputs: [none], outputs: [EXTERNAL] })), "names no key");
});
const refused = (input) => reasonOf(build({ inputs: [input], outputs: [EXTERNAL] }));
check("multisig", "scripts refused", () => {
  const good = msScript(WALLET("0/3")).ws;
  const other = msInput(WALLET("0/3"));
  other.script = coinScript(msScript(WALLET("0/4")).ws, "p2wsh");
  has(refused(other), "not the one the script commits to");
  const nothing = msInput(WALLET("0/3"));
  nothing.extra = nothing.extra.filter((e) => e[0] !== IN.WITNESS_SCRIPT);
  has(refused(nothing), "without its witnessScript");
  const wrongRedeem = msInput(WALLET("0/3"), { type: "p2sh-p2wsh" });
  wrongRedeem.extra = wrongRedeem.extra.map((e) => (e[0] === IN.REDEEM_SCRIPT ? [e[0], e[1], p2wshScript(new Uint8Array(32))] : e));
  has(refused(wrongRedeem), "redeemScript");
  const K = msPub(0, "0/3"), U = ref.publicKeyConvert(K, false);
  const script = (s) => msInput(WALLET("0/3"), { ws: s });
  has(refused(script(concat([[0x51, 65], U, [0x51, 0xae]]))), "uncompressed");
  has(refused(script(multisigScript(1, [K, K]))), "same key twice");
  has(refused(script(multisigScript(2, [K, msPub(1, "0/3"), K]))), "same key twice");
  has(refused(script(concat([[0x51, 0x4c, 33], K, [0x51, 0xae]]))), "the usual way");
  has(refused(script(concat([[33], K, [0xad, 0x51, 0xb2]]))), "plain m-of-n");
  has(refused(script(concat([[0x02, 0x90, 0x01, 0xb1, 0x75], good]))), "plain m-of-n");
  has(refused(script(concat([[0x50, 33], K, [0x51, 0xae]]))), "plain m-of-n");
  has(refused(script(concat([[0x52, 33], K, [0x51, 0xae]]))), "plain m-of-n");
});

const change = (o) => planKeys(build(SPEND(o)), [abandon], {}).outputs[1];
const msReview = (o, keys = [abandon]) => reviewed(build(SPEND(o)), keys);
const red = (o, says) => {
  const a = msReview(o), w = a.outputs[1];
  eq([w.mine, a.toSelf, a.sent], [false, 0, a.totalOut]);
  const x = a.warnings.find((y) => y.text.startsWith("Output 2"));
  has(x.text, says);
  eq(x.level, "danger");
  has(x.text, "not the wallet the inputs are");
};
const amber = (o, says) => {
  const a = msReview(o), w = a.outputs[1];
  eq([w.mine, w.unverified, a.toSelf], [false, true, 0]);
  eq(a.sent, a.totalOut);
  has(a.warnings.find((x) => x.text.startsWith("Output 2")).text, says);
  eq(a.warnings.find((x) => x.text.startsWith("Output 2")).level, "warn");
};
check("multisig", "change of the same wallet is proved: green, counted as change", () => {
  const o = change({});
  eq([o.ours, o.unproved, o.stray, o.far, o.role, o.type], [true, null, null, null, "change", "p2wsh"]);
  eq(o.path, `${MS}/1/3`);
  const a = msReview({});
  eq([a.outputs[1].mine, a.outputs[1].unverified, a.toSelf], [true, false, 40000]);
  eq(planKeys(build(SPEND()), COSIGNERS.slice(1, 2).concat(abandon), {}).outputs[1].ours, true);
});
check("multisig", "P2SH-P2WSH change of a P2SH-P2WSH wallet is proved, of a P2WSH one not", () => {
  const nested = { inputs: [msInput(WALLET("0/3"), { type: "p2sh-p2wsh" })], outputs: [EXTERNAL, msOutput(WALLET("1/3"), { type: "p2sh-p2wsh" })] };
  eq(change(nested).ours, true);
  has(change({ outputs: [EXTERNAL, msOutput(WALLET("1/3"), { type: "p2sh-p2wsh" })] }).problem, "P2SH-P2WSH");
  has(change({ ...nested, outputs: [EXTERNAL, msOutput(WALLET("1/3"))] }).problem, "P2WSH");
});
check("multisig", "attack: our key and two of its own", () => {
  const evil = fromSeed(new Uint8Array(32).fill(66)), pub = (n) => derive(evil, `m/${n}`).publicKey;
  const places = [[0, "1/3"], [1, "1/3", { pub: pub(1) }], [2, "1/3", { pub: pub(2) }]];
  red({ outputs: [EXTERNAL, msOutput(places)] }, "doesn't derive from the PSBT's xpubs");
});
check("multisig", "attack: the same, and its xpubs added", () => {
  const evil = fromSeed(new Uint8Array(32).fill(66));
  const x = (n) => {
    const node = neuter(derive(evil, `m/${n}'`));
    return { pub: derive(node, "m/1/3").publicKey, entry: [GLOBAL.XPUB, base58CheckDecode(serializeXpub(node, "tpub")), origin(fingerprint(evil), [HARDENED + n])], path: `m/${n}'/1/3` };
  };
  const a = x(1), b = x(2);
  const places = [[0, "1/3"], [1, "", { pub: a.pub, fp: fingerprint(evil), path: a.path }], [2, "", { pub: b.pub, fp: fingerprint(evil), path: b.path }]];
  red({ outputs: [EXTERNAL, msOutput(places)], globals: [...XPUBS, a.entry, b.entry] }, "not the inputs' cosigners");
});
check("multisig", "attack a: a dust coin of the attacker's wallet beside the real ones", () => {
  const evil = fromSeed(new Uint8Array(32).fill(66));
  const x = (n) => {
    const node = neuter(derive(evil, `m/${n}'`));
    return { pub: (at) => derive(node, "m/" + at).publicKey, entry: [GLOBAL.XPUB, base58CheckDecode(serializeXpub(node, "tpub")), origin(fingerprint(evil), [HARDENED + n])], path: (at) => `m/${n}'/${at}` };
  };
  const a = x(1), b = x(2), at = (s) => [[0, s], [1, s, { pub: a.pub(s), fp: fingerprint(evil), path: a.path(s) }], [2, s, { pub: b.pub(s), fp: fingerprint(evil), path: b.path(s) }]];
  const real = msInput(WALLET("0/3"));
  const globals = [XPUBS[0], XPUBS[1], XPUBS[2], a.entry, b.entry];
  // the change proved only against the dust input, the real coin beside it
  amber({ inputs: [real, msInput(at("0/0"), { amount: 546 })], outputs: [EXTERNAL, msOutput(at("1/3"))], globals }, "not the same wallet");
  amber({ inputs: [msInput(at("0/0"), { amount: 546 }), real], outputs: [EXTERNAL, msOutput(at("1/3"))], globals }, "not the same wallet");
  // ... and beside a single-key coin
  amber({ inputs: [msInput(at("0/0"), { amount: 546 }), { kind: "p2wpkh", amount: 90000 }], outputs: [EXTERNAL, msOutput(at("1/3"))], globals }, "not multisig");
  // and the real wallet's change, in a mix, stays amber too
  amber({ inputs: [real, msInput(at("0/0"), { amount: 546 })], outputs: [EXTERNAL, msOutput(WALLET("1/3"))], globals }, "not the same wallet");
});
check("multisig", "attack b: one cosigner's key twice", () => {
  red({ outputs: [EXTERNAL, msOutput([[0, "1/3"], [1, "1/5"], [1, "1/6"]])] }, "derive from one xpub");
  amber({ inputs: [msInput([[0, "0/3"], [1, "0/5"], [1, "0/6"]])] }, "derive from one xpub");
});
check("multisig", "attack c: keys at different paths are stray, and count as sent", () => {
  const o = change({ outputs: [EXTERNAL, msOutput([[0, "1/3"], [1, "1/4"], [2, "1/3"]])] });
  eq([o.ours, o.far], [true, null]);
  has(o.stray, "different paths");
  const a = msReview({ outputs: [EXTERNAL, msOutput([[0, "1/3"], [1, "0/3"], [2, "1/3"]])] });
  eq([a.outputs[1].mine, a.toSelf, a.sent], [false, 0, a.totalOut]);
  has(change({ outputs: [EXTERNAL, msOutput(WALLET("1/3/0"))] }).stray, "two steps");
});
// The security review's M3: same cosigners, m, n and path, but the keys in
// another order make another address, one the wallet never scans.
const keysSorted = (places) => {
  const ks = places.map(([c, at]) => msPub(c, at));
  return ks.every((k, i) => i === 0 || compare(ks[i - 1], k) < 0);
};
check("multisig", "attack d: sortedmulti change with its keys out of order is stray, and counts as sent", () => {
  const { ws } = msScript(WALLET("1/3"));
  const reversed = msOutput(WALLET("1/3"));
  const back = parseMultisig(ws).pubkeys.reverse();
  reversed.script = coinScript(multisigScript(2, back), "p2wsh");
  reversed.extra[0] = [OUT.WITNESS_SCRIPT, [], multisigScript(2, back)];
  const o = change({ outputs: [EXTERNAL, reversed] });
  eq([o.ours, o.problem, o.unproved], [true, null, null]);
  has(o.stray, "not sorted as the inputs' are");
  const a = msReview({ outputs: [EXTERNAL, reversed] });
  eq([a.outputs[1].mine, a.toSelf, a.sent], [false, 0, a.totalOut]);
  eq(change({}).stray, null); // sorted, as the inputs: at home
});
// Plain multi: a fixed order of cosigners. Found by trying: inputs whose keys
// are not sorted, so the order is the only rule.
const ORDERS = [[2, 0, 1], [1, 2, 0], [2, 1, 0], [1, 0, 2], [0, 2, 1]];
const inOrder = (order, at) => order.map((c) => [c, at]);
const plainWallet = ORDERS.find((o) => !keysSorted(inOrder(o, "0/3")) && !keysSorted(inOrder(o, "0/4")));
check("multisig", "plain multi: change in the inputs' order of cosigners is at home, in another stray", () => {
  const inputs = [msInput(inOrder(plainWallet, "0/3"), { sort: false }), msInput(inOrder(plainWallet, "0/4"), { sort: false, amount: 5000 })];
  const same = change({ inputs, outputs: [EXTERNAL, msOutput(inOrder(plainWallet, "1/3"), { sort: false })] });
  eq([same.ours, same.stray, same.unproved], [true, null, null]);
  const other = ORDERS.find((o) => o.join() !== plainWallet.join());
  const moved = change({ inputs, outputs: [EXTERNAL, msOutput(inOrder(other, "1/3"), { sort: false })] });
  eq([moved.ours, moved.unproved], [true, null]);
  has(moved.stray, "not in the inputs' order of cosigners");
  // sorted change of a plain multi wallet: stray too (unless sorted is its order there)
  if (!keysSorted(inOrder(plainWallet, "1/3"))) has(change({ inputs, outputs: [EXTERNAL, msOutput(inOrder(plainWallet, "1/3"))] }).stray, "order of cosigners");
  else throw new Error("pick another index: the order is sorted at 1/3");
});
check("multisig", "inputs neither sorted nor in one order are no wallet's: change unproved", () => {
  const second = ORDERS.find((o) => o.join() !== plainWallet.join() && !keysSorted(inOrder(o, "0/4")));
  const inputs = [msInput(inOrder(plainWallet, "0/3"), { sort: false }), msInput(inOrder(second, "0/4"), { sort: false, amount: 5000 })];
  const o = change({ inputs, outputs: [EXTERNAL, msOutput(inOrder(plainWallet, "1/3"), { sort: false })] });
  eq(o.ours, false);
  has(o.unproved, "neither sorted (sortedmulti) nor in one order of cosigners");
});
check("multisig", "attack: an xpub that is the input key itself, change hidden below it", () => {
  const globals = [0, 1, 2].map((c) => xpubEntry(c, { path: `${MS}/0/3` }));
  const o = change({ outputs: [EXTERNAL, msOutput(WALLET("0/3/1/7"))], globals });
  eq(o.ours, false);
  has(o.unproved, "two steps");
});
check("multisig", "attack: an xpub one step below the account, change hidden below it", () => {
  const globals = [0, 1, 2].map((c) => xpubEntry(c, { path: `${MS}/0` }));
  const o = change({ outputs: [EXTERNAL, msOutput(WALLET("0/1/7"))], globals });
  eq(o.ours, false);
  has(o.unproved, "two steps");
});
check("multisig", "an input's keys at different suffixes prove nothing", () => {
  const o = change({ inputs: [msInput([[0, "0/3"], [1, "0/4"], [2, "0/3"]])] });
  eq(o.ours, false);
  has(o.unproved, "different paths");
});
check("multisig", "m and n exactly", () => {
  red({ outputs: [EXTERNAL, msOutput(WALLET("1/3"), { m: 1 })] }, "it is 1 of 3, and the inputs 2 of 3");
  red({ outputs: [EXTERNAL, msOutput(WALLET("1/3"), { m: 3 })] }, "it is 3 of 3, and the inputs 2 of 3");
  red({ outputs: [EXTERNAL, msOutput([[0, "1/3"], [1, "1/3"]])] }, "it is 2 of 2, and the inputs 2 of 3");
});
check("multisig", "far and stray go by the shared index", () => {
  const high = { inputs: [msInput(WALLET("0/40"))] };
  eq(change({ ...high, outputs: [EXTERNAL, msOutput(WALLET("1/60"))] }).far, null);
  eq(change({ ...high, outputs: [EXTERNAL, msOutput(WALLET("1/61"))] }).far, 61);
  has(change({ ...high, outputs: [EXTERNAL, msOutput(WALLET("1/1041"))] }).stray, "over 1040");
});
check("multisig", "a hardened relative path can't be proved", () => {
  const o = change({ outputs: [EXTERNAL, msOutput([[0, "1/3'"], [1, "1/3'"], [2, "1/3'"]])] });
  has(o.problem, "doesn't derive");
});
check("multisig", "xpubs: extras ignored; a wrong fingerprint or path prefix fails", () => {
  const extra = xpubEntry(1, { path: "m/48'/1'/7'/2'" });
  eq(change({ globals: [extra, ...XPUBS] }).ours, true);
  has(change({ globals: [xpubEntry(0, { fp: "01020304" }), XPUBS[1], XPUBS[2]] }).unproved, "doesn't derive");
  const rawOf = (e, path) => [e[0], e[1], origin(fingerprint(COSIGNERS[1]), parsePath(path))];
  has(change({ globals: [XPUBS[0], rawOf(XPUBS[1], "m/48'/1'/1'/2'"), XPUBS[2]] }).unproved, "doesn't derive");
  has(change({ globals: XPUBS.slice(0, 2) }).unproved, "doesn't derive");
  has(change({ globals: [XPUBS[0], xpubEntry(1, { path: "m/48'/1'/7'/2'" }), XPUBS[2]] }).unproved, "doesn't derive");
});
check("multisig", "no xpubs: amber, with what to tick in Electrum", () => {
  amber({ globals: [] }, "For hardware device; include xpubs");
  const a = msReview({ globals: [XPUBS[0], XPUBS[1]] });
  if (a.warnings.some((w) => w.text.includes("include xpubs"))) throw new Error("the hint is for no xpubs at all");
});
check("multisig", "a public key in the xpub's place, or a broken one, is skipped", () => {
  const broken = [GLOBAL.XPUB, XPUBS[1][1].slice(), XPUBS[1][2]];
  broken[1][45] = 0;
  has(change({ globals: [XPUBS[0], broken, XPUBS[2]] }).unproved, "doesn't derive");
});
check("multisig", "many derivations asked: not proved, and it stops", () => {
  const inputs = Array.from({ length: 300 }, (_, i) => msInput(WALLET(`0/${i}`), { amount: 1000 }));
  has(change({ inputs }).unproved, "too many keys");
  // the inputs just fit: the limit is reached at the change, and that is no refutation
  const o = change({ inputs: inputs.slice(0, 84) });
  has(o.unproved, "too many keys");
  eq(o.problem, null);
  eq(change({ inputs: inputs.slice(0, 80) }).ours, true);
});
check("multisig", "a key's unsupported script as change is not proved", () => {
  const out = msOutput(WALLET("1/3"));
  out.extra = out.extra.map((e) => (e[0] === OUT.WITNESS_SCRIPT ? [e[0], e[1], msScript(WALLET("1/4")).ws] : e));
  has(change({ outputs: [EXTERNAL, out] }).problem, "not the one the script commits to");
});
check("multisig", "our key not in the script, though named: it pays someone else", () => {
  const out = msOutput([[1, "1/3"], [2, "1/3"]], { m: 1 });
  out.extra.push([OUT.BIP32_DERIVATION, msPub(0, "1/3"), origin(ABANDON_FP, parsePath(`${MS}/1/3`))]);
  has(change({ outputs: [EXTERNAL, out] }).problem, "doesn't pay to that key");
});
check("multisig", "BIP-48's paths aren't odd; a wrong purpose is", () => {
  eq(planKeys(build(SPEND()), [abandon], { network: "testnet" }).inputs[0].oddities, []);
  has(plan(build({ inputs: [msInput([[0, "", { path: "m/84'/1'/0'/0/3", pub: derive(abandon, "m/84'/1'/0'/0/3").publicKey }], [1, "0/3"], [2, "0/3"]])], outputs: [EXTERNAL] }),
    abandon, { network: "testnet" }).inputs[0].oddities.join(" "), "not the usual 48'");
});
check("multisig", "Electrum's 2-of-3, as its QR code carries it: signed, and its change unproved for want of xpubs", () => {
  const c = PSBT_V.electrum_made.made.find((x) => x.name === "testnet-2of3-p2wsh");
  const p = parsePsbt(readPayload(c.qr).bytes);
  const pl = planKeys(p, [abandon], { network: "testnet" });
  eq([pl.inputs[0].sign, pl.inputs[0].multisig.m, pl.inputs[0].multisig.n, pl.complete], [true, 2, 3, false]);
  const claimed = pl.outputs.filter((o) => o.unproved);
  claimed.forEach((o) => eq([o.ours, o.noXpubs], [false, true]));
  const r = signKeys(p, [abandon], { network: "testnet" });
  eq([r.signed.length, r.plan.inputs[0].multisig.have], [1, 1]);
});
// The same transaction as Electrum's desktop exports it with "For hardware
// device; include xpubs" ticked (tests/psbt/make_electrum_psbts.py): the
// global xpubs prove the change, and two cosigners finish it to Electrum's
// own txid. The other cosigners are BIP-39's public test phrases.
check("multisig", "Electrum's 2-of-3 with its xpubs: change proved, signed by two cosigners to Electrum's txid", () => {
  const c = PSBT_V.electrum_made.made.find((x) => x.name === "testnet-2of3-p2wsh-xpubs");
  const p = parsePsbt(readPayload(c.qr).bytes);
  eq(p.global.fields.xpubs.length, 3, "global xpubs");
  const options = { network: "testnet" };
  const pl = planKeys(p, [abandon], options);
  eq([pl.inputs[0].sign, pl.inputs[0].multisig.m, pl.inputs[0].multisig.n, pl.complete], [true, 2, 3, false]);
  const ci = c.outputs.findIndex((o) => o.change), ei = c.outputs.findIndex((o) => !o.change);
  const ch = pl.outputs[ci];
  eq([ch.ours, ch.role, ch.unproved ?? null, ch.problem, ch.stray, ch.far, ch.noXpubs ?? false],
    [true, "change", null, null, null, null, false], "the change, proved");
  eq(pl.outputs[ei].ours, false, "the payment is not ours");
  // the review says so: change back to the wallet, the payment sent, no warning about either
  const a = applyPlan(analyze(p, options), pl);
  eq([a.toSelf, a.sent, a.fee], [c.outputs[ci].value, c.outputs[ei].value, c.fee], "totals");
  const about = a.warnings.filter((w) => /^Output \d/.test(String(w.text)));
  eq(about.map((w) => String(w.text)), [], "warnings about the outputs");
  // signed by this key, its signature good; then a second cosigner completes it
  const one = signKeys(p, [abandon], options);
  eq([one.signed.length, one.plan.inputs[0].multisig.have, one.plan.complete], [1, 1, false]);
  const sig = one.psbt.inputs[0].fields.partialSigs;
  eq(sig.length, 1, "one signature");
  eq(partialSigGood(one.psbt, 0, sig[0].pubkey, sig[0].signature), true, "it verifies");
  for (const words of ["legal winner thank year wave sausage worth useful legal winner thank yellow",
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"]) {
    const other = fromSeed(seedFromMnemonic(words));
    const two = signKeys(one.psbt, [other], options);
    eq([two.signed.length, two.plan.complete], [1, true], "the second cosigner");
    eq(finalize(two.psbt).txid, c.txid, "Electrum's txid");
  }
  return true;
});
check("descriptor", "BIP-48: the cosigner's key expression, and Electrum's Zpub", () => {
  const xpub = serializeXpub(neuter(derive(abandon, "m/48'/0'/0'/2'")), "xpub");
  eq(cosignerKey({ fingerprint: ABANDON_FP, network: "mainnet", account: 0, xpub }), `[${ABANDON_FP}/48h/0h/0h/2h]${xpub}`);
  throws(() => cosignerKey({ fingerprint: ABANDON_FP, network: "testnet", account: 0, xpub }), RangeError);
  eq(versionFor("p2wsh", "mainnet"), "Zpub");
  eq(versionFor("p2wsh", "testnet"), "Vpub");
  const z = serializeXpub(neuter(derive(abandon, "m/48'/0'/0'/2'")), "Zpub");
  eq([z[0], parseXpub(z).script, parseXpub(z).network], ["Z", "p2wsh", "mainnet"]);
  eq(serializeXpub(parseXpub(z).node), xpub);
});

if (madeOut) {
  const qr = (p) => electrumQrText(serializePsbt(p));
  const hashOf = (bytes) => toHex(ref.sha256(bytes).subarray(0, 8));
  const legacyBig = build({ inputs: Array.from({ length: 6 }, (_, i) => ({ kind: "p2pkh", path: `m/44'/1'/0'/0/${i}`, amount: 30000, prevOutputs: 60 })),
    outputs: [{ ...EXTERNAL, amount: 139000 }, { kind: "p2pkh", path: "m/44'/1'/0'/1/0", amount: 40000 }] });
  const FEE_OK = (o) => ({ inputs: [{ kind: "p2wpkh", amount: 100000 }, { kind: "p2wpkh", amount: 20000 }],
    outputs: [{ ...EXTERNAL, amount: 80000 }, { kind: "p2wpkh", amount: 39000, ...o }] });
  const attacker = derive(fromSeed(new Uint8Array(32).fill(9)), "m/84'/1'/0'/1/0").publicKey;
  const plain = build(FEE_OK({ path: "m/84'/1'/0'/1/0" }));
  const msSpend = (globals) => build({ inputs: [msInput(WALLET("0/3"))], outputs: [{ ...EXTERNAL, amount: 59000 }, msOutput(WALLET("1/3"))], globals });
  const msHalf = signPsbt(msSpend(XPUBS), COSIGNERS[1], {}).psbt;
  const parts = (p) => split(serializePsbt(p), "P", { maxVersion: 12, maxParts: 60, encoding: "2" }).parts; // QEMU's test camera takes under 1024 characters
  writeFileSync(madeOut, JSON.stringify({
    msHalf: parts(msHalf),
    msHash: hashOf(finalize(signKeys(msHalf, [abandon], {}).psbt).tx),
    msTxid: finalize(signKeys(msHalf, [abandon], {}).psbt).txid,
    legacyTxid: finalize(signPsbt(legacyBig, abandon, ZERO_AUX).psbt).txid,
    msNoXpubs: parts(msSpend([])),
    msRefuted: parts(build({ inputs: [msInput(WALLET("0/3"))], outputs: [{ ...EXTERNAL, amount: 59000 }, msOutput(WALLET("1/3"), { m: 1 })], globals: XPUBS })),
    plain: qr(plain),
    stray: qr(build(FEE_OK({ path: "m/84'/1'/7'/1/500000" }))),
    far: qr(build(FEE_OK({ path: "m/84'/1'/0'/1/900" }))),
    otherWallet: qr(build({ ...FEE_OK({ path: "m/84'/1'/0'/1/0", fp: "01020304" }), inputs: FEE_OK({}).inputs.map((i) => ({ ...i, fp: "01020304" })) })),
    refuted: qr(build(FEE_OK({ path: "m/84'/1'/0'/1/0", pubkey: attacker, script: p2wpkhScript(hash160(attacker)) }))),
    half0: qr(halfSigned(plain, "m/84'/1'/0'/0/0")),
    half1: qr(halfSigned(plain, "m/84'/1'/0'/0/1")),
    other: qr(build(FEE_OK({ path: "m/84'/1'/0'/1/1" }))),
    // coins of its own: the memory of what was signed would see the others' told with other amounts
    big: split(serializePsbt(build({ inputs: Array.from({ length: 30 }, (_, i) => ({ kind: "p2wpkh", path: `m/84'/1'/0'/0/${i}`, amount: 10000 })),
      outputs: [{ ...EXTERNAL, amount: 290000 }, { ...CHANGE, path: "m/84'/1'/0'/1/0", amount: 9000 }], salt: "big " })), "P", { maxVersion: 12, maxParts: 20, encoding: "2" }).parts,
    // plain's coins, told with each other's amounts: the fee attack's second round
    swapped: qr(build({ inputs: [{ kind: "p2wpkh", amount: 20000 }, { kind: "p2wpkh", amount: 100000 }],
      outputs: [{ ...EXTERNAL, amount: 80000 }, { kind: "p2wpkh", path: "m/84'/1'/0'/1/0", amount: 39000 }] })),
    legacy: split(serializePsbt(legacyBig), "P", { maxVersion: 12, maxParts: 60, encoding: "2" }).parts,
    legacyHash: hashOf(finalize(signPsbt(legacyBig, abandon, ZERO_AUX).psbt).tx),
    uncompressedPsbt: qr(spending("p2pkh", p2pkhScript(hash65(LEGACY)), { noOrigin: true })),
    uncompressedWif: base58CheckEncode(concat([[0xef], secretOf(LEGACY).privateKey])),
    uncompressedHash: hashOf(finalize(signPsbt(spending("p2pkh", p2pkhScript(hash65(LEGACY)), { noOrigin: true }), uncompressed(LEGACY), ZERO_AUX).psbt).tx),
    otherSeries: split(new TextEncoder().encode("not a transaction"), "U", { encoding: "2", minVersion: 20 }).parts[0],
    finished: electrumQrText(finalize(signPsbt(plain, abandon, ZERO_AUX).psbt).tx),
    finishedTxid: finalize(signPsbt(plain, abandon, ZERO_AUX).psbt).txid,
    xprv: privBase58(abandon, XPRV),
    accountTprv: privBase58(derive(abandon, ACCOUNT), TPRV),
    account1: qr(build({ inputs: [{ kind: "p2wpkh", path: "m/84'/1'/1'/0/0", amount: 100000, fp: fingerprint(derive(abandon, "m/84'/1'/1'")).slice(), claimPath: "m/0/0" }],
      outputs: [{ ...EXTERNAL, amount: 99000 }] })),
    wif0: wifOf(derive(abandon, "m/84'/1'/0'/0/0"), 0xef),
    wif1: wifOf(derive(abandon, "m/84'/1'/0'/0/1"), 0xef),
  }, null, 1) + "\n");
  console.log("wrote", madeOut);
}

if (electrumOut) {
  writeFileSync(electrumOut, JSON.stringify(signedForElectrum, null, 1) + "\n");
  console.log("wrote", electrumOut);
}

// --- summary --------------------------------------------------------------------------

let total = 0, failed = 0;
for (const [g, c] of Object.entries(counts)) {
  total += c.passed + c.failed;
  failed += c.failed;
  console.log(`${g.padEnd(10)} ${c.passed} passed${c.failed ? `, ${c.failed} FAILED` : ""}`);
}
for (const f of failures) console.log("FAIL", f);
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
