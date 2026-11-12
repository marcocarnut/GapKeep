#!/usr/bin/env python3
"""
Checks the panel pictures of a tests/epaper_rotate.txt run: for each mount
rotation (epaper_rotate 0, 90, 180, 270) and each of the app's
orientations (landscape, portrait, each flipped or not), the page
tests/apps/epapertest draws (a black square in its top left corner, a red
one in its top right, a QR code of its size) must show as docs/EPAPER.md
says: upright for the panel's viewer when the app's orientation is the
panel's as mounted, turned a quarter turn counter-clockwise when it isn't
(the viewer turns the panel clockwise to read it), and a half turn more
when flipped. The QR code must read the page's size.

The pictures (the simulator's "epaper shot") are the panel as its viewer
sees it, mounted.

Usage: check_rotation.py <screenshot-dir>

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_panel import pixels  # noqa: E402

MARGIN = 8      # the shot's white border
NATIVE = (128, 296)     # the 2.9" B/W/R, width x height


def corners(png):
    rows = pixels(png)
    h, w = len(rows) - 2 * MARGIN, len(rows[0]) // 3 - 2 * MARGIN
    counts = {}
    for name, (cx, cy) in {'tl': (0, 0), 'tr': (w - 40, 0), 'bl': (0, h - 40), 'br': (w - 40, h - 40)}.items():
        black = red = 0
        for y in range(cy, cy + 40):
            line = rows[MARGIN + y]
            for x in range(cx, cx + 40):
                r, g, b = line[3 * (MARGIN + x):3 * (MARGIN + x) + 3]
                black += r < 80 and g < 80 and b < 80
                red += r > 150 and g < 100 and b < 100
        counts[name] = (black, red)
    black = max(counts, key=lambda k: counts[k][0])
    red = max(counts, key=lambda k: counts[k][1])
    return (w, h), black, red


# the page turned k quarter turns counter-clockwise: where its top left
# (black) and top right (red) corners go
TURNED = {0: ('tl', 'tr'), 1: ('bl', 'tl'), 2: ('br', 'bl'), 3: ('tr', 'br')}


def main():
    d = sys.argv[1]
    problems = []
    for rotate in (0, 90, 180, 270):
        m = rotate // 90
        tall = (NATIVE[1] > NATIVE[0]) != (m % 2 == 1)        # the panel as mounted
        view = NATIVE if m % 2 == 0 else NATIVE[::-1]
        for key, portrait, flip in (('q', False, False), ('e', False, True), ('y', True, False), ('u', True, True)):
            name = 'r%d-%s' % (rotate, key)
            png = os.path.join(d, name + '.png')
            size, black, red = corners(png)
            k = (1 if portrait != tall else 0) + (2 if flip else 0)
            want = TURNED[k]
            page = (296, 128) if not portrait else (128, 296)
            if size != view:
                problems.append('%s: the panel is %dx%d as mounted, not %dx%d' % (name, size[0], size[1], *view))
            if (black, red) != want:
                problems.append('%s: black square %s, red %s; expected %s, %s (the page turned %d quarter '
                                'turns counter-clockwise)' % (name, black, red, want[0], want[1], k))
            got = subprocess.run(['zbarimg', '--quiet', '--raw', png], capture_output=True, text=True).stdout.strip()
            if got != '%dx%d' % page:
                problems.append('%s: the QR code reads %r, not the page size %dx%d' % (name, got, *page))
    if problems:
        print('check_rotation:\n  ' + '\n  '.join(problems))
        sys.exit(1)
    print('check_rotation: 4 mount rotations x 4 orientations, each as expected')


if __name__ == '__main__':
    main()
