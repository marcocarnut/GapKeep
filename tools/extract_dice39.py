#!/usr/bin/env python3
"""
Extract dice39's logic from bip39_generator.html into ES modules for the
zerogap dice39 app (apps/dice39/vendor/).

The code is copied byte for byte. Each module gets a header naming the
source file and its SHA-256, a short prelude so browser-isms keep working
(`window` is a plain object), and an export line. Nothing in between is
edited, so `diff` against the HTML shows exactly what was taken.

Deterministic: same input, same output. Re-run it and `git diff` to check.

Usage: extract_dice39.py <path/to/bip39_generator.html> <output-dir>
"""
import hashlib
import os
import re
import sys


def fail(msg):
    sys.exit('extract_dice39: ' + msg)


def script_blocks(html):
    """(start_line, text) of each <script> ... </script> block."""
    blocks = []
    for m in re.finditer(r'<script>\n(.*?)</script>', html, re.S):
        line = html.count('\n', 0, m.start(1)) + 1
        blocks.append((line, m.group(1)))
    return blocks


def block_starting_with(blocks, marker):
    found = [b for b in blocks if b[1].lstrip().startswith(marker)]
    if len(found) != 1:
        fail('expected exactly one script block starting with %r, found %d' % (marker, len(found)))
    return found[0]


def match_brackets(text, start):
    """Index just past the bracketed expression/body beginning at text[start]
    (one of '{', '[' or '('), skipping strings, comments and regex literals
    well enough for this file."""
    pairs = {'{': '}', '[': ']', '(': ')'}
    stack = []
    i = start
    while i < len(text):
        c = text[i]
        if c in '\'"`':
            q = c
            i += 1
            while i < len(text) and text[i] != q:
                i += 2 if text[i] == '\\' else 1
        elif text.startswith('//', i):
            i = text.index('\n', i)
        elif text.startswith('/*', i):
            i = text.index('*/', i) + 1
        elif c == '/' and re.match(r'[=(,:!&|?{};\[]\s*$', text[max(0, i - 20):i].rstrip()[-1:] or '('):
            # regex literal
            i += 1
            in_class = False
            while i < len(text):
                if text[i] == '\\':
                    i += 1
                elif text[i] == '[':
                    in_class = True
                elif text[i] == ']':
                    in_class = False
                elif text[i] == '/' and not in_class:
                    break
                i += 1
        elif c in pairs:
            stack.append(pairs[c])
        elif c in ')]}':
            if not stack or stack.pop() != c:
                fail('unbalanced %r at offset %d' % (c, i))
            if not stack:
                return i + 1
        i += 1
    fail('unterminated bracket from offset %d' % start)


def extract_decl(text, name):
    """Source of the top-level declaration of `name` (function, async function, const or
    let), including the comment block directly above it."""
    m = re.search(r'^([ \t]*)((?:async )?function %s\s*\(|(?:const|let) %s\s*=)' % (name, name), text, re.M)
    if not m:
        fail('declaration of %s not found' % name)
    start = m.start()
    # include the comment block immediately above
    lines_before = text[:start].split('\n')[:-1]
    k = len(lines_before)
    while k > 0:
        prev = lines_before[k - 1]
        if prev.rstrip().endswith('*/'):
            # a block comment: walk up to its opening line
            while k > 0 and '/*' not in lines_before[k - 1]:
                k -= 1
            k -= 1
        elif re.match(r'\s*//', prev):
            k -= 1
        else:
            break
    comment_start = len('\n'.join(lines_before[:k])) + (1 if k else 0)
    if 'function' in m.group(2).split('(')[0]:
        body = text.index('{', text.index(')', match_brackets(text, text.index('(', m.end() - 1)) - 1))
        end = match_brackets(text, body)
    else:
        # up to the terminating semicolon at bracket depth 0
        i = m.end()
        while True:
            c = text[i]
            if c in '{[(':
                i = match_brackets(text, i)
                continue
            if c == ';':
                end = i + 1
                break
            if c in '\'"`':
                q = c
                i += 1
                while text[i] != q:
                    i += 2 if text[i] == '\\' else 1
            i += 1
    return text[comment_start:end] + '\n'


def header(src_name, src_hash, what, line):
    return (
        '// Extracted from dice39 by tools/extract_dice39.py - do not edit.\n'
        '// Source: %s (sha256 %s), %s starting at line %d.\n'
        '// dice39 is licensed under the GNU AGPL v3; see apps/dice39/LICENSE-dice39.txt.\n'
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
    line, text = block_starting_with(blocks, 'window.BIP39_WORDS = [')
    outputs['wordlist.js'] = (
        header(name, src_hash, 'wordlist block', line)
        + 'const window = {};\n\n'
        + text
        + '\nexport const BIP39_WORDS = window.BIP39_WORDS;\n')

    # 2. the core algorithm (buildMnemonic, importMnemonic, ...)
    line, text = block_starting_with(blocks, '// Core algorithm for the handmade BIP-39 generator.')
    outputs['bip39core.js'] = (
        header(name, src_hash, 'core algorithm block', line)
        + 'const window = {}, module = undefined;\n\n'
        + text
        + '\nexport { BitWriter, BitReader, sha256, concatBytes, deriveKeystream,\n'
          '  buildMnemonic, importMnemonic, PHRASE_SIZES, phraseSize };\n')

    # 3. codex32 (BIP-93)
    line, text = block_starting_with(blocks, '/* codex32 (BIP-93)')
    outputs['codex32.js'] = (
        header(name, src_hash, 'codex32 block', line)
        + 'const window = {};\n\n'
        + text
        + '\nexport const CODEX32 = window.CODEX32;\n')

    # 4. dice tables, dice codes, detectors and SeedQR payloads, from the UI block
    line, text = block_starting_with(blocks, "(function () {\n'use strict';")
    names = ['TABLE_CELLS', 'TABLE_WORDS', 'REROLL_CELLS', 'GRID_COLS',
             'rerollPositions', 'buildTableCells', 'diceTablesCache', 'diceTable',
             'sortedPairsSuspected', 'stripDiceSeparators', 'parseDiceCode',
             'isPartialDiceCode', 'diceWordFor', 'SEEDQR_ECC', 'seedQrDigits',
             'compactSeedQrPayload', 'samplesToBytes',
             # entropy pad accounting (the pad itself is DOM code, rewritten
             # for zg:ui in main.js)
             'BITS_PER_DRAG_POINT', 'BITS_PER_TAP', 'MIN_DRAG_DISTANCE_PX',
             'MIN_SAMPLE_INTERVAL_MS', 'SAMPLE_CAP']
    parts = [extract_decl(text, n) for n in names]
    exports = [n for n in names if n != 'diceTablesCache']
    outputs['dice.js'] = (
        header(name, src_hash, 'UI block (selected declarations)', line)
        + 'import { BIP39_WORDS } from "./wordlist.js";\n\n'
        + '\n'.join(parts)
        + '\nexport { %s };\n' % ', '.join(exports))

    for fname, data in sorted(outputs.items()):
        with open(os.path.join(outdir, fname), 'w', encoding='utf-8') as f:
            f.write(data)
        print('%-14s %7d bytes' % (fname, len(data.encode())))


if __name__ == '__main__':
    main()
