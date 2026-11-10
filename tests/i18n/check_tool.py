#!/usr/bin/env python3
"""
Checks tools/i18n.py: the keys it finds in code, check on the test app
(tests/apps/i18ntest, whose catalog has a translation of each kind the
runtime refuses: tests/i18n.txt sees the runtime refuse the same ones), and
extract on a copy of the clock. Run by tools/run_sim_tests.sh.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import i18n  # noqa: E402

failed = []


def expect(what, got, want):
    if got != want:
        failed.append('%s: got %r, want %r' % (what, got, want))


src = r'''
import { t, plural } from "gk:i18n";
// t("a comment is not a key")
const re = /t\("not in a regex"\)/g;
t("Plain");
t('Single {n}', { n });
t("Joined " +
  "with plus");
t(`Template`);
t(`Template ${x}`);
t(variable);
t("Open", { $context: "verb" });
i18n.t("Member");
plural(n, "{n} code", "{n} codes");
plural(count(a, b), "one", "other", { $context: "ctx" });
x.at("not t"); format("not t");
function t(text) {}
t("Escé\n\"q\"");
'''
keys = [k for k, _ in i18n.keys_in(src, 'test.js', ('t', 'plural', 'N_'))]
expect('keys', keys, ['Plain', 'Single {n}', 'Joined with plus', 'Template', None, None, 'verb\u0004Open',
                      'Member', '{n} code', '{n} codes', 'ctx\u0004one', 'ctx\u0004other', 'Escé\n"q"'])

r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'i18n.py'), 'check', 'tests/apps/i18ntest',
                    '--lang', 'pt-BR'], cwd=ROOT, capture_output=True, text=True)
expect('check exit', r.returncode, 1)
refused = sorted(l.split(': ', 1)[1] for l in r.stdout.splitlines() if 'the translation' in l or 'not a string' in l)
expect('refused', refused, sorted([
    '"Send {amount}": the translation hasn\'t the same {names} as its key (none, not {amount})',
    '"Fee {fee}": the translation hasn\'t the same {names} as its key ({extra} {fee}, not {fee})',
    '"Pay {to}": the translation has a control or bidi character',
    '"Bell": the translation has a control or bidi character',
    '"A number": not a string',
    '"Test app: gk:i18n and the checks on catalogs (tests/i18n.txt).": the translation has a control or bidi character',
    '"Send <span color=\'#ffb300\'>{amount}</span>": the translation hasn\'t the same tags as its key',
    '"Just text": the translation has a tag, and its key has none',
    '"Keep <tt>this</tt>": the translation is not valid markup',
]))

with tempfile.TemporaryDirectory() as tmp:
    app = os.path.join(tmp, 'clock')
    shutil.copytree(os.path.join(ROOT, 'apps', 'clock'), app)
    path = os.path.join(app, 'lang', 'pt-BR.json')
    cat = json.load(open(path, encoding='utf-8'))
    del cat['messages']['Back']
    cat['messages']['Gone'] = 'Foi'
    json.dump(cat, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'i18n.py'), 'check', app],
                       capture_output=True, text=True)
    expect('check finds', [l for l in r.stdout.splitlines() if 'Back' in l or 'Gone' in l],
           ['clock lang/pt-BR.json: untranslated: "Back"', 'clock lang/pt-BR.json: not used any more: "Gone"'])
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'i18n.py'), 'extract', app, '--lang', 'pt-BR'],
                   check=True, capture_output=True)
    after = json.load(open(path, encoding='utf-8'))
    expect('extract adds', after['messages'].get('Back'), '')
    expect('extract keeps', after['messages'].get('Gone'), 'Foi')
    expect('extract keeps notes', after['notes'], cat['notes'])
    expect('extract order', list(after)[:2], ['$language', '$app'])
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'i18n.py'), 'extract', app, '--lang', 'pt-BR',
                    '--prune'], check=True, capture_output=True)
    expect('extract --prune', 'Gone' in json.load(open(path, encoding='utf-8'))['messages'], False)
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'i18n.py'), 'extract', app, '--lang', 'de'],
                   check=True, capture_output=True)
    de = json.load(open(os.path.join(app, 'lang', 'de.json'), encoding='utf-8'))
    expect('extract new', (de['$language'], de['$app'], set(de['messages'].values())), ('de', 'clock', {''}))

# the glossary (docs/i18n/pt-BR.md): its Avoid column, whole words, a
# hyphenated word being one word
rules = i18n.glossary('pt-BR')
avoid = {r[0] for r in rules}
expect('glossary rules', {'parte', 'partes', 'senha', 'passphrase', 'impressão digital'} <= avoid, True)
warn = lambda text: [w.split('"')[1] for w in i18n.glossary_warnings(text, rules)]
expect('frase-senha', warn('Digite a frase-senha.'), [])
expect('senha', warn('A senha da carteira'), ['senha'])
expect('SENHA', warn('SENHA:'), ['senha'])
expect('Identificador-Mestre', warn('Identificador-Mestre e o identificador-mestre'), [])
expect('impressão digital', warn('a impressão\ndigital'), ['impressão digital'])
expect('parte', warn('a maior parte; partição; partes'), ['parte', 'partes'])
expect('no glossary', i18n.glossary('xx'), [])
with tempfile.TemporaryDirectory() as tmp:
    app = os.path.join(tmp, 'clock')
    shutil.copytree(os.path.join(ROOT, 'apps', 'clock'), app)
    path = os.path.join(app, 'lang', 'pt-BR.json')
    cat = json.load(open(path, encoding='utf-8'))
    cat['messages']['Back'] = 'Voltar à senha'
    json.dump(cat, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'i18n.py'), 'check', app],
                       capture_output=True, text=True)
    expect('a warning, not a failure', (r.returncode, [l for l in r.stdout.splitlines() if 'warning:' in l]),
           (0, ['clock lang/pt-BR.json: warning: "Back": uses "senha" (glossary: passphrase (BIP-39) is "frase-senha")']))

# markup: the cases the runtime checks too (tests/apps/markuptest/cases.js)
src = open(os.path.join(ROOT, 'tests', 'apps', 'markuptest', 'cases.js'), encoding='utf-8').read()
cases = json.loads(src[src.index('['):src.rindex(']') + 1])
def valid(text):
    try:
        i18n.markup_tags(text)
        return True
    except ValueError:
        return False
expect('markup cases', [c for c, v in cases if valid(c) != v], [])
mp = i18n.markup_problem
expect('tags kept, reordered', mp("<tt>a</tt> <u>b</u>", "<u>b</u> <tt>a</tt>"), None)
expect('tag dropped', mp("<tt>a</tt>", "a"), "hasn't the same tags as its key")
expect('tag changed', mp("<span color='#f00'>a</span>", "<span color='#0f0'>a</span>"), "hasn't the same tags as its key")
expect('attributes reordered', mp("<span size='20' color='#f00'>a</span>", '<span color="#f00" size="20">a</span>'), None)
expect('tag added', mp("plain", "<u>plain</u>"), 'has a tag, and its key has none')
expect('crossed', mp("<tt>a</tt><u>b</u>", "<tt>a<u></tt>b</u>"), 'is not valid markup')
expect('entity kept', mp("Tom &amp; Jerry", "Tom e Jerry"), None)
expect('not markup', mp("a < b", "a < b"), None)

for f in failed:
    print('FAIL', f)
print('i18n tool: %s' % ('%d failed' % len(failed) if failed else 'ok'))
sys.exit(1 if failed else 0)
