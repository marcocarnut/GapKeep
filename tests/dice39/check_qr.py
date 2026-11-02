#!/usr/bin/env python3
"""
Cross-checks the three QR exports dice39 drew in a tests/dice39.txt run,
decoded from the screenshots with zbarimg: SeedQR (word indices), Compact
SeedQR (raw entropy) and the words as text must all be the same phrase,
with a valid BIP-39 checksum, starting with the words the scenario typed.

Usage: check_qr.py <screenshot-dir> <bip39-wordlist.js>
"""
import hashlib
import json
import re
import subprocess
import sys

TYPED = ['alpha', 'already', 'abandon', 'zoo', 'eyebrow', 'neutral',
         'legal', 'winner', 'thank', 'year', 'wave', 'sausage']


def decode(png, binary=False):
    cmd = ['zbarimg', '--quiet', '--raw'] + (['-Sbinary'] if binary else []) + [png]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    # zbarimg ends text with a newline, but not binary data (whose last
    # byte may well be 0x0a)
    return out if binary else out[:-1] if out.endswith(b'\n') else out


def main():
    shots, wordlist_js = sys.argv[1], sys.argv[2]
    words = json.loads(re.search(r'window\.BIP39_WORDS = (\[.*?\]);', open(wordlist_js).read(), re.S).group(1))

    digits = decode(shots + '/05-seedqr.png').decode()
    seedqr = [words[int(digits[i:i + 4])] for i in range(0, len(digits), 4)]

    entropy = decode(shots + '/06-compact.png', binary=True)
    assert len(entropy) == 32, 'compact SeedQR: %d bytes' % len(entropy)
    bits = ''.join('%08d' % int(bin(b)[2:]) for b in entropy)
    bits += '%08d' % int(bin(hashlib.sha256(entropy).digest()[0])[2:])
    compact = [words[int(bits[i:i + 11], 2)] for i in range(0, 264, 11)]

    text = decode(shots + '/07-words.png').decode().split(' ')

    assert seedqr == compact == text, 'QR exports disagree:\n%s\n%s\n%s' % (seedqr, compact, text)
    assert seedqr[:12] == TYPED, 'typed words not verbatim: %s' % seedqr[:12]
    print('dice39 QR exports agree: 24 words, checksum valid, typed words verbatim')


if __name__ == '__main__':
    main()
