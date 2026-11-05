// A known-answer self-test of the signing path on the device: the same
// code as signing, over the crypto given (zg:crypto's libsecp256k1 on the
// Pi), against published vectors.
//
//   import * as crypto from "zg:crypto";
//   const r = selfTest(crypto);   // { ok, checks: [{ name, ok, ms }] }
//
// Calls setCrypto(crypto). About 0.2 s on a Pi Zero (the BIP-39 seed is
// most of it). The vectors are public test data, not secrets.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { setCrypto, cr, taggedHash, hash160 } from "./crypto.js";
import { fromSeed, derive, serializeXpub, wipe } from "./bip32.js";
import { seedFromMnemonic } from "./bip39.js";
import { segwitV0Sighash, taprootSighash, p2wpkhScriptCode } from "./sighash.js";
import { fromHex, toHex, concat } from "./psbt/bytes.js";
import { parseTx } from "./psbt/tx.js";

// BIP-32 test vector 1, its deepest chain.
const BIP32_TV1 = {
  seed: "000102030405060708090a0b0c0d0e0f",
  path: "m/0'/1/2'/2/1000000000",
  xpub: "xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy",
};

// BIP-84's test vector: "abandon ... about", m/84'/0'/0'/0/0.
const BIP84 = {
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  path: "m/84'/0'/0'/0/0",
  pubkey: "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c",
};

// BIP-143's P2SH-P2WPKH example.
const BIP143 = {
  tx: "0100000001db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a54770100000000feffffff02b8b4eb0b000000001976a9" +
    "14a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac92040000",
  key: "eb696a065ef48a2192da5b28b694f87544b30fae8327c4510137a922f32c6dcf",
  amount: 1000000000,
  sighash: "64f3b0f4dd2bb3aa1ce8566d220cc74dda9df97d8490cc81d89d735c92e59fb6",
  signature: "3044022047ac8e878352d3ebbde1c94ce3a10d057c24175747116f8288e5d794d12d482f0220217f36a485cae903c713331d877c1f64677e3622" +
    "ad4010726870540656fe9dcb",
};

// BIP-341's wallet test vectors, keyPathSpending, input 4 (SIGHASH_DEFAULT).
const BIP341 = {
  tx: "02000000097de20cbff686da83a54981d2b9bab3586f4ca7e48f57f5b55963115f3b334e9c010000000000000000d7b7cab57b1393ace2d064" +
    "f4d4a2cb8af6def61273e127517d44759b6dafdd990000000000fffffffff8e1f583384333689228c5d28eac13366be082dc57441760d957275419a4" +
    "18420000000000fffffffff0689180aa63b30cb162a73c6d2a38b7eeda2a83ece74310fda0843ad604853b0100000000feffffffaa5202bdf6d8ccd2" +
    "ee0f0202afbbb7461d9264a25e5bfd3c5a52ee1239e0ba6c0000000000feffffff956149bdc66faa968eb2be2d2faa29718acbfe3941215893a2a344" +
    "6d32acd050000000000000000000e664b9773b88c09c32cb70a2a3e4da0ced63b7ba3b22f848531bbb1d5d5f4c94010000000000000000e9aa6b8e6c" +
    "9de67619e6a3924ae25696bb7b694bb677a632a74ef7eadfd4eabf0000000000ffffffffa778eb6a263dc090464cd125c466b5a99667720b1c110468" +
    "831d058aa1b82af10100000000ffffffff0200ca9a3b000000001976a91406afd46bcdfd22ef94ac122aa11f241244a37ecc88ac807840cb00000000" +
    "20ac9a87f5594be208f8532db38cff670c450ed2fea8fcdefcc9a663f78bab962b0065cd1d",
  utxos: [
    ["512053a1f6e454df1aa2776a2814a721372d6258050de330b3c6d10ee8f4e0dda343", 420000000],
    ["5120147c9c57132f6e7ecddba9800bb0c4449251c92a1e60371ee77557b6620f3ea3", 462000000],
    ["76a914751e76e8199196d454941c45d1b3a323f1433bd688ac", 294000000],
    ["5120e4d810fd50586274face62b8a807eb9719cef49c04177cc6b76a9a4251d5450e", 504000000],
    ["512091b64d5324723a985170e4dc5a0f84c041804f2cd12660fa5dec09fc21783605", 630000000],
    ["00147dd65592d0ab2fe0d0257d571abf032cd9db93dc", 378000000],
    ["512075169f4001aa68f15bbed28b218df1d0a62cbbcf1188c6665110c293c907b831", 672000000],
    ["5120712447206d7a5238acc7ff53fbe94a3b64539ad291c7cdbc490b7577e4b17df5", 546000000],
    ["512077e30a5522dd9f894c3f8b8bd4c4b2cf82ca7da8a3ea6a239655c39c050ab220", 588000000],
  ],
  index: 4,
  key: "f36bb07a11e469ce941d16b63b11b9b9120a84d9d87cff2c84a8d4affb438f4e",
  merkleRoot: "ccbd66c6f7e8fdab47b3a486f59d28262be857f30d4773f2d5ea47f7761ce0e2",
  sighash: "4f900a0bae3f1446fd48490c2958b5a023228f01661cda3496a11da502a7f7ef",
  signature: "b4010dd48a617db09926f729e79c33ae0b4e94b79f04a1ae93ede6315eb3669de185a17d2b0ac9ee09fd4c64b678a0b61a0a86fa888a273c" +
    "8511be83bfd6810f",
};

