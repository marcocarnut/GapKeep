#!/usr/bin/env python3
"""
Checks that docs/api/zerogap-api.yaml describes the API the runtime really
has: runs the introspection app (tests/apps/apiinfo) on the simulator (test
build) and compares module exports, widget classes, their properties
(readable or not) and methods, events, symbols and the globals.

Also checks that the generated files are up to date (tools/gen_api.py).

Usage: check_api.py [path/to/zgsim-test]     (default: builds sim TEST=1)
Exit status 1 on any difference, each one listed.
"""
import json
import os
import re
import subprocess
import sys

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SPEC = os.path.join(ROOT, 'docs', 'api', 'zerogap-api.yaml')

problems = []


def compare(what, documented, actual):
    documented, actual = set(documented), set(actual)
    for name in sorted(actual - documented):
        problems.append('%s: %s exists but is not documented' % (what, name))
    for name in sorted(documented - actual):
        problems.append('%s: %s is documented but does not exist' % (what, name))


def readability(what, props, actual):
    """props: spec entries; actual: name -> readable|readonly|writeonly|method"""
    for p in props:
        kind = actual.get(p['name'])
        if kind is None or kind == 'method':
            continue
        has_getter = kind in ('readable', 'readonly')
        documented = bool(p.get('readable') or p.get('readonly'))
        if has_getter != documented:
            problems.append('%s.%s: documented as %s, but it is %s' % (
                what, p['name'], 'readable' if documented else 'write-only',
                'readable' if has_getter else 'write-only'))


def ts_keys(ts):
    """Top-level keys of a TS object type literal."""
    body = ts.strip()[1:-1]
    keys, depth, token = [], 0, ''
    for c in body:
        depth += c in '{(['
        depth -= c in '})]'
        if depth == 0 and c in ';\n':
            token = ''
            continue
        token += c
        m = re.match(r'\s*(?:/\*\*.*?\*/\s*)?(?:readonly\s+)?(\w+)\??\s*:$', token, re.S)
        if depth == 0 and m:
            keys.append(m.group(1))
            token = ''
            depth = 0
    return keys


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else None
    if binary is None:
        subprocess.run(['make', '-C', os.path.join(ROOT, 'sim'), '-s', '-j%d' % (os.cpu_count() or 2),
                        'TEST=1'], check=True, stdout=subprocess.DEVNULL)
        binary = os.path.join(ROOT, 'sim', 'build', 'zgsim-test')
    out = subprocess.run([binary, '--app', 'apiinfo', '--for', '2'], capture_output=True,
                         text=True, timeout=60).stdout
    if 'apiinfo done' not in out:
        sys.exit('check_api: no API dump from the simulator:\n' + out)
    real = {'widgets': {}}
    for m in re.finditer(r'apiinfo (widget )?(\w+): (.*)$', out, re.M):
        if m.group(1):
            real['widgets'][m.group(2)] = json.loads(m.group(3))
        else:
            real[m.group(2)] = json.loads(m.group(3))

    with open(SPEC, encoding='utf-8') as f:
        spec = yaml.safe_load(f)
    ui = spec['ui']

    widget_names = [w['name'] for w in ui['widgets']]
    ui_exports = [e['name'] for e in ui['exports'] if e.get('kind') != 'classes'] + widget_names
    compare('gk:ui exports', ui_exports, real['modules']['gk:ui'])
    for mod in spec['modules']:
        compare('%s exports' % mod['name'], [e['name'] for e in mod['exports']], real['modules'][mod['name']])

    # Widget.prototype: base members, common properties, event handler properties
    common = [p for g in ui['common_props'] for p in g['props']]
    documented = [b['name'] for b in ui['base_members']] + [p['name'] for p in common] + \
                 [e['prop'] for e in ui['events']]
    compare('Widget', documented, real['base'])
    readability('Widget', common, real['base'])
    for b in ui['base_members']:
        kind = real['base'].get(b['name'])
        want = 'readonly' if b.get('readonly') else 'method'
        if kind is not None and kind != want:
            problems.append('Widget.%s: documented as %s, but it is %s' % (b['name'], want, kind))

    # each widget class's own members
    by_name = {w['name']: w for w in ui['widgets']}
    for name in widget_names:
        w = by_name[name]
        src = by_name[w['same_as']] if w.get('same_as') else w
        props = src.get('props', [])
        documented = [p['name'] for p in props] + [x['name'] for x in src.get('methods', [])] + \
                     [e['prop'] for e in src.get('events', [])]
        actual = real['widgets'].get(name, {})
        compare(name, documented, actual)
        readability(name, props, actual)
        for x in src.get('methods', []):
            if actual.get(x['name']) not in (None, 'method'):
                problems.append('%s.%s: documented as a method, but it is %s' % (name, x['name'], actual[x['name']]))

    compare('ui.symbols', ui['symbols'], real['symbols'])

    # object shapes
    compare('sys.app / apps.list() entries', ts_keys(spec['shared_ts']['AppInfo']), real['app'])
    sys_exports = {e['name']: e for e in spec['modules'][0]['exports']}
    compare('sys.kernel', ts_keys(sys_exports['kernel']['ts']), real['kernel'])
    compare('sys.version', ts_keys(sys_exports['version']['ts']), real['version'])

    compare('globals', ['console', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
            real['globals'])

    # generated files
    gen = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'gen_api.py'), '--check'],
                         capture_output=True, text=True)
    if gen.returncode != 0:
        problems.append(gen.stderr.strip() or gen.stdout.strip())

    if problems:
        print('check_api: docs/api/zerogap-api.yaml and the runtime differ:')
        for p in problems:
            print('  - ' + p)
        sys.exit(1)
    print('check_api: the API description matches the runtime (%d widget classes, %d modules)'
          % (len(widget_names), 1 + len(spec['modules'])))


if __name__ == '__main__':
    main()
