#!/usr/bin/env python3
"""
An app's translations: apps/<app>/lang/<language>.json (docs/APPS.md,
"Languages"; docs/plans/I18N.md).

  i18n.py check apps/x [--lang pt-BR]
      For each catalog (or the one named): keys the code uses that have no
      translation, translations the code no longer uses, translations whose
      {names} differ from their key's, control and bidi characters, and a
      catalog the runtime would refuse. Keys that aren't string literals
      are listed as "dynamic, not checked". Exit status 1 on any problem
      but those.

  i18n.py extract apps/x --lang pt-BR [--prune]
      Creates or updates lang/pt-BR.json: adds the keys the code uses with
      an empty translation (the runtime shows English for those, and check
      lists them), keeps the translations and notes there are; with
      --prune, drops the ones the code no longer uses.

  i18n.py keys apps/x
      The keys, one JSON string a line, in the order the code uses them.

The keys are the first argument of t() and the second and third of
plural() (or i18n.t(), ...), string literals (or literals joined with +), with t()'s
{ $context: "..." } if it has one ("verb\\u0004Open"). The launcher's
catalogs are also the system's: its keys include those of the runtime's
own JavaScript (src/runtime/*.js, ts()).

The checks are the runtime's (src/runtime/i18n.cpp): keep them in step.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_CATALOG = 256 * 1024
TAG = re.compile(r'^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
TOP_KEYS = ('$language', '$app', '$name', 'messages', 'notes')


# --- reading JavaScript ----------------------------------------------------------

def unescape(body, where):
    out, i = [], 0
    simple = {'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0'}
    while i < len(body):
        c = body[i]
        if c != '\\':
            out.append(c)
            i += 1
            continue
        n = body[i + 1]
        if n in simple:
            out.append(simple[n])
            i += 2
        elif n == 'x':
            out.append(chr(int(body[i + 2:i + 4], 16)))
            i += 4
        elif n == 'u' and body[i + 2] == '{':
            end = body.index('}', i)
            out.append(chr(int(body[i + 3:end], 16)))
            i = end + 1
        elif n == 'u':
            cp = int(body[i + 2:i + 6], 16)
            i += 6
            if 0xD800 <= cp < 0xDC00 and body[i:i + 2] == '\\u':     # a pair
                cp = 0x10000 + ((cp - 0xD800) << 10) + int(body[i + 2:i + 6], 16) - 0xDC00
                i += 6
            out.append(chr(cp))
        elif n == '\n':
            i += 2
        else:
            out.append(n)
            i += 2
    return ''.join(out)


def tokens(src, path):
    """(kind, value, line): 'str' (its value), 'tmpl' (None if it has ${}),
    'id', 'punct'. Comments are skipped; regular expressions too, roughly
    (a / where an expression can start)."""
    out = []
    i, line, n = 0, 1, len(src)
    regex_ok = True
    while i < n:
        c = src[i]
        if c == '\n':
            line += 1
            i += 1
        elif c.isspace():
            i += 1
        elif src.startswith('//', i):
            i = src.find('\n', i)
            i = n if i < 0 else i
        elif src.startswith('/*', i):
            end = src.find('*/', i + 2)
            end = n if end < 0 else end + 2
            line += src.count('\n', i, end)
            i = end
        elif c in '"\'':
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == '\\' else 1
            out.append(('str', unescape(src[i + 1:j], path), line))
            line += src.count('\n', i, j)
            i = j + 1
            regex_ok = False
        elif c == '`':
            j, subst = i + 1, False
            while j < n and src[j] != '`':
                if src[j] == '\\':
                    j += 2
                    continue
                if src.startswith('${', j):
                    subst = True
                    depth = 1
                    j += 2
                    while j < n and depth:      # nested braces, roughly
                        depth += {'{': 1, '}': -1}.get(src[j], 0)
                        j += 1
                    continue
                j += 1
            out.append(('tmpl', None if subst else unescape(src[i + 1:j], path), line))
            line += src.count('\n', i, j)
            i = j + 1
            regex_ok = False
        elif c == '/' and regex_ok:
            j, in_class = i + 1, False
            while j < n and src[j] != '\n' and (in_class or src[j] != '/'):
                if src[j] == '\\':
                    j += 1
                elif src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                j += 1
            j += 1
            while j < n and (src[j].isalnum()):
                j += 1
            i = j
            regex_ok = False
        elif c.isalnum() or c in '_$':
            j = i
            while j < n and (src[j].isalnum() or src[j] in '_$'):
                j += 1
            word = src[i:j]
            out.append(('id', word, line))
            i = j
            regex_ok = word in ('return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else')
        else:
            out.append(('punct', c, line))
            i += 1
            regex_ok = c not in ')]}'
    return out


def literal(toks, k):
    """A key at toks[k]: string literals joined with +. (value, next index),
    or (None, index after the argument) if it isn't one."""
    parts = []
    while k < len(toks) and toks[k][0] in ('str', 'tmpl') and toks[k][1] is not None:
        parts.append(toks[k][1])
        k += 1
        if k < len(toks) and toks[k][1] == '+' and toks[k][0] == 'punct':
            k += 1
            continue
        break
    if parts and k < len(toks) and toks[k][1] in (',', ')'):
        return ''.join(parts), k
    return None, skip_arg(toks, k)


