# Signer

Shows what a Bitcoin transaction does, then signs it. It takes the
transaction first, so you see it before any secret is in memory, and gives
back a QR code Electrum loads, or animated BBQr codes.

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
   - a WIF: one key. An uncompressed one spends only legacy (P2PKH) coins.

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
   A result that fits one QR code is shown as one, in Base43, as Electrum
   reads it, with "Show as BBQr" on offer; one that doesn't is shown as
   animated BBQr codes, all of one version up to 12, at 500 ms each, with
   Pause and Next part. Electrum doesn't read BBQr.

**Once: the public key.** "Public key" needs a master key: it shows an account
of BIP-84, BIP-49, BIP-44 or BIP-86 (account 0, or the number you give) as a
QR code, with the master fingerprint as text; BIP-48's multisig key
(m/48'/c'/a'/2') is a cosigner's key expression, or a Zpub for Electrum:

- a descriptor, `wpkh([fingerprint/84h/0h/0h]xpub.../<0;1>/*)#checksum`, with
  the key's origin, for wallets that take one;
- the zpub (ypub; vpub/upub on testnet), for Electrum: File, New/Restore,
  Standard wallet, Use a master key, and scan it.

That watch-only wallet makes the transactions. Electrum's PSBTs from it name
the account's own fingerprint, not the master's, and only account 0 and the
number on this page are recognised: for another account, set it there before
signing, each time the app starts. PSBTs with the master fingerprint and the
full path need nothing of the kind.

Legacy (P2PKH) coins are signed only with their previous transactions in the
PSBT. Electrum's QR codes leave those out, so its legacy wallets can't be signed
for this way; a wallet that sends the whole PSBT can, as animated BBQr when
it's large. Electrum has no taproot wallets; the library signs BIP-86 key-path
inputs and exports `tr()` descriptors, but only the BIP test vectors and the
simulator exercise that: no taproot wallet has read one yet.

Never logged: shares, words, the passphrase, keys. The log gets counts,
sizes, and the hash of a signed transaction (not secret: it is about to be
broadcast), which `tests/signer.txt` compares with Electrum's own. Forgetting
wipes every key's bytes, and the fields that showed a secret are emptied
before their page goes.

## The summary

- **Totals first**: what is sent to others, the change back to your wallet,
  the fee (and sat/vB), what is spent, and the network.
