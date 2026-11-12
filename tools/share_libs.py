#!/usr/bin/env python3
"""
Copies the JavaScript libraries one app shares with another.

An app imports only its own files (docs/APPS.md), so an app that builds on
another app's library carries a copy of it. Each library has one home, the
app it was written for, or lib/js/ for libraries written for no app in
particular (lib/js/README.md: the Bitcoin libraries are in lib/js/bitcoin/);
the copies below are made from it byte for byte, and never edited by hand.

Usage:
  tools/share_libs.py           copy (after changing a library at home)
  tools/share_libs.py --check   exit 1 if a copy differs from its home
                                (tools/run_sim_tests.sh runs this)

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The Bitcoin libraries (lib/js/bitcoin/), as each app lays them out: they
# go to the app's lib/ (psbt/ inside it), the BIP-39 wordlist they import
# to its vendor/
BITCOIN = ["bip32.js", "bip39.js", "combine.js", "crypto.js", "descriptor.js", "keys.js", "multisig.js",
           "sighash.js", "sign.js", "text.js"] + ["psbt/" + f for f in (
    "analyze.js", "basen.js", "bech32.js", "bytes.js", "hashes.js", "psbt.js", "script.js", "transport.js", "tx.js")]


def bitcoin(app, files):
    return [("lib/js/bitcoin/" + f, "apps/%s/lib/%s" % (app, f)) for f in files]


# (home, copy), relative to the repository, in order: a copy made here may
# be the home of a later one
COPIES = (
    [("apps/codex32/lib/codex32.js", "apps/signer/lib/codex32.js"),
       ("apps/codex32/lib/messages.js", "apps/signer/lib/codex32messages.js"),
       ("apps/codex32/vendor/codex32.js", "apps/signer/vendor/codex32.js"),
       ("apps/codex32/vendor/recover.js", "apps/signer/vendor/recover.js"),
       ("apps/codex32/vendor/wordlist.js", "apps/signer/vendor/wordlist.js"),
       # the wordlist lib/js/bitcoin/bip39.js imports, at home
       ("apps/codex32/vendor/wordlist.js", "lib/js/vendor/wordlist.js"),
       ("apps/codex32/LICENSE-dice39.txt", "apps/signer/LICENSE-dice39.txt"),
       ("lib/js/bbqr.js", "apps/signer/lib/bbqr.js")]
    + bitcoin("signer", BITCOIN)
    # dice39 shows the account's public key with BIP-39, BIP-32 and
    # descriptors, and what they import
    + bitcoin("dice39", ["bip39.js", "bip32.js", "crypto.js", "descriptor.js",
                         "psbt/bytes.js", "psbt/basen.js", "psbt/hashes.js"])
    # the REPL's btc (loaded when the code first says btc), and what it imports
    + bitcoin("repl", ["btc.js", "bip32.js", "bip39.js", "crypto.js", "descriptor.js", "keys.js", "text.js",
                       "psbt/basen.js", "psbt/bech32.js", "psbt/bytes.js", "psbt/hashes.js", "psbt/script.js"])
    + [("apps/codex32/vendor/wordlist.js", "apps/repl/vendor/wordlist.js"),
       ("apps/codex32/LICENSE-dice39.txt", "apps/repl/LICENSE-dice39.txt")]
    # writing to an e-paper panel: dice39's shares, and both apps' seed QR codes
    + [("apps/dice39/lib/epaper.js", "apps/codex32/lib/epaper.js"),
       ("apps/dice39/lib/epaperlayout.js", "apps/codex32/lib/epaperlayout.js")]
)

def read(path):
    with open(os.path.join(ROOT, path), "rb") as f:
        return f.read()


def main():
    check = "--check" in sys.argv[1:]
    stale = 0
    for home, copy in COPIES:
        data = read(home)
        target = os.path.join(ROOT, copy)
        current = read(copy) if os.path.exists(target) else None
        if current == data:
            continue
        if check:
            print("differs from %s: %s" % (home, copy))
            stale += 1
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(data)
            print("copied %s -> %s" % (home, copy))
    if check:
        if stale:
            print("run tools/share_libs.py to copy them again")
            return 1
        print("%d shared files up to date" % len(COPIES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
