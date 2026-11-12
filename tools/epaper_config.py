#!/usr/bin/env python3
"""
Checks an e-paper panel's configuration given to the build (make EPAPER=...
in src/Makefile for sealed kernels, sim/Makefile for the simulator), with
the rules gapkeep.txt's keys follow (src/runtime/epd.cpp, docs/EPAPER.md),
and prints it as compiler flags (-DGK_EPAPER="..." ...). On a refused
value: the reason on stderr, nothing on stdout, exit status 1.

Usage: epaper_config.py EPAPER=<model> [EPAPER_CS=ce0|ce1] [EPAPER_DC=<gpio>]
                        [EPAPER_RST=<gpio>] [EPAPER_BUSY=<gpio>] [EPAPER_SPI_KHZ=<khz>]
                        [EPAPER_ROTATE=0|90|180|270]

The models are those of Models[] in src/runtime/epd.cpp.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KEYS = ['EPAPER', 'EPAPER_CS', 'EPAPER_DC', 'EPAPER_RST', 'EPAPER_BUSY', 'EPAPER_SPI_KHZ', 'EPAPER_ROTATE']
DEFAULTS = {'EPAPER_DC': 25, 'EPAPER_RST': 17, 'EPAPER_BUSY': 24}


def models():
    src = open(os.path.join(ROOT, 'src', 'runtime', 'epd.cpp'), encoding='utf-8').read()
    table = src[src.index('static const TGkEPDModel Models[]'):]
    table = table[:table.index('};')]
    return re.findall(r'^\s*\{"([a-z0-9.-]+)",', table, re.M)


def pin_ok(n):
    # GkEPDPinUsable(): the header's GPIOs, not SPI0's nor the serial port's
    return 2 <= n <= 27 and not 7 <= n <= 11 and n not in (14, 15)


def fail(msg):
    sys.stderr.write('EPAPER: %s\n' % msg)
    sys.exit(1)


def main():
    given = {}
    for arg in sys.argv[1:]:
        key, sep, value = arg.partition('=')
        if not sep or key not in KEYS:
            fail('%s: unknown (%s)' % (arg, ', '.join(KEYS)))
        given[key] = value.strip()
    names = models()
    if 'EPAPER' not in given:
        fail('EPAPER=<model> is needed with %s' % ', '.join(k for k in given))
    if given['EPAPER'] not in names:
        fail('EPAPER=%s: one of %s expected' % (given['EPAPER'], ', '.join(names)))
    if 'EPAPER_CS' in given and given['EPAPER_CS'] not in ('ce0', 'ce1'):
        fail('EPAPER_CS=%s: ce0 or ce1 expected' % given['EPAPER_CS'])
    pins = dict(DEFAULTS)
    for key in ('EPAPER_DC', 'EPAPER_RST', 'EPAPER_BUSY'):
        if key in given:
            v = given[key]
            if not re.fullmatch(r'\d{1,2}', v) or not pin_ok(int(v)):
                fail('%s=%s: a GPIO number expected, 2 to 27 but not 7 to 11 (SPI0) '
                     'nor 14 and 15 (the serial port)' % (key, v))
            pins[key] = int(v)
    if len(set(pins.values())) != 3:
        fail('EPAPER_DC, EPAPER_RST and EPAPER_BUSY must be three different GPIOs (%s)' %
             ', '.join('%s=%d' % kv for kv in sorted(pins.items())))
    if 'EPAPER_ROTATE' in given and given['EPAPER_ROTATE'] not in ('0', '90', '180', '270'):
        fail('EPAPER_ROTATE=%s: 0, 90, 180 or 270 expected' % given['EPAPER_ROTATE'])
    if 'EPAPER_SPI_KHZ' in given:
        v = given['EPAPER_SPI_KHZ']
        if not re.fullmatch(r'\d{1,5}', v) or not 100 <= int(v) <= 20000:
            fail('EPAPER_SPI_KHZ=%s: 100 to 20000 expected' % v)
    print(' '.join('-DGK_%s=\\"%s\\"' % (k, given[k]) for k in KEYS if k in given))


if __name__ == '__main__':
    main()
