#!/usr/bin/env python3
"""
The browser IDE's keyboard in a real browser: headless Chrome, driven over
its DevTools protocol, types into GapKeep's screen as a person would:
letters, a dead key composed by an input method and one without
composition, an AltGr character, ç á ã, Shift, Backspace, Ctrl+C, a paste
(a synthetic paste event: headless Chrome has no clipboard), and clicking
the editor takes the keyboard back. tests/apps/typetest logs what reached
its TextArea. tests/web/textinput.mjs tests the same logic under Node.

Not run by tools/run_sim_tests.sh: it needs Google Chrome, Python's
websockets, Monaco (sim/web/vendor, tools/fetch_monaco.sh) and the
WebAssembly build (make -C sim web). It serves the IDE itself, on PORT,
with the example apps and typetest (into sim/build/web, as tools/gkide.sh
does), in a Chrome profile of its own that it deletes afterwards.

What it can't show: real dead keys and AltGr from a real keyboard layout
(DevTools sends the events those make), Windows' AltGr (reported as
Ctrl+Alt plus the AltGraph state, which DevTools can't set), macOS's
Option, and a real clipboard.

    python3 tests/web/ide_typing.py [--chrome PATH]

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse, asyncio, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request

import websockets

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT, DEBUG_PORT = 8093, 9335
EXAMPLES = ["launcher", "settings", "hello", "gallery"]

class CDP:
    def __init__(self, ws): self.ws, self.n, self.events = ws, 0, []
    @classmethod
    async def connect(cls, url=f"http://127.0.0.1:{DEBUG_PORT}/json"):
        tabs = json.load(urllib.request.urlopen(url))
        page = [t for t in tabs if t["type"] == "page"][0]
        ws = await websockets.connect(page["webSocketDebuggerUrl"], max_size=50_000_000)
        return cls(ws)
    async def call(self, method, **params):
        self.n += 1; my = self.n
        await self.ws.send(json.dumps({"id": my, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == my:
                if "error" in msg: raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            self.events.append(msg)
    async def js(self, expr):
        r = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r: raise RuntimeError(r["exceptionDetails"])
        return r["result"].get("value")
    async def until(self, expr, timeout=30):
        for _ in range(int(timeout * 10)):
            v = await self.js(expr)
            if v: return v
            await asyncio.sleep(0.1)
        return None


results = []
def check(name, ok, detail=""):
    ok = bool(ok); results.append(ok); print(("PASS " if ok else "FAIL ") + name + (("  " + detail) if detail and not ok else ""))
async def run():
    c = await CDP.connect()
    await c.call("Page.enable"); await c.call("Runtime.enable")
    await c.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/web/index.html")
    await c.until("document.querySelector('#console')?.innerText.includes('launcher ready')")
    log = lambda: c.js("document.querySelector('#console').innerText")
    # run typetest: open its main.js (expanding it if needed), then Run
    await c.js("(() => { const r = [...document.querySelectorAll('#tree .row.app')].find(r => r.querySelector('.name').textContent === 'typetest'); if (r.querySelector('.twisty').textContent === '▸') r.querySelector('.twisty').click(); })()")
    await asyncio.sleep(0.5)
    await c.js("(() => { const rows = [...document.querySelectorAll('#tree .row')]; const i = rows.findIndex(r => r.classList.contains('app') && r.querySelector('.name').textContent === 'typetest'); rows.slice(i + 1).find(r => r.querySelector('.name').textContent === 'main.js').click(); })()")
    await asyncio.sleep(1)
    await c.js("document.querySelector('#run').click()")
    check("typetest started", await c.until("document.querySelector('#console').innerText.includes('typetest ready')", 15))
    # click the screen: a real mouse click
    box = await c.js("(() => { const r = document.querySelector('#screen').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()")
    for t in ("mousePressed", "mouseReleased"):
        await c.call("Input.dispatchMouseEvent", type=t, x=box[0], y=box[1], button="left", clickCount=1)
    check("the screen's textarea has the focus", await c.js("document.activeElement.id") == "screen-input",
          await c.js("document.activeElement.id"))
    async def key(k, code, text=None, mods=0, vk=0):
        p = dict(type="keyDown", key=k, code=code, modifiers=mods, windowsVirtualKeyCode=vk)
        if text is not None: p["text"] = text; p["unmodifiedText"] = text
        await c.call("Input.dispatchKeyEvent", **p)
        await c.call("Input.dispatchKeyEvent", type="keyUp", key=k, code=code, modifiers=mods, windowsVirtualKeyCode=vk)
    async def enter():
        await key("Enter", "Enter", "\r", vk=13)
        await asyncio.sleep(0.5)
    # a letter
    await key("a", "KeyA", "a", vk=65)
    # a dead key, as an input method composes it (Chrome on Linux, macOS): " then a is ä
    await c.call("Input.dispatchKeyEvent", type="keyDown", key="Dead", code="Quote", modifiers=8, windowsVirtualKeyCode=222)
    await c.call("Input.imeSetComposition", text="\"", selectionStart=1, selectionEnd=1)
    await c.call("Input.dispatchKeyEvent", type="keyUp", key="Dead", code="Quote", modifiers=8, windowsVirtualKeyCode=222)
    await c.call("Input.insertText", text="ä")
    # a dead key without composition (Firefox on Linux), then a space: the quote itself
    await c.call("Input.dispatchKeyEvent", type="keyDown", key="Dead", code="Quote", modifiers=8, windowsVirtualKeyCode=222)
    await c.call("Input.dispatchKeyEvent", type="keyUp", key="Dead", code="Quote", modifiers=8, windowsVirtualKeyCode=222)
    await c.call("Input.insertText", text="\"")
    # AltGr+2 as Linux reports it (the character, no Ctrl or Alt)
    await key("²", "Digit2", "²", vk=50)
    # ç á ã, as an ABNT2 or US-international layout makes them
    for ch in "çáã":
        await c.call("Input.insertText", text=ch)
    # Shift+A
    await key("A", "KeyA", "A", mods=8, vk=65)
    await enter()
    L = await log()
    want = "U+0061 U+00E4 U+0022 U+00B2 U+00E7 U+00E1 U+00E3 U+0041"
    check("typed a ä \" ² ç á ã A, each once", f"typetest: typed {want} (" in L,
          re.findall(r"typetest: typed [^\n]*", L)[-1:])
    # Backspace and an arrow come from keydown; Ctrl+C is a shortcut, not text
    await key("x", "KeyX", "x", vk=88)
    await key("y", "KeyY", "y", vk=89)
    await key("Backspace", "Backspace", vk=8)
    await key("c", "KeyC", None, mods=2, vk=67)
    await enter()
    L = await log()
    check("Backspace from keydown, Ctrl+C typed nothing", "typetest: typed U+0078 (" in L, re.findall(r"typetest: typed [^\n]*", L)[-1:])
    # paste: the clipboard's text (a synthetic paste event: no real clipboard here)
    await c.js("""(() => { const d = new DataTransfer(); d.setData('text/plain', 'ms12 ç€\\n');
      document.querySelector('#screen-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); })()""")
    await asyncio.sleep(0.6)
    await enter()
    L = await log()
    check("pasted, without the last newline, € dropped", "typetest: typed U+006D U+0073 U+0031 U+0032 U+0020 U+00E7 (" in L,
          re.findall(r"typetest: typed [^\n]*", L)[-1:])
    check("pasted 6 of 7, logged", "pasted 6 of 7 characters" in L)
    check("one warning", L.count("other characters are dropped") == 1)
    # the editor: clicking it takes the keyboard back; typing goes there, not to GapKeep
    ed = await c.js("(() => { const r = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return [r.x + 40, r.y + 10]; })()")
    for t in ("mousePressed", "mouseReleased"):
        await c.call("Input.dispatchMouseEvent", type=t, x=ed[0], y=ed[1], button="left", clickCount=1)
    await asyncio.sleep(0.3)
    focus = await c.js("document.activeElement.className")
    check("the editor has the focus again", "inputarea" in focus or "monaco" in focus or "native-edit-context" in focus, focus)
    before = (await log()).count("typetest: key")
    await key("q", "KeyQ", "q", vk=81)
    await asyncio.sleep(0.3)
    check("a key in the editor doesn't reach GapKeep", (await log()).count("typetest: key") == before)
    print(f"ide_typing: {sum(results)} passed, {len(results) - sum(results)} failed")


def examples():
    """The IDE's example apps, and typetest, as tools/gkide.sh puts them."""
    out = os.path.join(ROOT, "sim", "build", "web", "examples")
    shutil.rmtree(out, ignore_errors=True)
    apps = {}
    for app, src in [(a, os.path.join(ROOT, "apps", a)) for a in EXAMPLES] + \
                    [("typetest", os.path.join(ROOT, "tests", "apps", "typetest"))]:
        shutil.copytree(src, os.path.join(out, app))
        apps[app] = sorted(os.path.relpath(os.path.join(d, f), os.path.join(out, app)).replace(os.sep, "/")
                           for d, _, fs in os.walk(os.path.join(out, app)) for f in fs if not f.startswith("."))
    with open(os.path.join(ROOT, "sim", "build", "web", "examples.json"), "w") as f:
        json.dump({"apps": apps}, f, indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--chrome", default=shutil.which("google-chrome") or shutil.which("chromium"))
    args = ap.parse_args()
    for need in ("sim/build/web/gksim.js", "sim/web/vendor/monaco/vs/loader.js"):
        if not os.path.exists(os.path.join(ROOT, need)):
            sys.exit(f"ide_typing: no {need} (make -C sim web; tools/fetch_monaco.sh)")
    if not args.chrome:
        sys.exit("ide_typing: no Chrome (--chrome PATH)")
    examples()
    profile = tempfile.mkdtemp(prefix="gk-ide-chrome-")
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                               "--directory", os.path.join(ROOT, "sim")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = subprocess.Popen([args.chrome, "--headless=new", f"--remote-debugging-port={DEBUG_PORT}",
                               "--remote-debugging-address=127.0.0.1", f"--user-data-dir={profile}",
                               "--no-first-run", "--window-size=1400,900", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json")
                break
            except OSError:
                time.sleep(0.1)
        asyncio.run(asyncio.wait_for(run(), 150))
    finally:
        chrome.terminate()
        server.terminate()
        chrome.wait()
        shutil.rmtree(profile, ignore_errors=True)
    sys.exit(0 if results and all(results) else 1)


if __name__ == "__main__":
    main()
