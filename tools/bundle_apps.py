#!/usr/bin/env python3
"""
Bundle zerogap apps into the kernel image.

Reads every apps/<id>/manifest.json, validates it, and writes a C file
holding each app's metadata, hash and the contents of its files (.js, .json,
.txt). The output is deterministic: same inputs, same bytes.

The checks are the same as for apps loaded from the SD card at boot
(src/runtime/appstore.cpp); keep the two in step.

Usage: bundle_apps.py <output.c> [--only id,...] <apps-dir> [<apps-dir> ...]
       bundle_apps.py --hash <app-dir> [<app-dir> ...]
           prints each app's hash, as the launcher shows it
"""
import base64
import binascii
import hashlib
import json
import os
import re
import sys

PERMISSIONS = {'apps': 'ZG_PERM_APPS', 'camera': 'ZG_PERM_CAMERA', 'rtc': 'ZG_PERM_RTC'}
FILE_EXTENSIONS = ('.js', '.json', '.txt')
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
NAME_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')     # loaded files and folders
MAX_FILES = 256
MAX_FILE_SIZE = 4 << 20
MAX_APP_SIZE = 16 << 20
MAX_DEPTH = 8
ICON_MAX_SIDE = 128     # ZG_ICON_MAX_SIDE in src/runtime/bundle.h

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


def icon_picture(icon, where):
    """A picture icon, {"width", "height", "rgba"}: (width, height, pixels)."""
    if set(icon) != {'width', 'height', 'rgba'}:
        fail('%s: a picture "icon" has exactly the keys "width", "height" and "rgba"' % where)
    w, h, b64 = icon['width'], icon['height'], icon['rgba']
    for k, v in (('width', w), ('height', h)):
        # JSON has just numbers: 64 and 64.0 are the same (as for the loader)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) \
                or not 1 <= v <= ICON_MAX_SIDE:
            fail('%s: icon %s must be a whole number from 1 to %d' % (where, k, ICON_MAX_SIDE))
    w, h = int(w), int(h)
    if not isinstance(b64, str):
        fail('%s: icon "rgba" must be a base64 string' % where)
    try:
        pixels = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        pixels = None
    # canonical base64 only (as the SD card loader checks it)
    if pixels is None or base64.b64encode(pixels).decode() != b64:
        fail('%s: icon "rgba" is not valid base64' % where)
    if len(pixels) != w * h * 4:
        fail('%s: icon "rgba" must hold width * height * 4 = %d bytes, not %d'
             % (where, w * h * 4, len(pixels)))
    return w, h, pixels


def is_app_file(name):
    return name.endswith(FILE_EXTENSIONS) and name != 'package.json'


def app_hash(files):
    """SHA-256 over the app's files sorted by path: for each, the path, NUL,
    the size in decimal, NUL, the contents (docs/APPS.md, "App hashes")."""
    h = hashlib.sha256()
    for path, data in sorted(files, key=lambda f: f[0].encode()):
        h.update(path.encode() + b'\0' + str(len(data)).encode() + b'\0' + data)
    return h.hexdigest()


def read_files(appdir):
    files = []
    total = 0
    for root, dirs, names in os.walk(appdir):
        rel_root = os.path.relpath(root, appdir)
        depth = 1 if rel_root == '.' else rel_root.count(os.sep) + 2
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for d in dirs:
            if not NAME_RE.match(d):
                fail('%s: folder name may only contain A-Z a-z 0-9 . _ -' % os.path.join(root, d))
            if depth >= MAX_DEPTH:
                fail('%s: folders nested too deeply' % os.path.join(root, d))
        for n in sorted(names):
            if n.startswith('.') or not is_app_file(n):
                continue
            full = os.path.join(root, n)
            if not NAME_RE.match(n):
                fail('%s: name may only contain A-Z a-z 0-9 . _ -' % full)
            rel = os.path.relpath(full, appdir).replace(os.sep, '/')
            with open(full, 'rb') as f:
                data = f.read()
            if b'\0' in data:
                fail('%s: contains NUL bytes' % full)
            try:
                data.decode('utf-8')
            except UnicodeDecodeError:
                fail('%s: not valid UTF-8' % full)
            if len(data) > MAX_FILE_SIZE:
                fail('%s: larger than %d MB' % (full, MAX_FILE_SIZE >> 20))
            total += len(data)
            files.append((rel, data))
    if len(files) > MAX_FILES:
        fail('%s: more than %d files' % (appdir, MAX_FILES))
    if total > MAX_APP_SIZE:
        fail('%s: larger than %d MB' % (appdir, MAX_APP_SIZE >> 20))
    return sorted(files, key=lambda f: f[0].encode())


