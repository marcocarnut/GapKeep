#!/usr/bin/env python3
"""
Compares a screenshot with its reference, pixel for pixel (the simulator's
match QEMU's), for tests/i18n_qps.txt.

Usage: check_shot.py <reference.png> <screenshot.png> [--record]
  --record   copy the screenshot over the reference (after looking at it:
             when the fonts or the launcher change)
"""
import sys

from PIL import Image, ImageChops


def main():
    args = [a for a in sys.argv[1:] if a != '--record']
    if len(args) != 2:
        sys.exit(__doc__)
    ref, shot = args
    if '--record' in sys.argv:
        # compressed: the screenshots are written without it (900 KB)
        Image.open(shot).convert('RGB').save(ref, optimize=True)
        print('recorded %s' % ref)
        return 0
    a = Image.open(ref).convert('RGB')
    b = Image.open(shot).convert('RGB')
    if a.size != b.size:
        print('%s: %dx%d, the reference is %dx%d' % (shot, b.size[0], b.size[1], a.size[0], a.size[1]))
        return 1
    box = ImageChops.difference(a, b).getbbox()
    if box is None:
        print('%s: as %s' % (shot, ref))
        return 0
    diff = sum(1 for p in ImageChops.difference(a, b).crop(box).getdata() if p != (0, 0, 0))
    print('%s: %d pixels differ from %s, within %s' % (shot, diff, ref, box))
    return 1


if __name__ == '__main__':
    sys.exit(main())
