#!/usr/bin/env python3
"""
Copies DigiMacro's configurator code, from the DigiMacroAsm tree, into the
GapKeep DigiMacro app as ES modules (apps/digimacro/vendor/).

  web/table.js        macros as text and as the bytes the board plays: the
                      encoder, the decoder, the table, {totp}'s midstates
  web/coreupdate.js   the protocol's "an answer counts only if it is to this
                      question" (isOwnAnswer, askOwn) and INFO's core fields

Each file is copied byte for byte, between a header naming the source, its
SHA-256 and the DigiMacroAsm commit, and an export line. Nothing in between
is edited, so `diff` against the source shows exactly what was taken. The
scripts are written to run as plain browser scripts and under Node; as ES
modules their `module.exports` line is simply skipped (there is no
`module`), and the export line makes the same names available.

Deterministic: same input, same output. Re-run it and `git diff` to check;
--check exits 1 if the copies differ from what the source would give.

Usage: extract_digimacro.py [--check] <path/to/DigiMacroAsm> [<app dir>]

DigiMacroAsm is the user's own project (GPL), unpublished: these copies
live on the digimacro branch only.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = {
    'web/table.js': 'table.js',
    'web/coreupdate.js': 'coreupdate.js',
}


def exported_names(text, src):
    """The names of the file's `module.exports = { ... }` line(s)."""
    m = re.search(r"module\.exports\s*=\s*\{([^}]*)\}", text)
    if not m:
        sys.exit('extract_digimacro: no module.exports in %s' % src)
    names = [n.strip() for n in m.group(1).replace('\n', ' ').split(',') if n.strip()]
    for n in names:
        if not re.fullmatch(r'[A-Za-z_$][\w$]*', n):
            sys.exit('extract_digimacro: %s exports %r, not a plain name' % (src, n))
    return names


def commit_of(tree):
    try:
        out = subprocess.run(['git', '-C', tree, 'log', '-1', '--format=%H'],
                             capture_output=True, text=True, check=True).stdout.strip()
        return out or 'unknown'
    except (OSError, subprocess.CalledProcessError):
        return 'unknown'


def build(tree):
    commit = commit_of(tree)
    out = {}
    for src, dst in FILES.items():
        raw = open(os.path.join(tree, src), 'rb').read()
        text = raw.decode('utf-8')
        names = exported_names(text, src)
        if src == 'web/coreupdate.js':
            # what the app uses that the Node export doesn't name
            names = names + [n for n in ('isOwnAnswer', 'askOwn', 'coreInfo', 'CU', 'CU_LEN', 'CU_DATA',
                                         'CU_CORE_APP') if n not in names]
        header = (
            '// Copied from DigiMacroAsm by tools/extract_digimacro.py - do not edit.\n'
            '// Source: %s (sha256 %s), DigiMacroAsm commit %s.\n'
            '// DigiMacro is GPL; the code between this header and the export line is\n'
            '// copied verbatim (as a module its module.exports line is skipped).\n\n'
            % (src, hashlib.sha256(raw).hexdigest(), commit))
        out[dst] = header + text + ('' if text.endswith('\n') else '\n') + \
            '\nexport {\n  ' + ',\n  '.join(names) + ',\n};\n'
    return out


def main():
    args = [a for a in sys.argv[1:] if a != '--check']
    check = '--check' in sys.argv[1:]
    if not 1 <= len(args) <= 2:
        sys.exit(__doc__)
    tree = args[0]
    appdir = args[1] if len(args) > 1 else os.path.join(ROOT, 'apps', 'digimacro')
    outdir = os.path.join(appdir, 'vendor')
    stale = 0
    for name, data in build(tree).items():
        path = os.path.join(outdir, name)
        current = open(path, encoding='utf-8').read() if os.path.exists(path) else None
        if current == data:
            continue
        if check:
            print('extract_digimacro: %s differs from what the source gives' % path)
            stale += 1
        else:
            os.makedirs(outdir, exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(data)
            print('extract_digimacro: wrote %s' % path)
    sys.exit(1 if stale else 0)


if __name__ == '__main__':
    main()
