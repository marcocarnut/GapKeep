#!/usr/bin/env python3
"""
Bundle zerogap apps into the kernel image.

Reads every apps/<id>/manifest.json, validates it, and writes a C file
holding each app's metadata and the contents of its files (.js, .json, .txt).
The output is deterministic: same inputs, same bytes.

Usage: bundle_apps.py <output.c> <apps-dir> [<apps-dir> ...]
"""
import json
import os
import re
import sys

PERMISSIONS = {'apps': 'ZG_PERM_APPS'}
FILE_EXTENSIONS = ('.js', '.json', '.txt')
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')

# Keep in sync with the symbol table in src/runtime/js_ui.cpp (ui.symbols).
SYMBOLS = {
    'audio': 'F001', 'video': 'F008', 'list': 'F00B', 'ok': 'F00C', 'close': 'F00D',
    'power': 'F011', 'settings': 'F013', 'home': 'F015', 'download': 'F019',
    'drive': 'F01C', 'refresh': 'F021', 'mute': 'F026', 'volume-mid': 'F027',
    'volume-max': 'F028', 'image': 'F03E', 'tint': 'F043', 'prev': 'F048',
    'play': 'F04B', 'pause': 'F04C', 'stop': 'F04D', 'next': 'F051', 'eject': 'F052',
    'left': 'F053', 'right': 'F054', 'plus': 'F067', 'minus': 'F068',
    'eye-open': 'F06E', 'eye-close': 'F070', 'warning': 'F071', 'shuffle': 'F074',
    'up': 'F077', 'down': 'F078', 'loop': 'F079', 'directory': 'F07B',
    'upload': 'F093', 'call': 'F095', 'cut': 'F0C4', 'copy': 'F0C5', 'save': 'F0C7',
    'bars': 'F0C9', 'envelope': 'F0E0', 'charge': 'F0E7', 'paste': 'F0EA',
    'bell': 'F0F3', 'keyboard': 'F11C', 'gps': 'F124', 'file': 'F15B',
    'wifi': 'F1EB', 'battery-full': 'F240', 'battery-3': 'F241', 'battery-2': 'F242',
    'battery-1': 'F243', 'battery-empty': 'F244', 'usb': 'F287', 'bluetooth': 'F293',
    'trash': 'F2ED', 'edit': 'F304', 'backspace': 'F55A', 'sd-card': 'F7C2',
    'new-line': 'F8A2',
}


def fail(msg):
    sys.exit('bundle_apps: error: ' + msg)


def c_string(data: bytes) -> str:
    out = []
    line = '"'
    for b in data:
        if b == 0x5c:
            s = '\\\\'
        elif b == 0x22:
            s = '\\"'
        elif b == 0x0a:
            s = '\\n'
        elif b == 0x09:
            s = '\\t'
        elif 0x20 <= b < 0x7f and b != 0x3f:   # avoid '?' trigraphs
            s = chr(b)
        else:
            s = '\\%03o' % b
        line += s
        if b == 0x0a or len(line) > 100:
            out.append(line + '"')
            line = '"'
    out.append(line + '"')
    return '\n\t'.join(out)


def symbol_utf8(name, where):
    if name not in SYMBOLS:
        fail('%s: unknown icon %r (one of: %s)' % (where, name, ', '.join(sorted(SYMBOLS))))
    return chr(int(SYMBOLS[name], 16)).encode('utf-8')


def load_app(appdir, app_id):
    where = os.path.join(appdir, 'manifest.json')
    try:
        with open(where, encoding='utf-8') as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        fail('%s: %s' % (where, e))
    if not isinstance(m, dict):
        fail('%s: must be a JSON object' % where)

    known = {'id', 'name', 'version', 'description', 'icon', 'entry', 'permissions', 'hidden'}
    for k in m:
        if k not in known:
            fail('%s: unknown key %r' % (where, k))
    for k in ('id', 'name', 'version'):
        if not isinstance(m.get(k), str) or not m[k]:
            fail('%s: %r is required and must be a non-empty string' % (where, k))
    if m['id'] != app_id:
        fail('%s: id %r must match the directory name %r' % (where, m['id'], app_id))
    if not ID_RE.match(app_id):
        fail('%s: id must match %s' % (where, ID_RE.pattern))
    perms = m.get('permissions', [])
    if not isinstance(perms, list) or any(p not in PERMISSIONS for p in perms):
        fail('%s: permissions must be a list drawn from %s' % (where, sorted(PERMISSIONS)))
    entry = m.get('entry', 'main.js')

    files = []
    for root, dirs, names in os.walk(appdir):
        dirs.sort()
        for n in sorted(names):
            if n.endswith(FILE_EXTENSIONS):
                full = os.path.join(root, n)
                rel = os.path.relpath(full, appdir).replace(os.sep, '/')
                with open(full, 'rb') as f:
                    data = f.read()
                if b'\0' in data:
                    fail('%s: contains NUL bytes' % full)
                try:
                    data.decode('utf-8')
                except UnicodeDecodeError:
                    fail('%s: not valid UTF-8' % full)
                files.append((rel, data))
    if entry not in [p for p, _ in files]:
        fail('%s: entry module %r not found' % (where, entry))

    return {
        'id': app_id,
        'name': m['name'],
        'version': m['version'],
        'description': m.get('description', ''),
        'icon': symbol_utf8(m.get('icon', 'file'), where),
        'entry': entry,
        'permissions': ' | '.join(PERMISSIONS[p] for p in perms) or '0',
        'hidden': 1 if m.get('hidden') else 0,
        'files': files,
    }


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out = sys.argv[1]
    found = {}
    for appsdir in sys.argv[2:]:
        for d in os.listdir(appsdir):
            if os.path.isfile(os.path.join(appsdir, d, 'manifest.json')):
                if d in found:
                    fail('app %r exists in both %s and %s' % (d, found[d], appsdir))
                found[d] = appsdir
    ids = sorted(found)
    apps = [load_app(os.path.join(found[i], i), i) for i in ids]
    if 'launcher' not in ids:
        fail('the "launcher" app is required')

    lines = ['/* Generated by tools/bundle_apps.py - do not edit. */',
             '#include "../runtime/bundle.h"', '']
    for n, a in enumerate(apps):
        for k, (path, data) in enumerate(a['files']):
            lines.append('static const char app%d_file%d[] =\n\t%s;' % (n, k, c_string(data)))
        lines.append('static const zg_file_t app%d_files[] = {' % n)
        for k, (path, data) in enumerate(a['files']):
            lines.append('\t{ %s, app%d_file%d, %d },' % (c_string(path.encode()), n, k, len(data)))
        lines.append('};')
        lines.append('')
    lines.append('const zg_app_t zg_apps[] = {')
    for n, a in enumerate(apps):
        lines.append('\t{ %s, %s, %s, %s, %s, %s, %s, %d, app%d_files, %d },' % (
            c_string(a['id'].encode()), c_string(a['name'].encode()),
            c_string(a['version'].encode()), c_string(a['description'].encode()),
            c_string(a['icon']), c_string(a['entry'].encode()),
            a['permissions'], a['hidden'], n, len(a['files'])))
    lines.append('};')
    lines.append('const unsigned zg_app_count = %d;' % len(apps))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    data = '\n'.join(lines) + '\n'
    try:
        with open(out) as f:
            if f.read() == data:
                return      # unchanged: keep the timestamp, avoid rebuilds
    except OSError:
        pass
    with open(out, 'w') as f:
        f.write(data)


if __name__ == '__main__':
    main()