- **Warnings**, red (don't sign), amber (check), blue (to know).
- **Outputs**: each address (grouped by four characters, to compare with
  the receiver's) and amount; change as in the table above, with its key path.
- **Inputs**: the coin spent, its amount, type, key path and wallet
  fingerprint, and how far it is signed.
- **Details**: the transaction ID (when signing can't change it), version,
  locktime, RBF, size.

Keyboard: Tab and Shift+Tab go through the buttons and the rows, the arrows
(and Page Up/Down) through the rows; Enter on a row shows all of it (full
address, script, key paths); Escape leaves the scanner, or goes back to the
start. "Network" changes the network the addresses are shown for: a PSBT
doesn't say it, so it is guessed from the key paths (`m/84'/1'/...` is a
test network) and xpubs. Testnet and signet addresses are the same; regtest
must be chosen by hand.

## What it reads

What Electrum's "Load transaction / From QR code" reads (`tx_from_any()`
in `electrum/transaction.py`), in the same order: the text without
whitespace, as **hex**, else **Base64** if it starts with `cHNidP`, else
**Base43** (Electrum's QR form, at most 30000 characters); the bytes are a
**PSBT** (version 0, BIP-174, or version 2, BIP-370) or a **signed
transaction** (shown too: no fee, as it doesn't say what its coins were
worth). Besides that, **BBQr** codes: a series, or one
(`lib/codes.js`). Payment requests (`bitcoin:`), UR codes, and Electrum's
pre-4.0 format are refused with a message saying so; so is anything
malformed or truncated, with what is wrong.

## What it checks before the keys

- The amounts: the input total, outputs, fee (refused as invalid if
  negative; a warning when over 500 sat/vB or 10% of what is spent).
- **Claimed change** (the keys decide, later) is an output with a BIP-32 key
  from a wallet (master fingerprint) that also signs the inputs, and whose
  script pays to that key: P2WPKH and P2PKH by RIPEMD-160 (`gk:crypto`'s `ripemd160` when the
  system has it; without it the check is skipped and the screen says so),
  P2SH by its redeemScript, P2WSH multisig by its witnessScript. An output
  claiming a wallet key but paying elsewhere is flagged red and counted as
  someone else's. Taproot keys are not checked here (that needs the key
  tweak); once the keys are in, they are (`gk:crypto`'s
  `taprootTweakPublicKey`, BIP-86), as all change is.
- Each input's previous transaction against its txid, and against its
  witness UTXO; redeemScripts and witnessScripts against their scripts.
- **Electrum's QR codes leave out the previous transactions**
  (`convert_all_utxos_to_witness_utxos()`, to make the code fit). For
  segwit v0 inputs the amounts are then the PSBT's word: a signature covers
  its own input's amount only, so two signatures of differently-described
  versions can make a transaction with a much larger fee (the segwit v0 fee
  attack). So with more than one segwit v0 input, any of them without its
  previous transaction, the warning is red, and signing asks "Sign anyway":
  every multi-input PSBT from Electrum's QR codes. One input alone is safe
  (its signature covers the amount the fee is computed from), and so is
  taproot (its signatures cover every input's amount). With the previous
  transaction, the amount is its own. For non-segwit inputs the amount
  can't be checked at all, and a signer needs the previous transaction
  (amber).
- Input and output amounts over 21 million BTC (red).
- **The network** decides the addresses shown: the one chosen with the
  Network button; else the loaded keys' (an xprv's or WIF's version;
  mainnet if any says so); else the PSBT's guess from its paths and xpubs,
  and a guess other than mainnet gets an amber warning, as a mainnet
  transaction shown as a test one would look harmless. Seed words and
  codex32 shares don't say.
- Inputs with no key origin, inputs from different wallets, non-ALL
  sighash types, dust and OP_RETURN outputs, unmeetable locktimes.

The size and fee rate are estimated for the signed transaction as Electrum
does (72-byte signatures): the same vsize as Electrum for every test PSBT.

## Limits

Everything a code holds is checked in one handler, which has 10 s, and a
hostile computer could aim past that. So the Signer reads at most 256 KiB
(a PSBT with its previous transactions: some 200 inputs of ordinary ones),
and checks at most 200 inputs and 500 outputs, refusing more with a
sentence that says so. In the simulator, parsing a 486 KB PSBT takes
77 ms, and analysing and planning 200 inputs that each hold a signature to
verify about 30 ms; a Pi Zero is some 30 to 40 times slower. Each held
signature is verified once per PSBT, however often it is asked about.

## Speed

Electrum's Base43 decoding is quadratic; here it splits the number in
halves and lets QuickJS's BigInt do the work. In the simulator, decoding
the largest test code (3823 characters, 2593 bytes, 18 inputs) takes about
1 ms, encoding it 6 ms and analysing it 2 ms; the simulator estimates a
Pi Zero at some 40 times that (under half a second for all of it).

## Signing library (`lib/`)

Pure modules, like the PSBT library (`lib/psbt/`, all but `view.js`, which
draws): no `gk:*` import, so the same files run here and
under Node (`tests/signer/run_node.mjs`). Their home is `lib/js/bitcoin/`
(`lib/js/README.md`), the copies here are made by `tools/share_libs.py`:
change them there. The signer's own are `review.js`, `codes.js`,
`wallet.js`, `selftest.js` and `psbt/view.js`. The cryptography is given
once:

```js
import * as crypto from "gk:crypto";
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
| `planKeys(psbt, keys, options)` | `plan` for several keys: `{ inputs, outputs, signable, complete, keys: [{ fingerprint, signs }] }`. Each output adds `claimed`, `stray`, `far` and `unproved`. With no keys, it still says which inputs are signed. |
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
- `aux`: taproot's auxiliary randomness, 32 bytes or `(input) => bytes`; default fresh random bytes from gk:crypto.

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

**An uncompressed key** (a WIF) hashes its 65-byte public key. Only P2PKH can
use one: a segwit script paying to that hash could never be spent, so such a
coin is refused and such an output isn't ours, whatever the hash says.

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

**Near, or far.** Wallets scan about `CHANGE_NEAR` (20) addresses ahead, so a
hostile computer could hide change past that behind a green review. Change at
home up to `CHANGE_NEAR` past the inputs' highest index (same account, either
chain) is green. Past that, `far` gives its index: it is still change and
counted as change, but amber, with a note that the wallet finds the coin only
if it looks that far ahead (gap limit). Past `CHANGE_GAP` it is stray.

The Signed page gives the transaction ID, grouped in fours, to compare with what
the wallet says it broadcast; a partly signed PSBT says it has none yet.

**Multisig** (`multisig.js`). P2WSH and P2SH-P2WSH m-of-n are signed and
finalized; only the plain script, with compressed keys, each once. Any other
witness script is refused. `plan().inputs[i].multisig` is `{ m, n, have, will }`:
signatures good so far, and how many these keys add. An input is `signed` at m
good ones; the final witness has exactly m, in the script's order.

Our key in a change script proves nothing by itself: a hostile computer can
write 2-of-3 with it and two keys of its own. Nothing is stored here, so the
others are proved from the PSBT's global xpubs. Change is ours only when
every input is one wallet (same type, m, n and xpubs), each script's keys and
xpubs match one to one, the change has exactly that m and n, its keys share
one relative path and are in the inputs' order (else it is stray: an address
the wallet never scans), and each input's keys share one suffix of exactly two
steps below their xpubs. The order: sorted (sortedmulti, BIP-67) when every
input's keys are; the same order of cosigners as every input's (plain multi);
inputs that follow neither prove nothing. Change the proved inputs show isn't their
wallet's is red (`problem`, `notWallet`), and counted as sent. Where the proof
can't be made (no xpubs, inputs not proved, too much to derive) `unproved` says
why: amber, and counted as sent. The reasoning is at the top of `multisig.js`.

Electrum leaves the xpubs out unless "For hardware device; include xpubs" is
ticked in the transaction's export menu (desktop), so its multisig change is
amber by default, with a note saying that. Android has no such option.

**Oddities** (signed anyway, shown to the person): a path that isn't
m/purpose'/coin'/account'/change/index, a purpose that doesn't match the
script (84' for P2WPKH...), a coin type for another network, a branch other
than 0/1, a hardened or very high index, an account other than the inputs',
change to another script type than the inputs'.

### `lib/codes.js`

`new CodeReader()`: `read(text, bytes)` for each code the camera gives, ->
`{ part: { have, total, added } }` or `{ payload: { encoding, bytes, kind,
chars } }`. BBQr series in any order, each part as often as it comes; other
codes go to `readPayload()`. `DecodeError`, for people: a code of another
series is refused and the series goes on; `reset()` starts over.
`seriesFor(bytes, kind)`: `{ version, encoding, parts }` to show. `lib/bbqr.js`
is a copy of `lib/js/bbqr.js`.

### `lib/descriptor.js`

`accountDescriptor({ script, fingerprint, network, account, xpub })`: an
account's BIP-389 descriptor, with its BIP-380 checksum. `fingerprint` is the
master's; `xpub` the plain xpub or tpub of the account. `script`: `"p2wpkh"`,
`"p2sh-p2wpkh"`, `"p2pkh"`. `descriptorChecksum(text)`, `checkDescriptor(text)`.
No imports: `tools/share_libs.py` can copy it anywhere.

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
signature, and a BIP-341 key-path signature, through gk:crypto's
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
output it spends, so its P2PKH inputs can't be signed from a QR code. Electrum loads both what `signPsbt` gives
back (the signed PSBT, as `electrumQrText(serializePsbt(psbt))`) and the
final transaction (`electrumQrText(finalize(psbt).tx)`).
