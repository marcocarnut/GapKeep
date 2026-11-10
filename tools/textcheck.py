"""
What text shown by the system may not hold, as src/runtime/textcheck.h
checks it on the device: control characters (C0, DEL, C1), line and
paragraph separators, bidi controls, invisible characters (zero-width
spaces and joiners, word joiner and invisible operators, byte order mark,
soft hyphen), and lone surrogates. Keep the two in step.

    FORBIDDEN: these, but the line feed (translations may hold line breaks)
    FORBIDDEN_IN_NAMES: these and the line feed (an app's or a suite's
        name, version and description)

SPDX-License-Identifier: GPL-3.0-or-later
"""
import re

_SET = ('\u0000-\u0009\u000b-\u001f\u007f-\u009f­؜​-‏'
        ' -‮⁠-⁩﻿\ud800-\udfff')
FORBIDDEN = re.compile('[' + _SET + ']')
FORBIDDEN_IN_NAMES = re.compile('[\n' + _SET + ']')