def skip_arg(toks, k):
    depth = 0
    while k < len(toks):
        kind, v, _ = toks[k]
        if kind == 'punct':
            if v in '([{':
                depth += 1
            elif v in ')]}':
                if depth == 0:
                    return k
                depth -= 1
            elif v == ',' and depth == 0:
                return k
        k += 1
    return k


def context_of(toks, k):
    """The { $context: "..." } in the argument at toks[k], if any."""
    end = skip_arg(toks, k)
    for i in range(k, end - 2):
        if toks[i][1] == '$context' and toks[i + 1][1] == ':' and toks[i + 2][0] == 'str':
            return toks[i + 2][1]
    return None


def keys_in(src, path, names=('t', 'plural')):
    """[(key or None, line)] in the order they appear; None: dynamic."""
    toks = tokens(src, path)
    found = []
    for k, (kind, v, line) in enumerate(toks):
        if kind != 'id' or v not in names or k + 1 >= len(toks) or toks[k + 1][1] != '(':
            continue
        if k > 0 and toks[k - 1][1] in ('function', '#'):    # its definition
            continue
        a = k + 2
        if v == 'plural':
            a = skip_arg(toks, a) + 1      # the count
            keys = []
            for _ in range(2):
                key, a = literal(toks, a)
                keys.append(key)
                a += 1
            ctx = context_of(toks, a) if toks[a - 1][1] == ',' else None
        else:
            key, a = literal(toks, a)
            keys = [key]
            ctx = context_of(toks, a + 1) if a < len(toks) and toks[a][1] == ',' else None
        for key in keys:
            if key is not None and ctx is not None:
                key = ctx + '\u0004' + key
            found.append((key, line))
    return found


def sources(appdir):
    """(path, names) of the JavaScript whose keys the app's catalogs hold."""
    out = []
    for root, dirs, files in os.walk(appdir):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for f in sorted(files):
            if f.endswith('.js'):
                out.append((os.path.join(root, f), ('t', 'plural')))
    if os.path.basename(os.path.normpath(appdir)) == 'launcher':
        rt = os.path.join(ROOT, 'src', 'runtime')
        for f in sorted(os.listdir(rt)):
            if f.endswith('.js'):
                out.append((os.path.join(rt, f), ('ts',)))
    return out


def app_keys(appdir):
    keys, dynamic = [], []
    for path, names in sources(appdir):
        with open(path, encoding='utf-8') as f:
            src = f.read()
        for key, line in keys_in(src, path, names):
            if key is None:
                dynamic.append('%s:%d' % (os.path.relpath(path, ROOT), line))
            elif key not in keys:
                keys.append(key)
    return keys, dynamic


# --- the runtime's checks (src/runtime/i18n.cpp) -----------------------------------

PLACEHOLDER = re.compile(r'\{\{|\}\}|\{(\w+)\}', re.ASCII)
FORBIDDEN = re.compile('[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏'
                       ' -‮⁦-⁩\ud800-\udfff]')


def names(text):
    return {m.group(1) for m in PLACEHOLDER.finditer(text) if m.group(1)}


def problem_of(key, text):
    if FORBIDDEN.search(text):
        return 'has a control or bidi character'
    bare = key.split('\u0004', 1)[-1]
    if len(names(bare)) > 32 or len(names(text)) > 32:
        return 'has too many {names}'
    if names(bare) != names(text):
        return "hasn't the same {names} as its key (%s, not %s)" % (
            ' '.join(sorted('{%s}' % n for n in names(text))) or 'none',
            ' '.join(sorted('{%s}' % n for n in names(bare))) or 'none')
    return None


def show(key):
    return json.dumps(key, ensure_ascii=False)


def read_catalog(path, app_id, tag):
    """(catalog, [problems that make the runtime refuse it])"""
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) > MAX_CATALOG:
        return None, ['larger than 256 KB']
    try:
        cat = json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as e:
        return None, ['not JSON: %s' % e]
    if not isinstance(cat, dict):
        return None, ['not a JSON object']
    errors = []
    if '$language' in cat and cat['$language'] != tag:
        errors.append('"$language" is %s, the file says %s' % (show(cat['$language']), tag))
    if '$app' in cat and cat['$app'] != app_id:
        errors.append('"$app" is %s, not %s' % (show(cat['$app']), show(app_id)))
    if not isinstance(cat.get('messages'), dict):
        errors.append('no "messages" object')
    return cat, errors