const CHECKS = [
  ["BIP-32 test vector 1", () => {
    const m = fromSeed(fromHex(BIP32_TV1.seed));
    const n = derive(m, BIP32_TV1.path);
    const ok = serializeXpub(n, "xpub") === BIP32_TV1.xpub;
    wipe(m);
    wipe(n);
    return ok;
  }],
  ["BIP-39 seed and BIP-84 key", () => {
    const seed = seedFromMnemonic(BIP84.mnemonic);
    const m = fromSeed(seed);
    seed.fill(0);
    const n = derive(m, BIP84.path);
    const ok = toHex(n.publicKey) === BIP84.pubkey;
    wipe(m);
    wipe(n);
    return ok;
  }],
  ["BIP-143 signature (P2SH-P2WPKH)", () => {
    const tx = parseTx(fromHex(BIP143.tx));
    const key = fromHex(BIP143.key);
    const pub = cr().publicKey(key, true);
    const h = segwitV0Sighash(tx, 0, p2wpkhScriptCode(hash160(pub)), BIP143.amount, 1);
    const sig = cr().ecdsaSign(h, key);
    return toHex(h) === BIP143.sighash && toHex(sig) === BIP143.signature && cr().ecdsaVerify(sig, h, pub);
  }],
  ["BIP-341 signature (key path)", () => {
    const tx = parseTx(fromHex(BIP341.tx));
    const prevouts = BIP341.utxos.map(([s, v]) => ({ script: fromHex(s), value: v }));
    const internal = fromHex(BIP341.key);
    const xonly = cr().xOnlyPublicKey(internal);
    const tweak = taggedHash("TapTweak", concat([xonly, fromHex(BIP341.merkleRoot)]));
    const q = cr().taprootTweakPublicKey(xonly, tweak).key;
    const key = cr().taprootTweakPrivateKey(internal, tweak);
    const h = taprootSighash(tx, BIP341.index, prevouts, 0);
    const sig = cr().schnorrSign(h, key, new Uint8Array(32));
    key.fill(0);
    return toHex(h) === BIP341.sighash && toHex(sig) === BIP341.signature && cr().schnorrVerify(sig, h, q) &&
      toHex(prevouts[BIP341.index].script.subarray(2)) === toHex(q);
  }],
];

export function selfTest(crypto) {
  setCrypto(crypto);
  const checks = [];
  for (const [name, fn] of CHECKS) {
    const t0 = Date.now();
    let ok = false;
    try {
      ok = fn() === true;
    } catch (e) {
      ok = false;
    }
    checks.push({ name, ok, ms: Date.now() - t0 });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
