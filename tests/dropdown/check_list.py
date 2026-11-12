#!/usr/bin/env python3
"""
Checks the screenshots of tests/dropdown.txt: the REPL's "Examples…"
dropdown, at the right of the screen, open. Its list must end inside the
screen (the screen's background shows right of it), and show a scrollbar
(it has more options than fit).

Usage: check_list.py <output-dir>

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import sys

from PIL import Image

SHOTS = ['01-open-keys', '02-scrolled', '03-open-mouse']


def lum(p):
    return p[0] + p[1] + p[2]


def check(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    bg = im.getpixel((w - 1, h - 1))           # the screen, bottom right
    # a row inside the list (under the control, 37 px tall at the top)
    rows = range(90, min(h, 300))
    y = 150
    xs = [x for x in range(w) if im.getpixel((x, y)) != bg]
    if not xs:
        return 'no list at y=%d' % y
    right = max(xs)
    if right >= w - 1:
        return 'the list runs past the right edge (x=%d of %d)' % (right, w)
    # the list's own background, left of where a scrollbar goes
    lst = im.getpixel((right - 3, y))
    # the scrollbar: grey, lighter than the list, in a narrow band at its
    # right, unbroken over at least 20 rows (text is shorter, the selected
    # option is coloured)
    def is_bar(p):
        return lum(p) > lum(lst) + 20 and max(p) - min(p) < 16

    bar = 0
    for x in range(right - 14, right - 3):
        run = 0
        for yy in rows:
            run = run + 1 if is_bar(im.getpixel((x, yy))) else 0
            bar = max(bar, run)
    if bar < 20:
        return 'no scrollbar at the list\'s right (x %d..%d)' % (right - 14, right - 3)
    return None


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    failed = 0
    for name in SHOTS:
        path = os.path.join(sys.argv[1], name + '.png')
        err = check(path)
        if err:
            print('%s: %s' % (path, err))
            failed = 1
        else:
            print('%s: the list is on the screen, with a scrollbar' % path)
    return failed


if __name__ == '__main__':
    sys.exit(main())
