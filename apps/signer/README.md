# Signer

Shows what a Bitcoin transaction does, then signs it. It takes the
transaction first, so you see it before any secret is in memory, and gives
back a QR code Electrum loads.

## Using it

1. **The transaction.** In Electrum, make the transaction, then Export (or
   Share), Show as QR code. Here: Scan a transaction. The summary shows what
   it spends and pays, the fee and warnings. Change is only the PSBT's word
   so far: "Claimed change (not checked yet)". A finished transaction is
   shown too, with nothing to sign. "Merge a copy" adds another copy of the
   same transaction with other signatures (BIP-174's Combiner).
2. **The keys.** Load the keys that sign it, as many as needed:
   - codex32 shares, typed or scanned, as many as the threshold. Say what
     they hold: a seed phrase's entropy, as dice39 makes them (the default,
     then the BIP-39 passphrase if any), or a BIP-32 master seed, as BIP-93
     says;
   - BIP-39 words, typed or scanned as text, and the passphrase;
   - an xprv (or zprv, yprv...), master or an account's;
   - a WIF: one key. Uncompressed WIF keys are refused for now: they are
     for legacy coins.

   For each, the app shows its fingerprint and what it signs ("signs 2 of 3
   inputs"): check the fingerprint against what you know of the wallet. The
   keys stay in the app's memory only.
3. **The summary again**, with change decided by the keys, not the PSBT:

   | Change output | Shown | In the totals |
   | --- | --- | --- |
   | No key loaded yet | amber, "claimed" | apart, as claimed |
   | Proved, in the inputs' account, on chain 1 or 0, near their index | green | change |
   | Ours, at a path the wallet may never scan | amber, with the path | sent |
   | A key refutes it | red; signing asks first | sent |
   | No key loaded can speak for it | amber | sent |

4. **Sign.** The result is a finished transaction when every input is
   signed, else a PSBT that needs more signatures. A merged PSBT with every
   signature needs no key at all: "Finish the transaction". Then "Done,
   forget the keys" (Escape does the same), or "Next transaction (keep
   keys)". In Electrum: Tools, Load transaction, From QR code, and broadcast.

**Once: the public key for Electrum.** "Public key for Electrum" needs a
master key. It shows the account's zpub (BIP-84) or ypub (BIP-49), vpub/upub
on testnet, as a QR code. In Electrum: File, New/Restore, Standard wallet,
Use a master key, and scan it. That watch-only wallet makes the transactions.

Electrum's QR codes leave out the previous transactions, so legacy (P2PKH)
coins can't be signed from them. Electrum has no taproot wallets; the library
signs BIP-86 key-path inputs, but only the BIP test vectors exercise that.

Never logged: shares, words, the passphrase, keys. The log gets counts,
sizes, and the hash of a signed transaction (not secret: it is about to be
broadcast), which `tests/signer.txt` compares with Electrum's own. Forgetting
wipes every key's bytes, and the fields that showed a secret are emptied
before their page goes.

## Signing library (`lib/`)

Pure modules like the PSBT library (`lib/psbt/`, a copy of
`apps/psbtview/lib`): no `zg:*` import, so the same files run here and
under Node (`tests/signer/run_node.mjs`). The cryptography is given once:

```js
import * as crypto from "zg:crypto";
import { setCrypto } from "./lib/crypto.js";
setCrypto(crypto);          // also gives SHA-256 and RIPEMD-160 to lib/psbt
```

### `lib/bip39.js`

| | |
| --- | --- |
| `mnemonicFromEntropy(entropy)` | 16, 20, 24, 28 or 32 bytes -> English words. |
| `entropyFromMnemonic(text)` | Back, checking the words and the checksum. Any whitespace, either case. `Bip39Error` names a word's position, never the word. |
| `seedFromMnemonic(mnemonic, passphrase = "")` | `Uint8Array(64)`: PBKDF2-HMAC-SHA512, 2048 rounds, both NFKD (QuickJS has `String.prototype.normalize`). Doesn't check the words (BIP-39: any text has a seed). About 0.1 s on a Pi Zero. |

### `lib/bip32.js`

A node is `{ depth, parentFingerprint, childNumber, chainCode, privateKey | null, publicKey }`
(byte arrays; the public key compressed).

| | |
| --- | --- |
| `fromSeed(seed)` | Master node from a 16..64-byte seed (a BIP-93 codex32 secret is one, or a BIP-39 seed). |
| `derive(node, path)` | `"m/84'/0'/0'"` (`'` or `h`) or `[u32]`; a new node, intermediate keys wiped. |
| `deriveChild(node, index)` | One step. |
| `parsePath(text)`, `formatPath(path)` | `"m/84h/0'/0'"` <-> `[0x80000054, ...]`, and back as `m/84'/0'/0'`. |
| `neuter(node)`, `wipe(node)` | The public copy; zeroes a private node's key and chain code. |
| `fingerprint(node)`, `fingerprintHex(node)` | First 4 bytes of HASH160 of the public key. |
| `serializeXpub(node, version)` | `"xpub"`, `"ypub"`, `"zpub"`, `"tpub"`, `"upub"`, `"vpub"` (SLIP-132). |
| `versionFor(script, network)` | The version to export for `"p2wpkh"`, `"p2sh-p2wpkh"`, `"p2pkh"`/`"p2tr"`. |
| `parseXpub(text)` | `{ node, version, network, script }`; refuses private keys and everything BIP-32's test vector 5 lists. |

Errors: `Bip32Error`. Private keys are never serialized.

### `lib/sign.js`

| | |
| --- | --- |
| `plan(psbt, key, options)` | What signing would do, without signing (below). |
| `signPsbt(psbt, key, options)` | `{ psbt, signed: [{ input, path, pubkey }], skipped: [{ input, reason }], plan }`. Signs exactly what `plan` says; `psbt` is a new, re-parsed PSBT (the one given is left as it was). Adds `PSBT_IN_PARTIAL_SIG` (DER + sighash byte) or `PSBT_IN_TAP_KEY_SIG`; each signature is verified first. |
| `planKeys(psbt, keys, options)` | `plan` for several keys: `{ inputs, outputs, signable, complete, keys: [{ fingerprint, signs }] }`. Each output adds `claimed` and `stray`. With no keys, it still says which inputs are signed. |
| `signKeys(psbt, keys, options)` | Each key in turn: `{ psbt, signed, plan }`. |
| `partialSigGood(psbt, i, pubkey, signature)` | Would the signer accept this signature? `null`: it can't tell. |
| `verifyChange(psbt, key, options)` | `plan(...).outputs`. |
| `finalize(psbt)` | `{ tx, txid, vsize }`: the network transaction once every input is signed (`SignError` naming the first that isn't). Smaller than the PSBT: 592 against 923 Base43 characters for two inputs. |

`psbt` comes from `parsePsbt()`. `key` is one of:

- a private BIP-32 node at depth 0, a master key;
- a private node deeper down, as an account's xprv. It doesn't know the
  master's fingerprint, so it knows its keys by its own fingerprint or by
  the path and public key the PSBT names: deriving must give that key;
- a single key, `{ single: true, privateKey, publicKey }`, from `keys.js`. It
  has no paths: what pays to it is its own.

`options`:

- `network`: `"mainnet"`, `"testnet"` or `"regtest"`, to flag coin types that don't match.
- `accounts`: account paths whose own fingerprint stands for the master's (Electrum's watch-only wallets, below). Default `STANDARD_ACCOUNTS`: account 0 of BIP-44, 49, 84 and 86, mainnet and test.
- `maxIndex`: an address index above this is flagged (default 1000000).
- `aux`: taproot's auxiliary randomness, 32 bytes or `(input) => bytes`; default fresh random bytes from zg:crypto.

`plan()` returns

```
{ fingerprint: "73c5da0a", signable, complete,
  inputs:  [{ index, sign, final, signed, badSignature, mine, type, path: "m/84'/0'/0'/0/3" | null, pubkey (hex) | null,
              sighash, reason (when not signing) | null, oddities: [string] }],
  outputs: [{ index, ours, type, path | null, role: "change" | "receive" | null,
              problem: string | null, oddities: [string] }] }
```

`reason`, `problem` and `oddities` are sentences for people, naming paths
and positions (never keys). `complete`: every input would be signed, holds
a good signature, or is final, so `finalize` will work after signing.
`signed`: it holds a good signature. `badSignature`: it holds one that doesn't
verify, or isn't SIGHASH_ALL, which doesn't count. `mine`: this key has
something to do with the input.

**An input is signed only if**: it spends P2WPKH, P2SH-P2WPKH, P2TR (BIP-86
key path, no script tree) or P2PKH; its coin is described (witness UTXO or
previous transaction, whose txid must match; both must agree; P2PKH needs
the previous transaction, which Electrum's QR codes leave out; taproot
needs every input's coin); its sighash type is ALL (taproot: DEFAULT or
ALL); and one of its derivations has our fingerprint, the key derived at
its path is the one the PSBT names, and that key is what the coin's script
pays to (taproot: BIP-86's tweak of it is the output key).

**An output is ours** only if deriving its stated path gives the key it
names and that key's script is the output's script. `analyze()` (lib/psbt)
marks outputs "mine" from fingerprints, which anyone can write: show
`plan().outputs` instead.

**At home, or stray** (`planKeys`). Deriving correctly isn't enough: an output
of ours at a path the wallet never scans is money lost in practice, held to
ransom by whoever knows the path. An output is at home when, compared with the
inputs the loaded keys sign or have signed, it is in the same account (the
path but its last two steps: same purpose, coin type and account), on chain 1
or 0, and its index is at most `CHANGE_GAP` (1000) past the inputs' highest.
The limit counts from the inputs, not from zero, so a wallet with many
addresses isn't flagged; the price is an amber flag when an old, low-index
coin pays change far past it, which costs a look, not money. A single key's
output is at home if that key spends too. Otherwise `stray` says why.

**Oddities** (signed anyway, shown to the person): a path that isn't
m/purpose'/coin'/account'/change/index, a purpose that doesn't match the
script (84' for P2WPKH...), a coin type for another network, a branch other
than 0/1, a hardened or very high index, an account other than the inputs',
change to another script type than the inputs'.

### `lib/keys.js`

`parsePrivateKey(text)`, by its first letters; `parseWif`,
`parseExtendedPrivateKey`. -> `{ key, kind: "wif" | "xprv", network, script }`.
`KeyError` for people, never quoting the text.

### `lib/combine.js`

`combine(a, b)` -> `{ psbt, added, notes: [{ level, text }] }`: BIP-174's
Combiner, for copies of one transaction: same version, same txid, then every
map's union; `CombineError` if a key holds two values. Two signatures by one
key of one input are verified instead: both good, the first stays, with a
note; only one good, it stays, with a red note; neither, the first stays and
`plan` reports it; when it can't tell (a multisig coin), refused.

### `lib/review.js`

`applyPlan(analysis, plan)`: what `analyze()` read as claims, as `planKeys`
decided them (the table above). `flagSignatures(analysis, plan)`: bad
signatures, with or without keys.

### `lib/sighash.js`

`legacySighash`, `segwitV0Sighash` (BIP-143), `taprootSighash` and
`taprootSigMsg` (BIP-341 key path), for any sighash type (the policy is
`sign.js`'s).

### `lib/selftest.js`

`selfTest(crypto)` -> `{ ok, checks: [{ name, ok, ms }] }`: BIP-32 test
vector 1, a BIP-39 seed to BIP-84's first key, BIP-143's P2SH-P2WPKH
signature, and a BIP-341 key-path signature, through zg:crypto's
libsecp256k1. It calls `setCrypto(crypto)`. About 8 ms in the simulator.

## Electrum and fingerprints

What Electrum (4.8.3) writes in a PSBT's key derivations:

- **A wallet made in Electrum from a BIP-39 seed**:
  the master fingerprint and the full path, `73c5da0a` `m/84'/0'/0'/0/5`.
- **A watch-only wallet from an xpub/zpub alone**: Electrum doesn't know
  where the key came from, so it writes **the account key's own
  fingerprint** and the path **below** it: `fd13aac9` `m/0/5`. (A key at
  depth 0 or 1 would carry its origin, but an account is at depth 3.)
- **There is no way to give Electrum the key origin**: its "Use a master
  key" field takes a bare xpub/ypub/zpub only (`keystore.is_master_key`);
  `[73c5da0a/84h/0h/0h]zpub...` and descriptors are refused. Only a
  hand-edited wallet file (`root_fingerprint`, `derivation`) or a
  hardware-wallet plugin sets it.

So export the account xpub in the SLIP-132 form for its script type
(`serializeXpub(neuter(derive(master, "m/84'/0'/0'")), "zpub")`; `ypub` for
P2SH-P2WPKH, `vpub`/`upub` on testnet: Electrum takes the script type from
the version). The signer recognises the account's fingerprint (`accounts`
option, the standard account-0 paths by default: pass the path you
exported if it is another one) and rebuilds the full path, then checks the
key and script as for any input. The tests check this against PSBTs from
real Electrum watch-only wallets. Electrum 4.8 has no taproot wallets.

Electrum's QR codes replace each input's previous transaction with the
output it spends, so P2PKH inputs can't be signed from a QR code (export
the PSBT as a file instead). Electrum loads both what `signPsbt` gives
back (the signed PSBT, as `electrumQrText(serializePsbt(psbt))`) and the
final transaction (`electrumQrText(finalize(psbt).tx)`).
