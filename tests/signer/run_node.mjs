// Tests apps/signer/lib (BIP-39, BIP-32, sighashes, signing PSBTs) under
// Node, with tests/signer/crypto_ref.mjs in place of zg:crypto, against
// tests/signer/vectors.json, tests/signer/electrum.json and BIP-174's
// vectors in tests/psbt/vectors.json (sources: tests/signer/README.md):
//
//   node --experimental-default-type=module tests/signer/run_node.mjs [-v]
//        [--electrum-out FILE]   (writes what we signed, for make_electrum_vectors.py --check)
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import * as ref from "./crypto_ref.mjs";
import { setCrypto, taggedHash, hash160 } from "../../apps/signer/lib/crypto.js";
import { mnemonicFromEntropy, entropyFromMnemonic, seedFromMnemonic, Bip39Error } from "../../apps/signer/lib/bip39.js";
import {
  fromSeed, derive, deriveChild, parsePath, formatPath, neuter, fingerprint, serializeXpub, parseXpub, decodeExtendedKey,
  wipe, VERSIONS, versionFor, Bip32Error, HARDENED,
} from "../../apps/signer/lib/bip32.js";
import { legacySighash, segwitV0Sighash, taprootSighash, taprootSigMsg, p2wpkhScriptCode } from "../../apps/signer/lib/sighash.js";
import { plan, signPsbt, verifyChange, finalize, planKeys, signKeys, SignError, CHANGE_NEAR, CHANGE_GAP } from "../../apps/signer/lib/sign.js";
import { parsePrivateKey, parseWif, KeyError } from "../../apps/signer/lib/keys.js";
import { combine, CombineError } from "../../apps/signer/lib/combine.js";
import { applyPlan } from "../../apps/signer/lib/review.js";
import { analyze } from "../../apps/signer/lib/psbt/analyze.js";
import { base58CheckEncode } from "../../apps/signer/lib/psbt/basen.js";
import { CodeReader, seriesFor } from "../../apps/signer/lib/codes.js";
import { split, deflateRaw, toBase32, Joiner } from "../../lib/js/bbqr.js";
import { accountDescriptor, descriptorChecksum, checkDescriptor } from "../../apps/signer/lib/descriptor.js";
import { selfTest } from "../../apps/signer/lib/selftest.js";
import { fromHex, toHex, equal, concat, Writer, fromBase64, DecodeError } from "../../apps/signer/lib/psbt/bytes.js";
import { parseTx, serializeTx, txid as txidOf } from "../../apps/signer/lib/psbt/tx.js";
import { parsePsbt, serializePsbt, setEntry, IN, OUT, MAGIC } from "../../apps/signer/lib/psbt/psbt.js";
import { readPayload, electrumQrText } from "../../apps/signer/lib/psbt/transport.js";
import { scriptToAddress, p2wpkhScript, p2shScript, p2pkhScript } from "../../apps/signer/lib/psbt/script.js";

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
  check("bip174", "signPsbt leaves multisig alone, saying why", () => {
    const r = signPsbt(updated, master, {});
    eq(r.signed.length, 0);
    for (const s of r.skipped) has(s.reason, "not supported");
    return equal(serializePsbt(r.psbt), serializePsbt(updated));
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
//              noOrigin?: true, prevOutputs? (more outputs in a P2PKH coin's previous transaction) }]
//   outputs: [{ kind, path, amount, fp?, pubkey?, script? } | { script, amount }]
function build({ inputs, outputs, master = abandon, version = 2, locktime = 0 }) {
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
    let txid = sha("coin " + i), vout = i;
    if (x.kind === "p2pkh") {
      const prev = { version: 2, inputs: [{ txid: sha("from " + i), vout: 0, scriptSig: new Uint8Array(0), sequence: 0, witness: [] }],
        outputs: [{ value: 1, script: p2pkhScript(new Uint8Array(20)) }, { value: x.amount, script },
          ...Array.from({ length: x.prevOutputs || 0 }, (_, n) => ({ value: 1000 + n, script: p2pkhScript(new Uint8Array(20).fill(n & 255)) }))], locktime: 0 };
      vout = 1;
      txid = fromHex(txidOf(prev)).reverse();
      if (x.utxo !== false) entries.push([IN.NON_WITNESS_UTXO, [], serializeTx(prev)]);
    } else if (x.utxo !== false) {
      entries.push([IN.WITNESS_UTXO, [], txOut(x.amount, script)]);
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
    outs.push({ value: o.amount, script });
    outMaps.push(entries);
  }
  const tx = { version, inputs: ins, outputs: outs, locktime, segwit: false };
  const w = new Writer(1024);
  w.bytes(MAGIC);
  writeMap(w, [[0, [], serializeTx(tx, { withWitness: false })]]);
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
check("negative", "multisig P2WSH is not signed", () => {
  const ms = concat([[0x51, 33], derive(abandon, "m/48'/1'/0'/2'/0/0").publicKey, [0x51, 0xae]]);
  return has(reasonOf(one({ kind: "p2wpkh", amount: 1000, script: concat([[0, 32], sha(ms)]) })), "only single-key");
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
  eq([pl.signable, pl.complete, pl.outputs[1].ours, pl.outputs[1].path, pl.outputs[1].role], [2, true, true, "m/84'/1'/0'/1/0", "change"]);
  eq(serialize(signPsbt(p, acct, ZERO_AUX).psbt), serialize(signPsbt(p, abandon, ZERO_AUX).psbt));
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

check("rules", "segwit v0 with only WITNESS_UTXO signs, and two inputs get the note on amounts", () => {
  const p = build(TWO);
  if (p.inputs.some((m) => !m.fields.witnessUtxo || m.fields.nonWitnessUtxo)) throw new Error("not the case under test");
  const pl = plan(p, abandon, ZERO_AUX);
  eq([pl.signable, pl.complete], [2, true]);
  eq(parseTx(finalize(signPsbt(p, abandon, ZERO_AUX).psbt).tx).inputs.map((i) => i.witness.length), [2, 2]);
  const a = reviewed(p, [abandon]);
  eq(a.warnings.filter((w) => w.level === "info" && w.text.startsWith("Inputs 1, 2: amounts as the PSBT states them")).length, 1);
});
check("rules", "with one input there is no second signature to play against: no note", () => {
  const a = reviewed(build({ inputs: [TWO.inputs[0]], outputs: oneOut }), [abandon]);
  eq(a.warnings.filter((w) => w.text.includes("amounts as the PSBT")), []);
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
  has(throws(() => r.read(other), DecodeError).message, "another series");
  eq(r.started, true);
  eq(toHex(readAll(r, parts).payload.bytes), toHex(BIG));
  r.read(parts[0]);
  r.reset();
  eq(r.read(other).payload.kind, "tx");
});
check("codes", "other files are refused, saying what they are", () => {
  const u = split(new TextEncoder().encode("hello"), "U", { encoding: "2", minVersion: 20 }).parts[0];
  return has(throws(() => new CodeReader().read(u), DecodeError).message, "text");
});
check("codes", "a series that says PSBT and isn't one", () => {
  const u = split(new Uint8Array(40).fill(7), "P", { encoding: "2", minVersion: 20 }).parts[0];
  return has(throws(() => new CodeReader().read(u), DecodeError).message, "isn't one");
});
check("codes", "a damaged deflate stream is refused, and the reader is free again", () => {
  const z = "B$ZP0100" + toBase32(new Uint8Array(16).fill(0xff));
  const r = new CodeReader();
  has(throws(() => r.read(z), DecodeError).message, "don't make a file");
  return !r.started;
});
check("codes", "a deflate bomb stops at the limit", () => {
  const big = new Uint8Array(3 << 20);
  const text = "B$ZP0100" + toBase32(deflateRaw(big));
  return has(throws(() => new CodeReader().read(text), DecodeError).message, "don't make a file");
});
check("codes", "two contents for one part are refused", () => {
  const { parts } = split(BIG, "P", { encoding: "2", maxVersion: 8, maxParts: 20 });
  const r = new CodeReader();
  r.read(parts[0]);
  const bad = parts[0].slice(0, -8) + "AAAAAAAA";
  return has(throws(() => r.read(bad), DecodeError).message, "can't be used");
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
  throws(() => new CodeReader().read("B$ZP!!!!"), DecodeError));

// The codes tests/signer.txt shows the camera (tests/signer/make_scenario.py)
if (madeOut) {
  const qr = (p) => electrumQrText(serializePsbt(p));
  const hashOf = (bytes) => toHex(ref.sha256(bytes).subarray(0, 8));
  const legacyBig = build({ inputs: Array.from({ length: 6 }, (_, i) => ({ kind: "p2pkh", path: `m/44'/1'/0'/0/${i}`, amount: 30000, prevOutputs: 60 })),
    outputs: [{ ...EXTERNAL, amount: 139000 }, { kind: "p2pkh", path: "m/44'/1'/0'/1/0", amount: 40000 }] });
  const FEE_OK = (o) => ({ inputs: [{ kind: "p2wpkh", amount: 100000 }, { kind: "p2wpkh", amount: 20000 }],
    outputs: [{ ...EXTERNAL, amount: 80000 }, { kind: "p2wpkh", amount: 39000, ...o }] });
  const attacker = derive(fromSeed(new Uint8Array(32).fill(9)), "m/84'/1'/0'/1/0").publicKey;
  const plain = build(FEE_OK({ path: "m/84'/1'/0'/1/0" }));
  writeFileSync(madeOut, JSON.stringify({
    plain: qr(plain),
    stray: qr(build(FEE_OK({ path: "m/84'/1'/7'/1/500000" }))),
    far: qr(build(FEE_OK({ path: "m/84'/1'/0'/1/900" }))),
    refuted: qr(build(FEE_OK({ path: "m/84'/1'/0'/1/0", pubkey: attacker, script: p2wpkhScript(hash160(attacker)) }))),
    half0: qr(halfSigned(plain, "m/84'/1'/0'/0/0")),
    half1: qr(halfSigned(plain, "m/84'/1'/0'/0/1")),
    other: qr(build(FEE_OK({ path: "m/84'/1'/0'/1/1" }))),
    big: split(serializePsbt(build({ inputs: Array.from({ length: 30 }, (_, i) => ({ kind: "p2wpkh", path: `m/84'/1'/0'/0/${i}`, amount: 10000 })),
      outputs: [{ ...EXTERNAL, amount: 290000 }, { ...CHANGE, path: "m/84'/1'/0'/1/0", amount: 9000 }] })), "P", { maxVersion: 12, maxParts: 20, encoding: "2" }).parts,
    legacy: split(serializePsbt(legacyBig), "P", { maxVersion: 12, maxParts: 60, encoding: "2" }).parts,
    legacyHash: hashOf(finalize(signPsbt(legacyBig, abandon, ZERO_AUX).psbt).tx),
    uncompressedPsbt: qr(spending("p2pkh", p2pkhScript(hash65(LEGACY)), { noOrigin: true })),
    uncompressedWif: base58CheckEncode(concat([[0xef], secretOf(LEGACY).privateKey])),
    uncompressedHash: hashOf(finalize(signPsbt(spending("p2pkh", p2pkhScript(hash65(LEGACY)), { noOrigin: true }), uncompressed(LEGACY), ZERO_AUX).psbt).tx),
    otherSeries: split(new TextEncoder().encode("not a transaction"), "U", { encoding: "2", minVersion: 20 }).parts[0],
    finished: electrumQrText(finalize(signPsbt(plain, abandon, ZERO_AUX).psbt).tx),
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
