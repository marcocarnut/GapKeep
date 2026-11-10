// Tests lib/js/bitcoin/psbt under Node, with Node's SHA-256 and RIPEMD-160 in
// place of gk:crypto's, against tests/psbt/vectors.json (sources in
// tests/psbt/README.md):
//   node --experimental-default-type=module tests/psbt/run_node.mjs [-v]
// (the flag: lib/js/bitcoin has no package.json saying its .js files are modules)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setHashes } from "../../lib/js/bitcoin/psbt/hashes.js";
import { fromHex, toHex, DecodeError, equal } from "../../lib/js/bitcoin/psbt/bytes.js";
import { base43Encode, base43Decode, base58Encode, base58Decode, base58CheckEncode, base58CheckDecode } from "../../lib/js/bitcoin/psbt/basen.js";
import { bech32Decode, BECH32, BECH32M, segwitDecode, segwitEncode } from "../../lib/js/bitcoin/psbt/bech32.js";
import { parseTx, serializeTx, txid } from "../../lib/js/bitcoin/psbt/tx.js";
import { scriptToAddress, addressToScript } from "../../lib/js/bitcoin/psbt/script.js";
import { parsePsbt, serializePsbt, PsbtError } from "../../lib/js/bitcoin/psbt/psbt.js";
import { readPayload, electrumQrText } from "../../lib/js/bitcoin/psbt/transport.js";
import { analyze, analyzeTx } from "../../lib/js/bitcoin/psbt/analyze.js";

