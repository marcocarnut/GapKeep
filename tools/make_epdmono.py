#!/usr/bin/env python3
"""
Makes gk:ui's "epdmono" pixel font, src/runtime/fonts/gk_epdmono_*.c: X11's
misc-fixed, 1 bit a pixel, for e-paper panels (docs/EPAPER.md), where
anti-aliased text loses its grey edges. The same font EPDPages uses for its
"mono" (its tools/mkassets.py).

    tools/make_epdmono.py [--compare]

Source: X11 misc-fixed's 6x10, ISO 8859-1, as Debian's xfonts-base
(1:1.0.5+nmu1) installs it, /usr/share/fonts/X11/misc/6x10-ISO8859-1.pcf.gz,
whose SHA-256 must be SOURCES' below. Its licence, in its own COPYRIGHT
property: "Public domain terminal emulator font.  Share and enjoy."
(src/runtime/fonts/LICENCE.misc-fixed).

Sizes: the 6x10 cell at 1x (10 px), and pixel-doubled at 2x (12x20, 20 px)
and 3x (18x30, 30 px): each pixel a square of pixels, never smoothed.
Characters: Basic Latin and Latin-1 (0x20-0x7E, 0xA0-0xFF), which hold the
codex32 and bech32 alphabets; others fall back to Montserrat. Each glyph is
its whole cell (the line height is the cell's), so text lines up in a grid.

--compare also makes misc-fixed's 9x18 and 10x20 at 1x (gk_fixed_*.c), to
compare on a panel; they aren't part of the build. Compared on the rig's
2.9" B/W/R (2026-11-12): 10x20 is finer, 9x18 came out faint (one-pixel
strokes); the 6x10 doubled, two-pixel strokes, reads most solidly, and is
the font EPDPages already uses.

Reads the PCF with Pillow's PcfFontFile.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import gzip
import hashlib
import os
import sys

from PIL import PcfFontFile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'src', 'runtime', 'fonts')
MISC = '/usr/share/fonts/X11/misc/'
SOURCES = {
    '6x10': ('6x10-ISO8859-1.pcf.gz', '2c857cdb3472beb1b27b8f413675e4a71ee9837a242c2ecdf1f001704e17a18b'),
    '9x18': ('9x18-ISO8859-1.pcf.gz', 'ca872b090c75d56547df2d5eae3d9485bd0cd7c2b32dee3a50fc2366f2dc4622'),
    '10x20': ('10x20-ISO8859-1.pcf.gz', '6132084c401a542582127c796ab8b08d11a0dd06801df05cf7e3ada2982eb81b'),
}
RANGES = [(0x20, 0x7E), (0xA0, 0xFF)]
# (font name, source, scale, the Montserrat it falls back to)
FONTS = [
    ('gk_epdmono_10', '6x10', 1, 'gk_montserrat_12'),
    ('gk_epdmono_20', '6x10', 2, 'gk_montserrat_20'),
    ('gk_epdmono_30', '6x10', 3, 'gk_montserrat_28'),
]
COMPARE = [
    ('gk_fixed_9x18', '9x18', 1, 'gk_montserrat_18'),
    ('gk_fixed_10x20', '10x20', 1, 'gk_montserrat_20'),
]


def load(source):
    name, sha = SOURCES[source]
    data = open(MISC + name, 'rb').read()
    got = hashlib.sha256(data).hexdigest()
    if got != sha:
        sys.exit('make_epdmono: %s: SHA-256 %s, expected %s' % (name, got, sha))
    f = PcfFontFile.PcfFontFile(gzip.open(MISC + name), 'iso8859-1')
    assert f.info[b'COPYRIGHT'].startswith(b'Public domain'), f.info[b'COPYRIGHT']
    return f


def cells(f):
    """{code: rows of 0/1, the whole cell}, width, height, descent"""
    out = {}
    width = height = descent = None
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            (dx, _), dst, _, im = f.glyph[c]
            im = im.convert('1')
            w, h = im.size
            if width is None:
                width, height, descent = w, h, dst[3]
            assert (w, h, dx) == (width, height, width), (c, w, h, dx)
            px = im.load()
            out[c] = [[1 if px[x, y] else 0 for x in range(w)] for y in range(h)]
    return out, width, height, descent


def make(name, source, scale, fallback, comment):
    f = load(source)
    glyphs, w, h, descent = cells(f)
    W, H = w * scale, h * scale
    bitmap, dsc = [], []
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            bits = []
            for row in glyphs[c]:
                line = [b for b in row for _ in range(scale)]
                for _ in range(scale):
                    bits += line
            start = len(bitmap)
            for i in range(0, len(bits), 8):
                chunk = bits[i:i + 8] + [0] * (8 - len(bits[i:i + 8]))
                bitmap.append(sum(b << (7 - k) for k, b in enumerate(chunk)))
            dsc.append((start, W, H, -descent * scale))
    lines = []
    lines.append('/*')
    lines.append(' * %s: %s (gk:ui\'s "epdmono"), %dx%d%s, 1 bpp.' % (
        name, comment, W, H, '' if scale == 1 else ', its %dx%d cell pixel-%s' % (
            w, h, 'doubled' if scale == 2 else 'tripled')))
    lines.append(' * Made by tools/make_epdmono.py from X11 misc-fixed %s (%s, SHA-256 %s):' % (
        source, SOURCES[source][0], SOURCES[source][1]))
    lines.append(' * "Public domain terminal emulator font.  Share and enjoy."')
    lines.append(' * (LICENCE.misc-fixed). Do not edit.')
    lines.append(' */')
    lines.append('#include "lvgl/lvgl/lvgl.h"')
    lines.append('')
    lines.append('static LV_ATTRIBUTE_LARGE_CONST const uint8_t glyph_bitmap[] = {')
    for i in range(0, len(bitmap), 16):
        lines.append('    ' + ', '.join('0x%02x' % b for b in bitmap[i:i + 16]) + ',')
    lines.append('};')
    lines.append('')
    lines.append('static const lv_font_fmt_txt_glyph_dsc_t glyph_dsc[] = {')
    lines.append('    {.bitmap_index = 0, .adv_w = 0, .box_w = 0, .box_h = 0, .ofs_x = 0, .ofs_y = 0},')
    for start, bw, bh, oy in dsc:
        lines.append('    {.bitmap_index = %d, .adv_w = %d, .box_w = %d, .box_h = %d, .ofs_x = 0, .ofs_y = %d},'
                     % (start, bw * 16, bw, bh, oy))
    lines.append('};')
    lines.append('')
    lines.append('static const lv_font_fmt_txt_cmap_t cmaps[] = {')
    gid = 1
    for lo, hi in RANGES:
        lines.append('    {.range_start = %d, .range_length = %d, .glyph_id_start = %d, .unicode_list = NULL,'
                     ' .glyph_id_ofs_list = NULL, .list_length = 0, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY},'
                     % (lo, hi - lo + 1, gid))
        gid += hi - lo + 1
    lines.append('};')
    lines.append('')
    lines.append('static const lv_font_fmt_txt_dsc_t font_dsc = {')
    lines.append('    .glyph_bitmap = glyph_bitmap, .glyph_dsc = glyph_dsc, .cmaps = cmaps, .kern_dsc = NULL,')
    lines.append('    .kern_scale = 0, .cmap_num = %d, .bpp = 1, .kern_classes = 0, .bitmap_format = 0,' % len(RANGES))
    lines.append('};')
    lines.append('')
    lines.append('extern const lv_font_t %s;' % fallback)
    lines.append('')
    lines.append('const lv_font_t %s = {' % name)
    lines.append('    .get_glyph_dsc = lv_font_get_glyph_dsc_fmt_txt,')
    lines.append('    .get_glyph_bitmap = lv_font_get_bitmap_fmt_txt,')
    lines.append('    .line_height = %d,' % H)
    lines.append('    .base_line = %d,' % (descent * scale))
    lines.append('    .subpx = LV_FONT_SUBPX_NONE,')
    lines.append('    .underline_position = -1,')
    lines.append('    .underline_thickness = %d,' % scale)
    lines.append('    .dsc = &font_dsc,')
    lines.append('    .fallback = &%s,' % fallback)
    lines.append('    .user_data = NULL,')
    lines.append('};')
    path = os.path.join(OUT, name + '.c')
    with open(path, 'w') as out:
        out.write('\n'.join(lines) + '\n')
    print('make_epdmono: %s (%dx%d)' % (path, W, H))


def main():
    for name, source, scale, fallback in FONTS:
        make(name, source, scale, fallback, 'misc-fixed 6x10')
    if '--compare' in sys.argv[1:]:
        for name, source, scale, fallback in COMPARE:
            make(name, source, scale, fallback, 'misc-fixed ' + source + ' (for comparing)')


if __name__ == '__main__':
    main()