def load_app(appdir, app_id):
    where = os.path.join(appdir, 'manifest.json')
    try:
        with open(where, encoding='utf-8') as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        fail('%s: %s' % (where, e))
    if not isinstance(m, dict):
        fail('%s: must be a JSON object' % where)

    known = {'id', 'name', 'version', 'description', 'icon', 'entry', 'permissions', 'hidden',
             'experimental'}
    for k in m:
        if k not in known:
            fail('%s: unknown key %r' % (where, k))
    limits = {'id': 32, 'name': 64, 'version': 32, 'description': 256, 'icon': 32, 'entry': 255}
    picture = None
    if isinstance(m.get('icon'), dict):
        picture = icon_picture(m['icon'], where)
        limits.pop('icon')
    for k, limit in limits.items():
        if k not in m and k not in ('id', 'name', 'version'):
            continue
        v = m.get(k)
        if not isinstance(v, str) or not v or len(v.encode()) > limit or '\0' in v:
            fail('%s: %r must be a non-empty string of at most %d bytes' % (where, k, limit))
    for k in ('hidden', 'experimental'):
        if k in m and not isinstance(m[k], bool):
            fail('%s: "%s" must be true or false' % (where, k))
    if m['id'] != app_id:
        fail('%s: id %r must match the directory name %r' % (where, m['id'], app_id))
    if not ID_RE.match(app_id):
        fail('%s: id must match %s' % (where, ID_RE.pattern))
    perms = m.get('permissions', [])
    if not isinstance(perms, list) or any(not isinstance(p, str) or p not in PERMISSIONS for p in perms):
        fail('%s: permissions must be a list drawn from %s' % (where, sorted(PERMISSIONS)))
    entry = m.get('entry', 'main.js')

    files = read_files(appdir)
    if entry not in [p for p, _ in files]:
        fail('%s: entry module %r not found' % (where, entry))

    return {
        'id': app_id,
        'name': m['name'],
        'version': m['version'],
        'description': m.get('description', ''),
        'icon': symbol_utf8('file' if picture else m.get('icon', 'file'), where),
        'picture': picture,
        'entry': entry,
        'permissions': ' | '.join(PERMISSIONS[p] for p in perms) or '0',
        'hidden': 1 if m.get('hidden') else 0,
        'experimental': 1 if m.get('experimental') else 0,
        'files': files,
        'hash': app_hash(files),
    }


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == '--hash':
        for appdir in sys.argv[2:]:
            appdir = appdir.rstrip('/')
            a = load_app(appdir, os.path.basename(appdir))
            print('%s  %s %s' % (a['hash'], a['id'], a['version']))
        return
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out = sys.argv[1]
    args = sys.argv[2:]
    only = None
    if args[0] == '--only':
        only = set(args[1].split(','))
        args = args[2:]
    found = {}
    # apps sorted by id within each directory, directories in the order
    # given: test builds list their test-only apps after the real ones
    for appsdir in args:
        for d in sorted(os.listdir(appsdir)):
            if only is not None and d not in only:
                continue
            if os.path.isfile(os.path.join(appsdir, d, 'manifest.json')):
                if d in found:
                    fail('app %r exists in both %s and %s' % (d, found[d], appsdir))
                found[d] = appsdir
    ids = list(found)
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
        if a['picture']:
            w, h, pixels = a['picture']
            lines.append('static const unsigned char app%d_icon[] = {' % n)
            for i in range(0, len(pixels), 16):
                lines.append('\t' + ','.join(str(b) for b in pixels[i:i + 16]) + ',')
            lines.append('};')
        lines.append('')
    lines.append('const zg_app_t zg_builtin_apps[] = {')
    for n, a in enumerate(apps):
        w, h, _ = a['picture'] or (0, 0, None)
        lines.append('\t{ %s, %s, %s, %s, %s, %s, %s, %d, %d, app%d_files, %d,\n\t  "%s", ZG_APP_BUILTIN, %s, %d, %d },' % (
            c_string(a['id'].encode()), c_string(a['name'].encode()),
            c_string(a['version'].encode()), c_string(a['description'].encode()),
            c_string(a['icon']), c_string(a['entry'].encode()),
            a['permissions'], a['hidden'], a['experimental'], n, len(a['files']), a['hash'],
            'app%d_icon' % n if a['picture'] else '0', w, h))
    lines.append('};')
    lines.append('const unsigned zg_builtin_app_count = %d;' % len(apps))
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
