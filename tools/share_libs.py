#!/usr/bin/env python3
"""
Copies the JavaScript libraries one app shares with another.

An app imports only its own files (docs/APPS.md), so an app that builds on
another app's library carries a copy of it. Each library has one home, the
app it was written for, or lib/js/ for libraries written for no app in
particular (lib/js/README.md); the copies below are made from it byte for
byte, and never edited by hand.

Usage:
  tools/share_libs.py           copy (after changing a library at home)
  tools/share_libs.py --check   exit 1 if a copy differs from its home
                                (tools/run_sim_tests.sh runs this)
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (home, copy), relative to the repository
COPIES = (
    [("apps/codex32/lib/codex32.js", "apps/signer/lib/codex32.js"),
       ("apps/codex32/vendor/codex32.js", "apps/signer/vendor/codex32.js"),
       ("apps/codex32/vendor/recover.js", "apps/signer/vendor/recover.js"),
       ("apps/codex32/vendor/wordlist.js", "apps/signer/vendor/wordlist.js"),
       ("apps/codex32/LICENSE-dice39.txt", "apps/signer/LICENSE-dice39.txt")]
    # dice39 shows the account's public key with the signer's BIP-39 and
    # BIP-32, and what they import
    + [("apps/signer/lib/" + f, "apps/dice39/lib/" + f) for f in ("bip39.js", "bip32.js", "crypto.js")]
    + [("apps/signer/lib/psbt/" + f, "apps/dice39/lib/psbt/" + f) for f in ("bytes.js", "basen.js", "hashes.js")]
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
