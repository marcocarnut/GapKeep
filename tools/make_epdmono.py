#!/usr/bin/env python3
"""
Makes gk:ui's "epdmono" pixel font family, src/runtime/fonts/gk_epdmono_*.c:
bitmap fonts, 1 bit a pixel, for e-paper panels (docs/EPAPER.md), where
anti-aliased text loses its grey edges. Each size is a design of its own,
never a scaled one.

    tools/make_epdmono.py [--compare]

Sources (each file's SHA-256 is checked against SOURCES below):

- 10: X11's misc-fixed 6x10, ISO 8859-1, as Debian's xfonts-base
  (1:1.0.5+nmu1) installs it: /usr/share/fonts/X11/misc/6x10-ISO8859-1.pcf.gz.
  Public domain ("Public domain terminal emulator font.  Share and enjoy.",
  its COPYRIGHT property: LICENCE.misc-fixed). EPDPages' "mono".
- The larger sizes: Terminus Font's bold, by Dimitar Toshkov Zhekov, as
  Ubuntu's console-setup-linux (1.226ubuntu1.1) installs it, its Lat15 PSF
  files (/usr/share/consolefonts/Lat15-TerminusBold*.psf.gz: every
  Latin-1 character). Under the SIL Open Font License 1.1, with the
  Reserved Font Name "Terminus Font" (LICENCE.terminus): converted to LVGL's
  format these are a Modified Version, so they don't carry that name: they
  are "epdmono".

Characters: Basic Latin and Latin-1 (0x20-0x7E, 0xA0-0xFF), which hold the
codex32 and bech32 alphabets; others fall back to Montserrat. Each glyph is
its whole cell, so text lines up in a grid.

Chosen on the rig's 2.9" B/W/R (2026-11-12, tests/epaper_fonts_hw.txt), with
the rig's camera: Terminus bold reads clearly at every size; its regular
weight (one-pixel strokes) came out faint; the 6x10 doubled and tripled
(epdmono 20 and 30 before) read, but blocky. Its sizes 14, 16, 20, 24 and
32, about 31 KB of bitmaps with 10.

--compare also makes candidates (gk_epdcmp_*.c: Terminus regular and bold,
misc-fixed 6x10 doubled and tripled) to compare on a panel; they aren't part
of the build.

Reads PCF with Pillow's PcfFontFile, PSF (1 and 2, with their Unicode
tables) itself.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import gzip
import hashlib
import os
import struct
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'src', 'runtime', 'fonts')
MISC = '/usr/share/fonts/X11/misc/'
CONSOLE = '/usr/share/consolefonts/'
SOURCES = {
    'fixed6x10': (MISC + '6x10-ISO8859-1.pcf.gz', '2c857cdb3472beb1b27b8f413675e4a71ee9837a242c2ecdf1f001704e17a18b'),
    'ter16': (CONSOLE + 'Lat15-Terminus16.psf.gz', '0b77babe7e18271f5371228996234eba9f688d2d08ec2dcec39ede2c928768d9'),
    'ter20': (CONSOLE + 'Lat15-Terminus20x10.psf.gz', '6c19641c0752becac266f9667baac35b3f6f60e2e5b2606ebc3bbca806402b89'),
    'ter24': (CONSOLE + 'Lat15-Terminus24x12.psf.gz', '36d15d75ae1e7316211d661c1412ed47bc0873d0dac5c386a7b807f6b47e3429'),
    'ter32': (CONSOLE + 'Lat15-Terminus32x16.psf.gz', '49aeb220b17debae165cb978443fa58f4470edacb3545831b658df6baaa667b6'),
    'terb14': (CONSOLE + 'Lat15-TerminusBold14.psf.gz', 'fd21e24aadfd0db1bb246c7511ad70c29204709cb474442147a431036d40c58f'),
    'terb16': (CONSOLE + 'Lat15-TerminusBold16.psf.gz', 'b00ebf7c8e273e191e8bcff5b4b77ea991379033836c70adf725acf039bb4107'),
    'terb18': (CONSOLE + 'Lat15-TerminusBold18x10.psf.gz', '05ccbcfba443c140d85438ea943da18bf6baba86651477be9443f2d580ba1fde'),
    'terb20': (CONSOLE + 'Lat15-TerminusBold20x10.psf.gz', 'b294dc787aeb72e4bfb3e516a2bbd463ad063489491c41895f36f526f9277642'),
    'terb22': (CONSOLE + 'Lat15-TerminusBold22x11.psf.gz', '5f6a964fe4c857013d29d88f4ccbdc8b04fc411bc1ce1d73b4ecacc71196d643'),
    'terb24': (CONSOLE + 'Lat15-TerminusBold24x12.psf.gz', 'cab8b4401658e2b12b24a2ff27b290f50aad3738297fefc24b10aa89e078607b'),
    'terb28': (CONSOLE + 'Lat15-TerminusBold28x14.psf.gz', 'cae0b6e2db9df1a5733ce53775b765c665006e8b2245bebc46919f90834f38b2'),
    'terb32': (CONSOLE + 'Lat15-TerminusBold32x16.psf.gz', 'aa39498a6b3c73744e3c49b9ed77402610cb0262d44c3d38c6f96fe9e3d4e6dd'),
}
RANGES = [(0x20, 0x7E), (0xA0, 0xFF)]
# (font name, source, scale, the Montserrat it falls back to)
FONTS = [
    ('gk_epdmono_10', 'fixed6x10', 1, 'gk_montserrat_12'),
    ('gk_epdmono_14', 'terb14', 1, 'gk_montserrat_14'),
    ('gk_epdmono_16', 'terb16', 1, 'gk_montserrat_16'),
    ('gk_epdmono_20', 'terb20', 1, 'gk_montserrat_20'),
    ('gk_epdmono_24', 'terb24', 1, 'gk_montserrat_24'),
    ('gk_epdmono_32', 'terb32', 1, 'gk_montserrat_32'),
]
COMPARE = [
    ('gk_epdcmp_r16', 'ter16', 1, 'gk_montserrat_16'),
    ('gk_epdcmp_r20', 'ter20', 1, 'gk_montserrat_20'),
    ('gk_epdcmp_r24', 'ter24', 1, 'gk_montserrat_24'),
    ('gk_epdcmp_r32', 'ter32', 1, 'gk_montserrat_32'),
    ('gk_epdcmp_b14', 'terb14', 1, 'gk_montserrat_14'),
    ('gk_epdcmp_b16', 'terb16', 1, 'gk_montserrat_16'),
    ('gk_epdcmp_b18', 'terb18', 1, 'gk_montserrat_18'),
    ('gk_epdcmp_b20', 'terb20', 1, 'gk_montserrat_20'),
    ('gk_epdcmp_b22', 'terb22', 1, 'gk_montserrat_22'),
    ('gk_epdcmp_b24', 'terb24', 1, 'gk_montserrat_24'),
    ('gk_epdcmp_b28', 'terb28', 1, 'gk_montserrat_28'),
    ('gk_epdcmp_b32', 'terb32', 1, 'gk_montserrat_32'),
    ('gk_epdcmp_d20', 'fixed6x10', 2, 'gk_montserrat_20'),
    ('gk_epdcmp_d30', 'fixed6x10', 3, 'gk_montserrat_28'),
]


def read_source(source):
    path, sha = SOURCES[source]
    data = open(path, 'rb').read()
    got = hashlib.sha256(data).hexdigest()
    if got != sha:
        sys.exit('make_epdmono: %s: SHA-256 %s, expected %s' % (path, got, sha))
    return path, gzip.decompress(data)


def pcf_cells(source):
    """{code: rows of 0/1 (the whole cell)}, width, height"""
    from PIL import PcfFontFile
    path, _ = read_source(source)
    f = PcfFontFile.PcfFontFile(gzip.open(path), 'iso8859-1')
    assert f.info[b'COPYRIGHT'].startswith(b'Public domain'), f.info[b'COPYRIGHT']
    out = {}
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            (dx, _), _, _, im = f.glyph[c]
            im = im.convert('1')
            px = im.load()
            out[c] = [[1 if px[x, y] else 0 for x in range(im.size[0])] for y in range(im.size[1])]
    w, h = len(out[0x41][0]), len(out[0x41])
    return out, w, h


def psf_cells(source):
    """the same from a PSF 1 or 2 file, by its Unicode table"""
    _, d = read_source(source)
    cmap = {}
    if d[:4] == b'\x72\xb5\x4a\x86':
        _, hs, flags, n, cs, h, w = struct.unpack('<7I', d[4:32])
        assert flags & 1, 'no Unicode table'
        glyphs, uni, i = d[hs:hs + n * cs], d[hs + n * cs:], 0
        for g in range(n):
            j = uni.index(b'\xff', i)
            for ch in uni[i:j].split(b'\xfe')[0].decode('utf-8'):
                cmap.setdefault(ord(ch), g)
            i = j + 1
    else:
        assert d[:2] == b'\x36\x04', 'not a PSF file'
        mode, cs = d[2], d[3]
        n, w, h = 512 if mode & 1 else 256, 8, cs
        assert mode & 2, 'no Unicode table'
        glyphs, uni, k, g = d[4:4 + n * cs], d[4 + n * cs:], 0, 0
        while k + 1 < len(uni) and g < n:
            v = uni[k] | uni[k + 1] << 8
            k += 2
            if v == 0xFFFF:
                g += 1
            elif v == 0xFFFE:
                while (uni[k] | uni[k + 1] << 8) != 0xFFFF:
                    k += 2
            else:
                cmap.setdefault(v, g)
    rb = (w + 7) // 8
    out = {}
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            g = glyphs[cmap[c] * cs:(cmap[c] + 1) * cs]
            out[c] = [[(g[y * rb + x // 8] >> (7 - x % 8)) & 1 for x in range(w)] for y in range(h)]
    return out, w, h


def descent(cells, h):
    """rows below the baseline: under the bottom of 'x'"""
    rows = [y for y, row in enumerate(cells[ord('x')]) if any(row)]
    return h - 1 - rows[-1]


def make(name, source, scale, fallback):
    cells, w, h = (pcf_cells if source.startswith('fixed') else psf_cells)(source)
    down = descent(cells, h)
    W, H = w * scale, h * scale
    bitmap, dsc = [], []
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            bits = []
            for row in cells[c]:
                line = [b for b in row for _ in range(scale)]
                for _ in range(scale):
                    bits += line
            start = len(bitmap)
            for i in range(0, len(bits), 8):
                chunk = bits[i:i + 8] + [0] * (8 - len(bits[i:i + 8]))
                bitmap.append(sum(b << (7 - k) for k, b in enumerate(chunk)))
            dsc.append((start, W, H, -down * scale))
    path, sha = SOURCES[source]
    if source.startswith('fixed'):
        origin = ['X11 misc-fixed %dx%d (%s, SHA-256 %s):' % (w, h, os.path.basename(path), sha),
                  '"Public domain terminal emulator font.  Share and enjoy." (LICENCE.misc-fixed).']
    else:
        origin = ['Terminus Font %s %dx%d by Dimitar Toshkov Zhekov (%s, SHA-256 %s),' % (
            'bold' if 'Bold' in path else 'regular', w, h, os.path.basename(path), sha),
            'converted: a Modified Version under the SIL Open Font License 1.1, which',
            'therefore doesn\'t use the Reserved Font Name (LICENCE.terminus).']
    lines = ['/*',
             ' * %s: gk:ui\'s "epdmono" (or a candidate for it), %dx%d%s, 1 bpp.' % (
                 name, W, H, '' if scale == 1 else ', its %dx%d cell scaled %dx' % (w, h, scale)),
             ' * Made by tools/make_epdmono.py from'] + [' * ' + o for o in origin] + [
             ' * Do not edit.', ' *', ' * SPDX-License-Identifier: %s' % (
                 'LicenseRef-PublicDomain' if source.startswith('fixed') else 'OFL-1.1'), ' */',
             '#include "lvgl/lvgl/lvgl.h"', '',
             'static LV_ATTRIBUTE_LARGE_CONST const uint8_t glyph_bitmap[] = {']
    for i in range(0, len(bitmap), 16):
        lines.append('    ' + ', '.join('0x%02x' % b for b in bitmap[i:i + 16]) + ',')
    lines += ['};', '', 'static const lv_font_fmt_txt_glyph_dsc_t glyph_dsc[] = {',
              '    {.bitmap_index = 0, .adv_w = 0, .box_w = 0, .box_h = 0, .ofs_x = 0, .ofs_y = 0},']
    for start, bw, bh, oy in dsc:
        lines.append('    {.bitmap_index = %d, .adv_w = %d, .box_w = %d, .box_h = %d, .ofs_x = 0, .ofs_y = %d},'
                     % (start, bw * 16, bw, bh, oy))
    lines += ['};', '', 'static const lv_font_fmt_txt_cmap_t cmaps[] = {']
    gid = 1
    for lo, hi in RANGES:
        lines.append('    {.range_start = %d, .range_length = %d, .glyph_id_start = %d, .unicode_list = NULL,'
                     ' .glyph_id_ofs_list = NULL, .list_length = 0, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY},'
                     % (lo, hi - lo + 1, gid))
        gid += hi - lo + 1
    lines += ['};', '', 'static const lv_font_fmt_txt_dsc_t font_dsc = {',
              '    .glyph_bitmap = glyph_bitmap, .glyph_dsc = glyph_dsc, .cmaps = cmaps, .kern_dsc = NULL,',
              '    .kern_scale = 0, .cmap_num = %d, .bpp = 1, .kern_classes = 0, .bitmap_format = 0,' % len(RANGES),
              '};', '', 'extern const lv_font_t %s;' % fallback, '',
              'const lv_font_t %s = {' % name,
              '    .get_glyph_dsc = lv_font_get_glyph_dsc_fmt_txt,',
              '    .get_glyph_bitmap = lv_font_get_bitmap_fmt_txt,',
              '    .line_height = %d,' % H, '    .base_line = %d,' % (down * scale),
              '    .subpx = LV_FONT_SUBPX_NONE,', '    .underline_position = -1,',
              '    .underline_thickness = %d,' % max(1, scale), '    .dsc = &font_dsc,',
              '    .fallback = &%s,' % fallback, '    .user_data = NULL,', '};']
    out = os.path.join(OUT, name + '.c')
    with open(out, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print('make_epdmono: %s.c (%dx%d, %d bytes of bitmaps)' % (name, W, H, len(bitmap)))


def main():
    for args in FONTS:
        make(*args)
    if '--compare' in sys.argv[1:]:
        for args in COMPARE:
            make(*args)


if __name__ == '__main__':
    main()
