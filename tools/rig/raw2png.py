#!/usr/bin/env python3
"""
A raw frame of the rig's Pi Camera ("serialraw <name>": <name>.raw, RAW8
Bayer, and <name>.raw.json with its width, height and stride) as a PNG to
look at: each 2x2 Bayer tile one RGB pixel (BGGR, as src/camera/picamera.cpp
reads the buffer), half the size, grey-world white balance, stretched to
the frame's 1st..99th percentile, gamma 2.2.

Usage: raw2png.py <name>.raw [out.png]     (default: <name>.png)

SPDX-License-Identifier: GPL-3.0-or-later
"""
import json
import struct
import sys
import zlib


def png(path, w, h, rgb):
    raw = b''.join(b'\0' + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else src[:-4] + '.png'
    info = json.load(open(src + '.json'))
    w, h = info['width'], info['height']
    stride = info.get('stride', w)
    data = open(src, 'rb').read()
    W, H = w // 2, h // 2
    planes = [[], [], []]
    for y in range(H):
        r0 = data[2 * y * stride:2 * y * stride + w]
        r1 = data[(2 * y + 1) * stride:(2 * y + 1) * stride + w]
        for x in range(W):
            b, g1, g2, r = r0[2 * x], r0[2 * x + 1], r1[2 * x], r1[2 * x + 1]
            planes[0].append(r)
            planes[1].append((g1 + g2) / 2)
            planes[2].append(b)
    means = [sum(p) / len(p) or 1 for p in planes]
    m = sum(means) / 3
    for c in range(3):
        k = m / means[c]
        planes[c] = [v * k for v in planes[c]]
    allv = sorted(v for p in planes for v in p[::7])
    lo, hi = allv[len(allv) // 100], allv[len(allv) * 99 // 100]
    hi = hi if hi > lo else lo + 1
    rgb = bytearray(W * H * 3)
    for i in range(W * H):
        for c in range(3):
            v = (planes[c][i] - lo) / (hi - lo)
            v = 0 if v < 0 else 1 if v > 1 else v
            rgb[3 * i + c] = int(255 * v ** (1 / 2.2))
    png(out, W, H, rgb)
    print('raw2png: %s, %dx%d' % (out, W, H))


if __name__ == '__main__':
    main()
