#!/usr/bin/env python3
"""
Checks lib/js/bbqr.js's table of QR capacities (alphanumeric mode, error
correction L, versions 1 to 40) against a QR encoder, Python's qrcode
package: the table's figure must fit its version, and one character more
must not.

  python3 tests/bbqr/check_capacity.py

SPDX-License-Identifier: GPL-3.0-or-later
"""
import os
import re
import sys

import qrcode
from qrcode.exceptions import DataOverflowError
from qrcode.util import QRData, MODE_ALPHA_NUM

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
src = open(os.path.join(ROOT, 'lib/js/bbqr.js')).read()
table = re.search(r'const ALPHANUMERIC_L = \[0,([^\]]*)\]', src).group(1)
caps = [int(x) for x in table.replace('\n', ' ').split(',') if x.strip()]
assert len(caps) == 40, 'the table should have 40 versions'


def fits(version, n):
    q = qrcode.QRCode(version=version, error_correction=qrcode.constants.ERROR_CORRECT_L)
    q.add_data(QRData('B' * n, mode=MODE_ALPHA_NUM))
    try:
        q.make(fit=False)
    except DataOverflowError:
        return False
    return True


bad = [v for v, n in enumerate(caps, 1) if not fits(v, n) or fits(v, n + 1)]
for v in bad:
    print('FAIL version %d: %d characters' % (v, caps[v - 1]))
print('bbqr capacities: %d of 40 right' % (40 - len(bad)))
sys.exit(1 if bad else 0)
