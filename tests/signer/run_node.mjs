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
import { plan, signPsbt, verifyChange, finalize, SignError } from "../../apps/signer/lib/sign.js";
import { selfTest } from "../../apps/signer/lib/selftest.js";
import { fromHex, toHex, equal, concat, Writer, fromBase64 } from "../../apps/signer/lib/psbt/bytes.js";
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
//   inputs:  [{ kind, path, amount, fp?, pubkey?, script?, utxo?: false, sighash?, merkleRoot?, internalKey?, extra? }]
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
      const prev = { version: 2, inputs: [{ txid: sha("from"), vout: 0, scriptSig: new Uint8Array(0), sequence: 0, witness: [] }],
        outputs: [{ value: 1, script: p2pkhScript(new Uint8Array(20)) }, { value: x.amount, script }], locktime: 0 };
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
    } else {
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
check("negative", "not a master key", () => {
  throws(() => plan(one({ kind: "p2wpkh", amount: 1000 }), derive(abandon, "m/84'"), {}), SignError);
  return throws(() => plan(one({ kind: "p2wpkh", amount: 1000 }), neuter(abandon), {}), SignError);
});
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
check("electrum", "a hostile watch-only PSBT: right account fingerprint, wrong key", () => {
  const c = E.cases.find((x) => x.name === "mainnet-p2wpkh-watch-only");
  const psbt = parsePsbt(readPayload(c.qr).bytes);
  // claim the input key is at 0/7: derivation is checked, not trusted
  const d = psbt.inputs[0].fields.bip32[0];
  setEntry(psbt.inputs[0], IN.BIP32_DERIVATION, d.pubkey, origin(d.fingerprint, [0, 7]));
  return has(plan(parsePsbt(serializePsbt(psbt)), abandon, {}).inputs[0].reason, "m/84'/0'/0'/0/7");
});

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
