#!/usr/bin/env python3
"""
Extract dice39's codex32 recombiner logic from codex32_recover.html into ES
modules for the zerogap codex32 app (apps/codex32/vendor/).

The sibling of extract_dice39.py, and built on it: the code is copied byte
for byte, each module gets a header naming the source file and its SHA-256,
a short prelude so browser-isms keep working, and an export line. Nothing in
between is edited, so `diff` against the HTML shows exactly what was taken.

Deterministic: same input, same output. Re-run it and `git diff` to check.

Usage: extract_codex32.py <path/to/codex32_recover.html> <output-dir>
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_dice39 import block_starting_with, extract_decl, fail, script_blocks  # noqa: E402


def header(src_name, src_hash, what, line):
    return (
        '// Extracted from dice39 by tools/extract_codex32.py - do not edit.\n'
        '// Source: %s (sha256 %s), %s starting at line %d.\n'
        '// dice39 is licensed under the GNU AGPL v3; see apps/codex32/LICENSE-dice39.txt.\n'
        '// The code between the prelude and the export line is copied verbatim.\n\n'
        % (src_name, src_hash, what, line))


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, outdir = sys.argv[1], sys.argv[2]
    raw = open(src, 'rb').read()
    src_hash = hashlib.sha256(raw).hexdigest()
    html = raw.decode('utf-8')
    name = os.path.basename(src)
    blocks = script_blocks(html)
    os.makedirs(outdir, exist_ok=True)
    outputs = {}

    # 1. the BIP-39 English wordlist
    line, text = block_starting_with(
        blocks, '/* ==================================================================\n'
                '   BIP-39 English wordlist')
    outputs['wordlist.js'] = (
        header(name, src_hash, 'wordlist block', line)
        + 'const window = {};\n\n'
        + text
        + '\nexport const BIP39_WORDS = window.BIP39_WORDS;\n')

    # 2. codex32 (BIP-93): the whole block. On this page its functions are
    # globals (there is no window.CODEX32 object), so they are exported by name.
    line, text = block_starting_with(blocks, '/* codex32 / BIP-93')
    outputs['codex32.js'] = (
        header(name, src_hash, 'codex32 block', line)
        + text
        + '\nexport { CX_CHARSET, CX_SECRET_INDEX, MS32_CONST, MS32_LONG_CONST, MS32_GEN,\n'
          '  MS32_LONG_GEN, BECH32_INV, bech32Mul, ms32Polymod, ms32LongPolymod, ms32VerifyChecksum,\n'
          '  ms32Interpolate, cxEncode, cxDecode, fromBase32, cxSeedFromData, cxRecover };\n')

    # 3. from the page's own script: the strings (en and pt), entropy to
    # words, and the SeedQR digits (Compact SeedQR is the seed bytes as they
    # are: zg:ui takes a Uint8Array). The DOM code around them is
    # rewritten for zg:ui in the app.
    line, text = block_starting_with(
        blocks, '/* ==================================================================\n   i18n')
    names = ['STRINGS', 'RECOVER_SIZES', 'wordsFromEntropy', 'hex',
             'SEEDQR_ECC', 'seedQrDigits']
    parts = [extract_decl(text, n) for n in names]
    outputs['recover.js'] = (
        header(name, src_hash, 'page script (selected declarations)', line)
        + 'import { BIP39_WORDS } from "./wordlist.js";\n'
        + 'const window = { BIP39_WORDS };\n\n'
        + '\n'.join(parts)
        + '\nexport { %s };\n' % ', '.join(names))

    for fname, data in sorted(outputs.items()):
        if 'document.' in data:
            fail('%s would contain DOM code' % fname)
        with open(os.path.join(outdir, fname), 'w', encoding='utf-8') as f:
            f.write(data)
        print('%-14s %7d bytes' % (fname, len(data.encode())))


if __name__ == '__main__':
    main()