def check(appdir, only=None):
    appdir = os.path.normpath(appdir)
    app_id = os.path.basename(appdir)
    langdir = os.path.join(appdir, 'lang')
    keys, dynamic = app_keys(appdir)
    tags = sorted(f[:-5] for f in os.listdir(langdir) if f.endswith('.json')) if os.path.isdir(langdir) else []
    if only:
        tags = [only] if only in tags else []
        if not tags:
            print('%s: no lang/%s.json' % (app_id, only))
            return 1
    failed = 0
    for d in dynamic:
        print('%s: dynamic, not checked: %s' % (app_id, d))
    for tag in tags:
        where = '%s lang/%s.json' % (app_id, tag)
        problems = []
        if not TAG.match(tag):
            problems.append('%s is not a language tag like pt-BR' % tag)
        cat, errors = read_catalog(os.path.join(langdir, tag + '.json'), app_id, tag)
        problems += errors
        if cat is not None and isinstance(cat.get('messages'), dict):
            msgs = cat['messages']
            for k in cat:
                if k not in TOP_KEYS:
                    problems.append('unknown key %s (the runtime ignores it)' % show(k))
            if '$name' in cat and (not isinstance(cat['$name'], str) or not 0 < len(cat['$name'].encode()) <= 64
                                   or FORBIDDEN.search(cat['$name']) or '\n' in cat['$name']):
                problems.append('"$name" must be plain text on one line, at most 64 bytes')
            # a regional catalog may leave keys to its language's (pt-BR to pt)
            base = {}
            if '-' in tag and os.path.exists(os.path.join(langdir, tag.split('-')[0] + '.json')):
                b, _ = read_catalog(os.path.join(langdir, tag.split('-')[0] + '.json'), app_id, tag.split('-')[0])
                base = (b or {}).get('messages') or {}
            for k in keys:
                if not (isinstance(msgs.get(k), str) and msgs[k]) and not (isinstance(base.get(k), str) and base[k]):
                    problems.append('untranslated: %s' % show(k))
            for k, v in msgs.items():
                if not isinstance(v, str):
                    problems.append('%s: not a string' % show(k))
                    continue
                if k not in keys:
                    problems.append('not used any more: %s' % show(k))
                if v:
                    why = problem_of(k, v)
                    if why:
                        problems.append('%s: the translation %s' % (show(k), why))
            notes = cat.get('notes', {})
            if not isinstance(notes, dict):
                problems.append('"notes" must be an object')
        for p in problems:
            print('%s: %s' % (where, p))
        if problems:
            failed = 1
        else:
            print('%s: %d keys, all translated' % (where, len(keys)))
    if not tags:
        print('%s: %d keys, no catalogs' % (app_id, len(keys)))
    return failed


def extract(appdir, tag, prune=False):
    appdir = os.path.normpath(appdir)
    app_id = os.path.basename(appdir)
    if not TAG.match(tag):
        sys.exit('i18n: %s is not a language tag like pt-BR' % tag)
    path = os.path.join(appdir, 'lang', tag + '.json')
    keys, dynamic = app_keys(appdir)
    cat = {}
    if os.path.exists(path):
        cat, errors = read_catalog(path, app_id, tag)
        if cat is None or errors:
            sys.exit('i18n: %s: %s' % (path, '; '.join(errors)))
    old = cat.get('messages', {})
    msgs = {k: old.get(k, '') for k in keys}
    for k, v in old.items():
        if k not in msgs and not prune:
            msgs[k] = v
    notes = {k: v for k, v in cat.get('notes', {}).items() if k in msgs}
    out = {'$language': tag, '$app': app_id}
    for k, v in cat.items():
        if k not in ('$language', '$app', 'messages', 'notes'):
            out[k] = v
    out['messages'] = msgs
    if notes:
        out['notes'] = notes
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')
    added = sum(1 for k in keys if k not in old)
    print('%s: %d keys, %d added, %d untranslated%s' % (
        os.path.relpath(path, ROOT), len(keys), added, sum(1 for v in msgs.values() if v == ''),
        ', %d dynamic' % len(dynamic) if dynamic else ''))


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    opts = {}
    it = iter(argv)
    for a in it:
        if a == '--lang':
            opts['lang'] = next(it, None)
            args.remove(opts['lang'])
        elif a == '--prune':
            opts['prune'] = True
        elif a.startswith('--'):
            sys.exit('i18n: unknown option %s' % a)
    if len(args) != 2 or args[0] not in ('check', 'extract', 'keys'):
        sys.exit(__doc__)
    cmd, appdir = args
    if not os.path.isfile(os.path.join(appdir, 'manifest.json')):
        sys.exit('i18n: %s is not an app (no manifest.json)' % appdir)
    if cmd == 'check':
        return check(appdir, opts.get('lang'))
    if cmd == 'keys':
        keys, dynamic = app_keys(appdir)
        for k in keys:
            print(json.dumps(k, ensure_ascii=False))
        for d in dynamic:
            print('# dynamic, not checked: %s' % d, file=sys.stderr)
        return 0
    if not opts.get('lang'):
        sys.exit('i18n: extract needs --lang <language>')
    extract(appdir, opts['lang'], opts.get('prune', False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
