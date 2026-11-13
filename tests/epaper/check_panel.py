#!/usr/bin/env python3
"""
Checks the e-paper panels' pictures from a tests/epaper.txt run (the
simulator's "epaper shot"): the QR code on each decodes, with zbarimg, to
the share tests/apps/epapertest wrote there; the share's title is red (the
panel's red plane); panel 1 kept its picture while panel 2 was written,
and showed the same once written again.

Usage: check_panel.py <screenshot-dir>

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import re
import struct
import subprocess
import sys
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')


def shares():
    src = open(os.path.join(ROOT, 'tests', 'apps', 'epapertest', 'main.js')).read()
    block = re.search(r'SHARES = \[(.*?)\]', src, re.S).group(1)
    return re.findall(r'"([^"]+)"', block)


def decode(png):
    out = subprocess.run(['zbarimg', '--quiet', '--raw', png], capture_output=True).stdout
    return out.decode().strip()


def pixels(png):
    """An 8-bit RGB PNG without interlacing, as the simulator writes it."""
    data = open(png, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', png
    pos, idat, w = 8, b'', 0
    while pos < len(data):
        n, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b'IHDR':
            w, h, depth, colour = struct.unpack('>IIBB', body[:10])
            assert depth == 8 and colour == 2, png
        elif kind == b'IDAT':
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat)
    row = 1 + 3 * w
    assert all(raw[y * row] == 0 for y in range(len(raw) // row)), 'filtered rows: ' + png
    return [raw[y * row + 1:(y + 1) * row] for y in range(len(raw) // row)]


def red_pixels(png):
    n = 0
    for line in pixels(png):
        for i in range(0, len(line), 3):
            r, g, b = line[i], line[i + 1], line[i + 2]
            n += r > 150 and g < 100 and b < 100
    return n


def main():
    d = sys.argv[1]
    want = shares()
    problems = []
    for name, share in [('01-panel1', 0), ('02-panel2', 1), ('03-panel1-again', 0), ('04-panel1-rewritten', 0)]:
        png = os.path.join(d, name + '.png')
        got = decode(png)
        if got != want[share]:
            problems.append('%s: the QR code reads %r, not share %d' % (name, got, share + 1))
        if red_pixels(png) < 50:
            problems.append('%s: no red title' % name)
    first = open(os.path.join(d, '01-panel1.png'), 'rb').read()
    if open(os.path.join(d, '03-panel1-again.png'), 'rb').read() != first:
        problems.append('panel 1 changed while panel 2 was written')
    if open(os.path.join(d, '04-panel1-rewritten.png'), 'rb').read() != first:
        problems.append('panel 1 written again differs from the first time')
    if problems:
        print('check_panel: ' + '\n  '.join(problems))
        sys.exit(1)
    print('check_panel: the panels show their shares (QR codes decoded), red titles, panel 1 unchanged by the swap')


if __name__ == '__main__':
    main()