const hash = (name) => (data) => new Uint8Array(createHash(name).update(data).digest());
const withRipemd = { sha256: hash("sha256"), ripemd160: hash("ripemd160") };
setHashes(withRipemd);

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const verbose = process.argv.includes("-v");
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
  const sa = JSON.stringify(a, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
  const sb = JSON.stringify(b, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
  if (sa !== sb) throw new Error(`${what} got ${sa.slice(0, 200)}, want ${sb.slice(0, 200)}`);
}

function throwsDecode(fn, what = "") {
  try {
    fn();
  } catch (e) {
    if (e instanceof DecodeError) return e;
    throw new Error(`${what} threw ${e && e.name}: ${e && e.message}, not a DecodeError`);
  }
  throw new Error(`${what} did not throw`);
}

const roundTrip = (hex) => {
  const p = parsePsbt(fromHex(hex));
  eq(toHex(serializePsbt(p)), hex, "round trip");
  return p;
};

// --- encodings -----------------------------------------------------------------

for (const [bip, encoding] of [["bip173", BECH32], ["bip350", BECH32M]]) {
  for (const s of V[bip].valid) {
    check(bip, "valid " + s, () => eq(bech32Decode(s).encoding, encoding));
  }
  for (const s of V[bip].invalid) {
    check(bip, "invalid " + JSON.stringify(s), () => throwsDecode(() => bech32Decode(s)));
  }
  for (const { address, script } of V[bip].valid_addresses) {
    const hrp = address.toLowerCase().slice(0, address.lastIndexOf("1"));
    const { version, program } = (() => {
      try {
        return segwitDecode(address);
      } catch (e) {
        return { version: -1 };
      }
    })();
    if (bip === "bip173" && version !== 0) continue; // v1+ there were redone by BIP-350
    check(bip, "address " + address, () => {
      const spk = toHex(Uint8Array.of(version ? 0x50 + version : 0, program.length)) + toHex(program);
      eq(spk, script, "script");
      eq(segwitEncode(hrp, version, program), address.toLowerCase(), "re-encoded");
    });
  }
  for (const a of V[bip].invalid_addresses) {
    check(bip, "invalid address " + a, () => {
      for (const hrp of ["bc", "tb"]) throwsDecode(() => segwitDecode(a, hrp), hrp);
    });
  }
}

const eb = V.electrum.bitcoin;
for (const { hex, encoded } of eb.base43) {
  check("base43", "Electrum test_base43", () => {
    eq(base43Encode(fromHex(hex)), encoded);
    eq(toHex(base43Decode(encoded)), hex);
  });
}
for (const { hex, encoded } of eb.base58) {
  check("base58", "Electrum test_base58", () => {
    eq(base58Encode(fromHex(hex)), encoded);
    eq(toHex(base58Decode(encoded)), hex);
  });
}
for (const { hex, encoded } of eb.base58check) {
  check("base58", "Electrum test_base58check", () => {
    eq(base58CheckEncode(fromHex(hex)), encoded);
    eq(toHex(base58CheckDecode(encoded)), hex);
    const broken = encoded.slice(0, -1) + (encoded.endsWith("1") ? "2" : "1");
    throwsDecode(() => base58CheckDecode(broken), "wrong checksum");
  });
}

// Base43 and Base58 against a plain BigInt version of Electrum's code, on
// random data with leading zeros
function referenceEncode(bytes, alphabet) {
  const base = BigInt(alphabet.length);
  let z = 0;
  while (z < bytes.length && bytes[z] === 0) z++;
  let num = 0n;
  for (const b of bytes.subarray(z)) num = num * 256n + BigInt(b);
  let s = "";
  while (num > 0n) {
    s = alphabet[Number(num % base)] + s;
    num /= base;
  }
  return alphabet[0].repeat(z) + s;
}
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 255;
for (let t = 0; t < 300; t++) {
  const n = t < 20 ? t : rand() * 2;
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i < (t % 4) ? 0 : rand()));
  check("base43", `random ${t} (${n} bytes)`, () => {
    const s = base43Encode(bytes);
    eq(s, referenceEncode(bytes, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:"));
    eq(toHex(base43Decode(s)), toHex(bytes));
  });
  check("base58", `random ${t} (${n} bytes)`, () => {
    const s = base58Encode(bytes);
    eq(s, referenceEncode(bytes, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"));
    eq(toHex(base58Decode(s)), toHex(bytes));
  });
}
check("base43", "not in the alphabet", () => throwsDecode(() => base43Decode("ABc")));

// --- scripts and addresses -------------------------------------------------------

for (const { address, script, network } of eb.addresses) {
  check("addresses", `Electrum address_to_script ${address}`, () => {
    eq(toHex(addressToScript(address, network)), script);
    eq(scriptToAddress(fromHex(script), network), /^[13mn2]/.test(address) ? address : address.toLowerCase());
  });
}
for (const { script, address } of V.electrum.transaction.address_from_script) {
  check("addresses", `Electrum get_address_from_output_script ${script.slice(0, 20)}`, () => {
    // Electrum gives no address for a v0 program of the wrong length, nor for P2PK
    eq(scriptToAddress(fromHex(script), "mainnet"), address);
  });
}
check("addresses", "regtest and P2SH testnet", () => {
  eq(scriptToAddress(fromHex("0014751e76e8199196d454941c45d1b3a323f1433bd6"), "regtest"), "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080");
});

// --- transactions ---------------------------------------------------------------

for (const { test, hex, txid: want } of V.electrum.transaction.txids) {
  check("transactions", "Electrum " + test, () => {
    const tx = parseTx(fromHex(hex));
    eq(txid(tx), want, "txid");
    eq(toHex(serializeTx(tx)), hex, "round trip");
  });
}
check("transactions", "BIP-174's extracted transaction", () => {
  const tx = parseTx(fromHex(V.bip174.extracted_tx));
  eq(toHex(serializeTx(tx)), V.bip174.extracted_tx);
});
check("transactions", "truncated", () => throwsDecode(() => parseTx(fromHex(V.electrum.transaction.txids[0].hex.slice(0, -10)))));

// --- what Electrum reads from a QR code (tx_from_any) ---------------------------------

for (const { name, text, binary } of V.electrum.transaction.tx_from_any) {
  const kind = name.startsWith("psbt") ? "psbt" : "tx";
  if (binary && name.endsWith("raw_bytes")) {
    check("transport", "Electrum tx_from_any " + name, () => {
      const bytes = fromHex(text);
      if (kind === "psbt") eq(readPayload(null, bytes).kind, "psbt");
      else throwsDecode(() => readPayload(null, bytes)); // a scanner hands raw bytes only when not text
    });
    continue;
  }
  check("transport", "Electrum tx_from_any " + name, () => {
    const r = readPayload(text);
    eq(r.kind, kind, "kind");
    const mid = Math.floor(text.length / 2);
    const spaced = readPayload(" \r\n  \n  " + text.slice(0, mid) + " \r\n  \n  " + text.slice(mid) + " \r\n  \n  ");
    eq(toHex(spaced.bytes), toHex(r.bytes), "with whitespace");
    if (kind === "psbt") roundTrip(toHex(r.bytes));
    else parseTx(r.bytes);
  });
}
check("transport", "refusals", () => {
  for (const t of ["", "   ", "bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=1", "hello, air gap",
                   "ur:crypto-psbt/abc", "B$2P0100", "cHNidP8BAH!"]) {
    throwsDecode(() => readPayload(t), JSON.stringify(t));
  }
  throwsDecode(() => readPayload("45505446ff00"), "old Electrum");
  // BBQr's header is in Base43's alphabet: refused as BBQr, not as garbage
  if (!/BBQr/.test(throwsDecode(() => readPayload("B$ZP0100FMUE4KXZZ7EIRE3P5ZBTVAKMXN44").message))) throw new Error("not BBQr");
});
check("transport", "electrumQrText avoids text Electrum would read as hex", () => {
  // short data often has a Base43 form of only hex digits, of even length:
  // Electrum would read it as hex, so it must come as hex
  let fallbacks = 0;
  for (let v = 0; v < 5000; v++) {
    const b = Uint8Array.of(v >> 8, v & 255);
    const t = electrumQrText(b);
    if (/^([0-9A-F]{2})*$/.test(t)) {
      fallbacks++;
      eq(t, toHex(b).toUpperCase());
    } else eq(toHex(base43Decode(t)), toHex(b));
  }
  if (!fallbacks) throw new Error("no case found");
});

// --- PSBT: BIP-174 ----------------------------------------------------------------------

for (const { name, hex } of V.bip174.invalid) {
  check("bip174", "invalid: " + name, () => {
    if (!hex.startsWith("70736274ff")) return eq(readPayload(hex).kind, "tx");
    const e = throwsDecode(() => parsePsbt(fromHex(hex)));
    if (verbose) console.log("     ", e.message);
  });
}
for (const { name, hex } of V.bip174.valid) check("bip174", "valid: " + name, () => analyze(roundTrip(hex)));
for (const { name, hex } of V.bip174.workflow) check("bip174", "workflow: " + name, () => analyze(roundTrip(hex)));
for (const { name, hex } of V.bip174.signer_fails) {
  check("bip174", "signer check: " + name, () => {
    const a = analyze(roundTrip(hex), { network: "testnet" });
    const levels = a.warnings.map((w) => w.level);
    if (name.startsWith("A Witness UTXO is provided for a non-witness input")) {
      if (!a.warnings.some((w) => /only the spent output is given/.test(w.text))) throw new Error("no warning");
    } else if (!levels.includes("danger")) throw new Error("no danger: " + JSON.stringify(a.warnings));
  });
}
for (const v of [...V.bip174.valid, ...V.bip174.workflow]) {
  if (!v.electrum) continue;
  check("bip174", "as Electrum sees it: " + v.name, () => {
    const a = analyze(parsePsbt(fromHex(v.hex)), { network: "testnet" });
    if (v.electrum.txid) eq(a.txid, v.electrum.txid, "txid");
    eq(a.outputs.map((o) => ({ address: o.address, value: o.amount })), v.electrum.outputs, "outputs");
    eq(a.totalIn, v.electrum.input_value, "input value");
    eq(a.fee, v.electrum.fee, "fee");
  });
}

// --- PSBT: BIP-370 ------------------------------------------------------------------------

for (const { name, hex } of V.bip370.invalid) check("bip370", "invalid: " + name, () => throwsDecode(() => parsePsbt(fromHex(hex))));
for (const { name, hex } of V.bip370.valid) check("bip370", "valid: " + name, () => analyze(roundTrip(hex)));
for (const { name, hex, locktime } of V.bip370.locktime) {
  check("bip370", `locktime ${locktime}: ${name}`, () => {
    const p = roundTrip(hex);
    eq(p.tx.locktime, locktime);
    const a = analyze(p);
    if (locktime === null && !a.warnings.some((w) => w.level === "danger")) throw new Error("no danger");
  });
}

// --- PSBT: Electrum's tests -----------------------------------------------------------

for (const { class: cls, test, psbts } of V.electrum.psbt) {
  for (const text of psbts) {
    check("electrum psbt", `${cls}.${test}`, () => {
      if (cls === "TestInvalidPSBT" && !test.includes("inconsistent")) {
        throwsDecode(() => parsePsbt(readPayload(text).bytes));
        return;
      }
      const p = roundTrip(toHex(readPayload(text).bytes));
      const a = analyze(p, { network: "testnet" });
      if (test.includes("inconsistent") && !a.warnings.some((w) => w.level === "danger")) throw new Error("no danger");
    });
  }
}

// Electrum's own QR codes (test_wallet_vertical: to_qr_data()), and its
// PSBTs, against what Electrum says of them
const electrumFacts = (a, e, label) => {
  eq(a.outputs.map((o) => ({ address: o.address, value: o.amount })), e.outputs, `${label} outputs`);
  if (e.input_value !== undefined) eq(a.totalIn, e.input_value, `${label} input value`);
  if (e.fee !== undefined) eq(a.fee, e.fee, `${label} fee`);
  if (e.txid) eq(a.txid, e.txid, `${label} txid`);
  if (e.inputs) {
    eq(a.inputs.map((i) => ({ prevout: `${i.prevTxid}:${i.vout}`, value: i.amount, address: i.address, fingerprints: i.fingerprints })),
      e.inputs, `${label} inputs`);
  }
};
for (const v of V.electrum.wallet_qr) {
  check("electrum qr", v.test, () => {
    const r = readPayload(v.text);
    eq([r.encoding, r.kind], ["base43", "psbt"]);
    const p = roundTrip(toHex(r.bytes));
    eq(electrumQrText(serializePsbt(p)), v.text, "Base43 back");
    electrumFacts(analyze(p, { network: v.network }), v.electrum, "Electrum");
  });
}
for (const v of V.electrum.wallet_psbts) {
  check("electrum psbt", "test_wallet_vertical." + v.test, () => {
    const p = roundTrip(v.hex);
    if (v.electrum) electrumFacts(analyze(p, { network: v.network }), v.electrum, "Electrum");
  });
}

// PSBTs made with Electrum for these tests (make_electrum_psbts.py)
for (const m of (V.electrum_made && V.electrum_made.made) || []) {
  check("electrum made", m.name, () => {
    const r = readPayload(m.qr);
    eq(r.encoding, "base43");
    if (m.complete) {
      eq(r.kind, "tx");
      const tx = parseTx(r.bytes);
      eq(txid(tx), m.txid, "txid");
      eq(toHex(serializeTx(tx)), m.tx_hex, "round trip");
      eq(base43Encode(serializeTx(tx)), m.qr, "Base43 back");
      const a = analyzeTx(tx, { network: m.network });
      eq([a.txid, a.complete, a.fee, a.sizeExact, a.inputs[0].type], [m.txid, true, null, true, "p2wpkh"], "analyzeTx");
      return;
    }
    const p = roundTrip(toHex(r.bytes));
    eq(electrumQrText(serializePsbt(p)), m.qr, "Base43 back");
    roundTrip(m.psbt_hex);
    const a = analyze(p);
    eq(a.network, m.network, "network guessed");
    eq(a.fee, m.fee, "fee");
    eq(a.totalIn, m.input_value, "input value");
    eq(a.txid, m.txid, "txid");
    eq(a.fingerprints, m.fingerprints, "fingerprints");
    eq(a.outputs.map((o) => ({ address: o.address, value: o.amount, change: o.role === "change", mine: o.mine })),
      m.outputs, "outputs");
    // the size once signed: estimated with 72-byte signatures, as Electrum does
    eq(a.vsize, m.estimated_vsize, "vsize");
    if (m.name === "testnet-p2pkh" && !a.warnings.some((w) => /only the spent output is given/.test(w.text))) {
      throw new Error("no warning about the missing previous transaction");
    }
    if (m.name === "testnet-2of3-p2wsh") eq(a.inputs[0].multisig, { m: 2, n: 3 });
    if (verbose) console.log("     ", m.name, a.vsize, "vB (Electrum", m.estimated_vsize + ")", a.warnings.map((w) => w.text));
  });
}

// without RIPEMD-160 (gk:crypto may not have it): the same, with key checks
// reported as not done
setHashes({ sha256: withRipemd.sha256 });
for (const m of (V.electrum_made && V.electrum_made.made) || []) {
  if (m.complete) continue;
  check("no ripemd160", m.name, () => {
    const a = analyze(parsePsbt(readPayload(m.qr).bytes));
    eq(a.fee, m.fee, "fee");
    eq(a.outputs.map((o) => o.mine), m.outputs.map((o) => o.mine), "mine");
    // P2WPKH change needs RIPEMD-160 to check; P2WSH change needs SHA-256 only
    eq(a.warnings.some((w) => /RIPEMD-160/.test(w.text)), a.outputs.some((o) => o.unchecked) || a.inputs.some((i) => i.unchecked), "note");
    if (m.name.includes("p2wpkh") && !a.outputs.some((o) => o.unchecked)) throw new Error("nothing unchecked");
  });
}
setHashes(withRipemd);

// a change output whose script is not its key's: not change
check("analysis", "a lying change output", () => {
  const m = V.electrum_made.made.find((x) => x.name === "testnet-p2wpkh-change");
  const p = parsePsbt(readPayload(m.qr).bytes);
  const i = p.tx.outputs.findIndex((o, k) => p.outputs[k].fields.bip32.length);
  p.tx.outputs[i].script[5] ^= 1;
  const a = analyze(p);
  eq(a.outputs[i].mine, false);
  if (!a.warnings.some((w) => w.level === "danger" && /back to your wallet/.test(w.text))) throw new Error("no danger");
});

// --- timing (Base43 is quadratic) --------------------------------------------------

const big = V.electrum_made && V.electrum_made.made.find((x) => x.name === "testnet-many-inputs");
if (big) {
  const t0 = performance.now();
  const bytes = base43Decode(big.qr);
  const t1 = performance.now();
  base43Encode(bytes);
  const t2 = performance.now();
  const p = parsePsbt(bytes);
  analyze(p);
  const t3 = performance.now();
  console.log(`timing: ${big.qr.length} Base43 characters (${bytes.length} bytes): decode ${(t1 - t0).toFixed(1)} ms, ` +
    `encode ${(t2 - t1).toFixed(1)} ms, parse and analyze ${(t3 - t2).toFixed(1)} ms (Node)`);
}

let passed = 0, failed = 0;
for (const [g, c] of Object.entries(counts)) {
  console.log(`  ${g}: ${c.passed} passed${c.failed ? `, ${c.failed} FAILED` : ""}`);
  passed += c.passed;
  failed += c.failed;
}
for (const f of failures) console.log("FAIL", f);
console.log(`psbt tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
