#!/usr/bin/env python3
"""
Checks the pictures of a tests/epaper_shares.txt run: each panel's QR code
decodes (zbarimg) to what dice39 and codex32 wrote there (BIP-39's
all-"abandon" test phrase, split 2 of 3 with identifier TEST: three
different shares; its SeedQR and words), the 2.9" B/W/R's titles are red
and the B/W panels' have none; and in "Panel only" the screen showed no QR
code, while without it the share's code was on the screen.

Usage: check_shares.py <screenshot-dir>

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_panel import decode, red_pixels  # noqa: E402

SEEDQR = '0000' * 11 + '0003'          # abandon x 11, about: word indexes 0 and 3
WORDS = 'abandon ' * 11 + 'about'


def main():
    d = sys.argv[1]
    png = lambda name: os.path.join(d, name + '.png')  # noqa: E731
    problems = []
    shares = [decode(png('share%d' % i)) for i in (1, 2, 3)]
    for i, s in enumerate(shares, 1):
        if not re.fullmatch(r'MS12TEST[02-9AC-HJ-NP-Z]{40}', s):
            problems.append('share%d: the QR code reads %r, not a 12-word share of TEST' % (i, s))
    if len(set(shares)) != 3:
        problems.append('the three panels do not hold three different shares')
    for name in ('share3-213', 'share3-42'):
        if decode(png(name)) != shares[2]:
            problems.append('%s: not share 3' % name)
        if red_pixels(png(name)):
            problems.append('%s: red on a black and white panel' % name)
    for name, want in (('seedqr', SEEDQR), ('codex32-seedqr', SEEDQR), ('words', WORDS), ('codex32-words', WORDS)):
        if decode(png(name)) != want:
            problems.append('%s: the QR code is not the test phrase\'s' % name)
    for name in ('share1', 'share2', 'share3', 'seedqr', 'compact', 'words', 'codex32-seedqr'):
        if red_pixels(png(name)) < 50:
            problems.append('%s: no red title' % name)
    # the screen: no QR code in "Panel only", the share's without it
    for name in ('02-split-panel-only', '03-writer', '04-written', '05-checked', '06-cancelled', '11-seed-written',
                 '13-codex32-checked'):
        if decode(png(name)):
            problems.append('%s: a QR code on the screen in "Panel only"' % name)
    if decode(png('08-on-screen')) != shares[2]:
        problems.append('08-on-screen: share 3 is not on the screen without "Panel only"')
    if problems:
        print('check_shares: ' + '\n  '.join(problems))
        sys.exit(1)
    print('check_shares: the panels hold three different shares of TEST, the SeedQR and the words; '
          'red titles on the B/W/R; no QR code on the screen in "Panel only"')


if __name__ == '__main__':
    main()
