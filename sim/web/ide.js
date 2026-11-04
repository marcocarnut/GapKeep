// ide.js - the zerogap browser IDE (docs/IDE.md): a file tree of the apps
// on a simulated SD card, a Monaco editor, the zerogap screen (the
// simulator compiled to WebAssembly, through zerogap.js) and its log.
// Static files only; the work is kept in the browser's IndexedDB.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { Zerogap, MOD_SHIFT, MOD_CTRL, MOD_ALT } from "./zerogap.js";
import { Store } from "./store.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById (id);
const here = (rel) => new URL (rel, import.meta.url).href;

const SIZES = [[640, 480], [800, 480], [800, 600], [1024, 600], [1024, 768], [1280, 720], [1824, 984]];
// Apps built into zerogap. The IDE's copy of one replaces it in the
// simulator (its "builtin" folder), so the launcher can be worked on here;
// on the device, built-in apps come from the kernel image only.
const BUILTIN = new Set (["launcher"]);
const EXAMPLES_URL = here ("../build/web/examples.json");   // written by tools/zgide.sh
const EXAMPLES_DIR = here ("../build/web/examples/");
const TYPES_URL = here ("types/zerogap.d.ts");
const MONACO_VS = here ("vendor/monaco/vs");

// What docs/APPS.md allows: app ids, and file and folder names.
const APP_ID = /^[a-z0-9-]+$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// State

let store;                  // Store (IndexedDB)
const files = new Map ();   // "apps/<id>/<rel>" -> string | Uint8Array, as saved
let monaco, editor;
const models = new Map ();  // path -> Monaco model (text files)
const savedVersion = new Map ();  // path -> model version id when last saved
let current = null;         // path of the file in the editor
let selected = null;        // { path, kind: "app" | "dir" | "file" }
const expanded = new Set (JSON.parse (localStorage.getItem ("zgide.expanded") || "[]"));
let binaryModel = null;     // read-only stand-in shown for binary files

let machine = null;         // the running Zerogap instance
let runToken = 0;           // the latest run() wins when several overlap
let runningApp = null;      // the app zerogap says it started (from the log)
let lastApp = null;         // what Run launched last (for screen size changes)
const sizeName = ([w, h]) => `${w}x${h}`;
let size = SIZES.find ((s) => sizeName (s) === localStorage.getItem ("zgide.size")) || SIZES[0];

// ---------------------------------------------------------------------------
// Helpers

const appOf = (path) => path && path.startsWith ("apps/") ? path.split ("/")[1] : null;
const relOf = (path) => path.split ("/").slice (2).join ("/");
const isText = (data) => typeof data === "string";

function languageOf (path) {
  if (/\.d\.ts$/.test (path)) return "typescript";
  if (/\.m?js$/.test (path)) return "javascript";
  if (/\.json$/.test (path)) return "json";
  if (/\.md$/.test (path)) return "markdown";
  return "plaintext";
}

// UTF-8 text when it is valid UTF-8, else the bytes.
function decode (buffer) {
  try {
    return new TextDecoder ("utf-8", { fatal: true }).decode (buffer);
  } catch {
    return new Uint8Array (buffer);
  }
}

function validPath (rel) {
  return rel.split ("/").every ((part) => NAME.test (part));
}

function download (blob, name) {
  const a = document.createElement ("a");
  a.href = URL.createObjectURL (blob);
  a.download = name;
  a.click ();
  setTimeout (() => URL.revokeObjectURL (a.href), 10000);
}

function setStatus (text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

// ---------------------------------------------------------------------------
// Console

const MAX_LINES = 5000;
let logApp = null;          // the app the log is about, to resolve "main.js:3:5"

const ERROR_RE = /not loaded:|uncaught exception|Error|FAIL/;
// "lib/x.js:2:7", "main.js:4", "apps/hello/main.js:1:1"
const FILE_REF_RE = /([A-Za-z0-9_.\/-]+\.(?:m?js|json|txt)):(\d+)(?::(\d+))?/g;
const NOT_LOADED_RE = /appstore: ((?:apps|builtin)\/([^\s:]+)) not loaded: (.*)$/;

function consoleAppend (text, cls) {
  const box = $("console");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const div = document.createElement ("div");
  if (cls) div.className = cls;
  linkify (div, text);
  box.append (div);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove ();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function link (text, path, line, col) {
  const a = document.createElement ("a");
  a.textContent = text;
  a.title = path + (line ? ":" + line : "");
  a.onclick = () => openFile (path, line, col);
  return a;
}

// Fills div with text, making file references clickable.
function linkify (div, text) {
  const notLoaded = text.match (NOT_LOADED_RE);
  if (notLoaded) {
    // Open the file the reason names ("manifest.json: unknown icon"), else
    // the manifest.
    const [, folderText, folder, reason] = notLoaded;
    const named = reason.match (/^([A-Za-z0-9_.\/-]+):/);
    let target = `apps/${folder}/manifest.json`;
    if (named && files.has (`apps/${folder}/${named[1]}`)) target = `apps/${folder}/${named[1]}`;
    const at = text.indexOf (folderText);
    div.append (text.slice (0, at), link (folderText, target), text.slice (at + folderText.length));
    return;
  }
  let last = 0;
  for (const m of text.matchAll (FILE_REF_RE)) {
    const [whole, ref, line, col] = m;
    const path = ref.startsWith ("apps/") ? ref : logApp ? `apps/${logApp}/${ref}` : null;
    if (!path || !files.has (path)) continue;
    div.append (text.slice (last, m.index), link (whole, path, Number (line), Number (col) || 1));
    last = m.index + whole.length;
  }
  div.append (text.slice (last));
}

// A line from zerogap's log.
function onLog (line) {
  let m;
  if ((m = line.match (/ apphost: Starting (\S+)/))) {
    logApp = runningApp = m[1];
    if (m[1] !== "launcher") lastApp = m[1];
    updateStatus ();
    renderTree ();
  } else if ((m = line.match (/ apphost: (\S+): uncaught exception/))) {
    logApp = m[1];
  }
  let cls = "";
  if (ERROR_RE.test (line) || / apphost:\s+at /.test (line)) cls = "error";
  else if (/ app:[^:\s]+:/.test (line)) cls = "app";
  consoleAppend (line.replace (/\n+$/, ""), cls);
}

// A line from the IDE itself.
function ideLog (text, error = false) {
  consoleAppend ("ide: " + text, error ? "ide error" : "ide");
}

// ---------------------------------------------------------------------------
// Files: the in-memory card, its Monaco models, and IndexedDB

function ensureModel (path) {
  if (models.has (path) || !isText (files.get (path))) return models.get (path);
  const uri = monaco.Uri.from ({ scheme: "file", path: "/" + path });
  const model = monaco.editor.createModel (files.get (path), languageOf (path), uri);
  models.set (path, model);
  savedVersion.set (path, model.getAlternativeVersionId ());
  model.onDidChangeContent (() => markDirtyChanged (path));
  return model;
}

function isDirty (path) {
  const model = models.get (path);
  return !!model && model.getAlternativeVersionId () !== savedVersion.get (path);
}

const dirtyShown = new Map ();
function markDirtyChanged (path) {
  const dirty = isDirty (path);
  if (dirtyShown.get (path) === dirty) return;
  dirtyShown.set (path, dirty);
  renderTree ();
  updateTitle ();
}

function dropModel (path) {
  models.get (path)?.dispose ();
  models.delete (path);
  savedVersion.delete (path);
  dirtyShown.delete (path);
}

async function saveFile (path) {
  const model = models.get (path);
  if (!model) return;
  const text = model.getValue ();
  files.set (path, text);
  await store.put (path, text);
  savedVersion.set (path, model.getAlternativeVersionId ());
  markDirtyChanged (path);
}

async function saveAll (filter = () => true) {
  const paths = [...models.keys ()].filter ((p) => isDirty (p) && filter (p));
  for (const p of paths) await saveFile (p);
  return paths.length;
}

// Adds or replaces files: { path: data }. Saved at once.
async function addFiles (entries) {
  const put = Object.entries (entries);
  for (const [path, data] of put) {
    files.set (path, data);
    const model = models.get (path);
    if (model && isText (data)) {
      model.setValue (data);
      savedVersion.set (path, model.getAlternativeVersionId ());
      markDirtyChanged (path);
    } else {
      if (model) dropModel (path);
      ensureModel (path);
    }
  }
  await store.change ({ put });
}

// Everything under prefix ("apps/x", "apps/x/lib") or that exact file.
function pathsUnder (prefix) {
  return [...files.keys ()].filter ((p) => p === prefix || p.startsWith (prefix + "/"));
}

async function deletePaths (paths) {
  for (const p of paths) {
    files.delete (p);
    dropModel (p);
  }
  await store.change ({ del: paths });
  if (current && !files.has (current)) openFile (null);
}

// Moves oldPrefix to newPrefix, keeping unsaved edits as unsaved edits
// (Monaco models can't change their URI, so they are recreated).
async function movePaths (oldPrefix, newPrefix) {
  const put = [], del = [];
  let reopen = null;
  for (const p of pathsUnder (oldPrefix)) {
    const q = newPrefix + p.slice (oldPrefix.length);
    const data = files.get (p);
    const edited = models.get (p)?.getValue ();
    put.push ([q, data]);
    del.push (p);
    files.delete (p);
    dropModel (p);
    files.set (q, data);
    const model = ensureModel (q);
    if (model && edited !== undefined && edited !== data) {
      model.setValue (edited);
      savedVersion.set (q, -1);   // unsaved
    }
    if (p === current) reopen = q;
  }
  await store.change ({ put, del });
  if (reopen) openFile (reopen);
}

// ---------------------------------------------------------------------------
// The file tree

function buildTree () {
  const root = { children: new Map () };
  for (const path of files.keys ()) {
    const parts = path.split ("/");
    if (parts[0] !== "apps" || parts.length < 3) continue;
    let node = root, acc = "apps";
    for (let i = 1; i < parts.length; i++) {
      acc += "/" + parts[i];
      if (!node.children.has (parts[i])) {
        const kind = i === parts.length - 1 ? "file" : i === 1 ? "app" : "dir";
        node.children.set (parts[i], { name: parts[i], path: acc, kind, children: new Map () });
      }
      node = node.children.get (parts[i]);
    }
  }
  return root;
}

function appName (id) {
  try {
    return JSON.parse (files.get (`apps/${id}/manifest.json`)).name || "";
  } catch {
    return "";
  }
}

function renderTree () {
  const tree = $("tree");
  const scroll = tree.scrollTop;
  tree.replaceChildren ();
  const sorted = (node) => [...node.children.values ()].sort ((a, b) =>
    (a.kind === "file") - (b.kind === "file") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const add = (parent, node, depth) => {
    const li = document.createElement ("li");
    const row = document.createElement ("div");
    row.className = "row " + node.kind;
    row.style.paddingLeft = 8 + depth * 12 + "px";
    row.dataset.path = node.path;
    row.setAttribute ("role", "treeitem");
    const folder = node.kind !== "file";
    const open = folder && expanded.has (node.path);
    const twisty = document.createElement ("span");
    twisty.className = "twisty";
    twisty.textContent = folder ? (open ? "▾" : "▸") : "";
    const name = document.createElement ("span");
    name.className = "name";
    name.textContent = node.name;
    row.append (twisty, name);
    if (node.kind === "app") {
      const meta = document.createElement ("span");
      meta.className = "meta";
      meta.textContent = appName (node.name) + (BUILTIN.has (node.name) ? " (built in)" : "");
      if (BUILTIN.has (node.name)) {
        meta.title = "Built into zerogap. This copy replaces it in the simulator; " +
          "on the device, change apps/" + node.name + " in the repository and rebuild the kernel.";
      }
      row.append (meta);
      if (machine && runningApp === node.name) name.classList.add ("running");
    }
    if (node.kind === "file" && isDirty (node.path)) name.classList.add ("dirty");
    if (selected?.path === node.path) row.classList.add ("selected");
    if (node.path === current) row.classList.add ("open");
    row.onclick = () => {
      selected = { path: node.path, kind: node.kind };
      if (folder) toggle (node.path);
      else openFile (node.path);
      renderTree ();
    };
    li.append (row);
    if (open) {
      const ul = document.createElement ("ul");
      for (const child of sorted (node)) add (ul, child, depth + 1);
      li.append (ul);
    }
    parent.append (li);
  };
  for (const app of sorted (buildTree ())) add (tree, app, 0);
  if (!files.size) {
    const li = document.createElement ("li");
    li.className = "dim";
    li.style.padding = "8px";
    li.textContent = "No apps. Make one with New app, or Import.";
    tree.append (li);
  }
  tree.scrollTop = scroll;
}

function toggle (path, open = !expanded.has (path)) {
  if (open) expanded.add (path);
  else expanded.delete (path);
  localStorage.setItem ("zgide.expanded", JSON.stringify ([...expanded]));
}

// Expands the folders down to path.
function reveal (path) {
  const parts = path.split ("/");
  for (let i = 2; i < parts.length; i++) toggle (parts.slice (0, i).join ("/"), true);
}

// ---------------------------------------------------------------------------
// The editor

function openFile (path, line, col = 1) {
  if (path && !files.has (path)) {
    ideLog (`no such file: ${path}`, true);
    return;
  }
  current = path;
  localStorage.setItem ("zgide.open", path || "");
  if (!path) {
    editor.setModel (null);
  } else if (isText (files.get (path))) {
    editor.setModel (ensureModel (path));
    editor.updateOptions ({ readOnly: false });
  } else {
    binaryModel.setValue (`(${relOf (path)}: binary, ${files.get (path).length} bytes; ` +
      "zerogap only reads .js, .json and .txt files)");
    editor.setModel (binaryModel);
    editor.updateOptions ({ readOnly: true });
  }
  if (path) {
    reveal (path);
    selected = { path, kind: "file" };
  }
  if (path && line) {
    editor.revealLineInCenter (line);
    editor.setPosition ({ lineNumber: line, column: col });
    editor.focus ();
  }
  updateTitle ();
  renderTree ();
}

function updateTitle () {
  const t = $("file-title");
  t.textContent = current || "No file open";
  t.classList.toggle ("dirty", !!current && isDirty (current));
}

// Monaco's AMD build (vendor/monaco/vs, from tools/fetch_monaco.sh).
function loadMonaco () {
  return new Promise ((resolve, reject) => {
    const script = document.createElement ("script");
    script.src = MONACO_VS + "/loader.js";
    script.onload = () => {
      window.require.config ({ paths: { vs: MONACO_VS } });
      window.require (["vs/editor/editor.main"], () => resolve (window.monaco), reject);
    };
    script.onerror = () => reject (new Error ("Monaco is missing: run tools/fetch_monaco.sh"));
    document.head.append (script);
  });
}

// The manifest's keys and values, as docs/APPS.md lists them, for checks and
// completions in manifest.json. zerogap checks it again at boot.
const ICONS = ("audio video list ok close power settings home download drive refresh mute " +
  "volume-mid volume-max image tint prev play pause stop next eject left right plus minus " +
  "eye-open eye-close warning shuffle up down loop directory upload call cut copy save bars " +
  "envelope charge paste bell keyboard gps file wifi battery-full battery-3 battery-2 " +
  "battery-1 battery-empty usb bluetooth trash edit backspace sd-card new-line").split (" ");
const MANIFEST_SCHEMA = {
  type: "object",
  required: ["id", "name", "version"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9-]+$", description: "Unique id; must match the folder name." },
    name: { type: "string", description: "Shown in the launcher." },
    version: { type: "string", description: "Free-form, shown in logs." },
    description: { type: "string", description: "One line for the launcher tile." },
    icon: {
      description: "A ui.symbols name, or a picture { width, height, rgba } (tools/make_icon.py).",
      oneOf: [
        { type: "string", enum: ICONS },
        {
          type: "object", required: ["width", "height", "rgba"], additionalProperties: false,
          properties: {
            width: { type: "integer", minimum: 1, maximum: 128 },
            height: { type: "integer", minimum: 1, maximum: 128 },
            rgba: { type: "string" },
          },
        },
      ],
    },
    entry: { type: "string", description: "Entry module (default main.js)." },
    permissions: { type: "array", items: { enum: ["apps"] }, description: "Extra system modules." },
    hidden: { type: "boolean", description: "true: not listed in the launcher." },
  },
};

async function setupEditor () {
  monaco = await loadMonaco ();

  // JavaScript as zerogap runs it: ES2023 modules on QuickJS, no DOM. The
  // zg:* modules and the few globals (console, timers) come from
  // zerogap.d.ts. (monaco.typescript is new in 0.55; older: languages.typescript.)
  const ts = monaco.typescript || monaco.languages.typescript;
  const js = ts.javascriptDefaults;
  js.setCompilerOptions ({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    lib: ["es2023"],
    allowJs: true,
    checkJs: true,
    allowNonTsExtensions: true,
    noEmit: true,
  });
  js.setEagerModelSync (true);   // other files' models resolve "./lib/x.js"
  try {
    const r = await fetch (TYPES_URL);
    if (!r.ok) throw new Error (r.status + " " + r.statusText);
    js.addExtraLib (await r.text (), "file:///types/zerogap.d.ts");
  } catch (e) {
    ideLog (`could not load types/zerogap.d.ts (${e.message}): no zg:* completions`, true);
  }

  const json = monaco.json || monaco.languages.json;
  json.jsonDefaults.setDiagnosticsOptions ({
    validate: true,
    schemas: [{ uri: "zerogap://manifest.schema.json", fileMatch: ["**/manifest.json"], schema: MANIFEST_SCHEMA }],
  });

  monaco.editor.defineTheme ("zerogap", {
    base: "vs-dark", inherit: true, rules: [],
    colors: {
      "editor.background": "#292831",
      "editorGutter.background": "#292831",
      "editor.lineHighlightBackground": "#30303a",
      "editorCursor.foreground": "#ffc300",
      "focusBorder": "#00968c",
    },
  });
  editor = monaco.editor.create ($("editor"), {
    model: null,
    theme: "zerogap",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
  });
  binaryModel = monaco.editor.createModel ("", "plaintext", monaco.Uri.parse ("zgide:binary"));
}

// ---------------------------------------------------------------------------
// The machine

function updateStatus (text) {
  if (text) return setStatus (text, "");
  if (!machine) return setStatus ("stopped");
  if (machine.halted) return setStatus ("halted: Run or Restart to boot again", "error");
  setStatus (`running ${runningApp || "..."}`, "running");
}

function stopMachine () {
  if (machine) machine.stop ();
  machine = null;
  runningApp = null;
}

// Boots a fresh machine with the card as saved, then starts appId (or
// stays on the launcher).
async function run (appId, { focus = true } = {}) {
  const token = ++runToken;
  const saved = await saveAll ();
  if (saved) ideLog (`saved ${saved} file${saved === 1 ? "" : "s"}`);
  stopMachine ();
  updateStatus ("booting...");
  const [w, h] = size;
  let zg;
  try {
    zg = await Zerogap.create ({
      onLog: (line) => { if (machine === zg) onLog (line); },
      onHalt: () => { if (machine === zg) { updateStatus (); renderTree (); } },
    });
  } catch (e) {
    ideLog (`could not load the simulator (${e.message}); build it with tools/zgide.sh`, true);
    updateStatus ("no simulator");
    return;
  }
  if (token !== runToken) return;   // a later run() took over
  machine = zg;
  logApp = null;
  const card = {}, builtin = {};
  for (const [path, data] of files) {
    if (!path.startsWith ("apps/")) continue;
    if (BUILTIN.has (appOf (path))) builtin[path.slice (5)] = data;
    else card[path] = data;
  }
  if (Object.keys (card).length) zg.writeCard (card);
  if (Object.keys (builtin).length) zg.writeBuiltin (builtin);
  const canvas = $("screen");
  canvas.width = w;
  canvas.height = h;
  fitScreen ();
  ideLog (`boot ${w}x${h}` + (appId ? `, then start ${appId}` : ""));
  try {
    zg.boot (w, h);
  } catch (e) {
    ideLog (e.message, true);
    if (builtin["launcher/main.js"] !== undefined) {
      ideLog ("zerogap starts with the launcher, and that is the copy in apps/launcher: " +
        "fix it (see the error above), or delete apps/launcher to use the built-in one", true);
    }
    stopMachine ();
    updateStatus ();
    return;
  }
  zg.start ();
  lastApp = appId;
  if (appId && !zg.launch (appId)) {
    ideLog (`${appId} did not start (see "not loaded" above); staying on the launcher`, true);
  }
  updateStatus ();
  renderTree ();
  if (focus) canvas.focus ();
}

// The app to run: that of the open file, else the selected one.
const appToRun = () => appOf (current) || appOf (selected?.path);

function home () {
  if (!machine) return;
  // zerogap's Home is the Windows key, which browsers and desktops keep
  // for themselves; the button sends it.
  machine.keyDown ("Meta");
  setTimeout (() => machine?.keyUp (), 50);
  $("screen").focus ();
}

// ---------------------------------------------------------------------------
// The screen: size, scaling, input, painting

function fitScreen () {
  const canvas = $("screen"), box = $("screen-box");
  const [w, h] = [canvas.width, canvas.height];
  const dpr = window.devicePixelRatio || 1;
  // In device pixels, so "integer" means really sharp on HiDPI screens too.
  let s = Math.min ((box.clientWidth - 8) * dpr / w, (box.clientHeight - 8) * dpr / h);
  if (s >= 1) s = Math.floor (s);
  if (!(s > 0)) s = 1;
  canvas.style.width = (w * s) / dpr + "px";
  canvas.style.height = (h * s) / dpr + "px";
  const scale = Number.isInteger (s) ? s + "x" : s.toFixed (2) + "x";
  $("screen-info").textContent = `${w}x${h} at ${scale}`;
}

// Keys whose browser default (scroll, leave the canvas, go back...) must not
// happen while the screen has the keyboard, even if zerogap ignores them.
const BROWSER_KEYS = new Set (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace",
  " ", "Enter", "Escape", "Home", "End", "PageUp", "PageDown", "F1", "F3", "F5", "F6", "F7", "Delete"]);
let heldCode = null;   // the key zerogap is repeating

function setupScreen () {
  const canvas = $("screen");
  const sel = $("size");
  SIZES.forEach (([w, h], i) => sel.add (new Option (`${w} x ${h}`, i)));
  sel.value = SIZES.indexOf (size);
  sel.onchange = () => {
    size = SIZES[sel.value];
    localStorage.setItem ("zgide.size", sizeName (size));
    run (machine ? lastApp : null);
  };

  new ResizeObserver (fitScreen).observe ($("screen-box"));

  const hint = () => {
    const focused = document.activeElement === canvas;
    $("screen-hint").textContent = focused ? "keyboard goes to zerogap" : "click the screen to type into it";
    $("screen-hint").classList.toggle ("focused", focused);
  };
  canvas.addEventListener ("focus", hint);
  canvas.addEventListener ("blur", () => {
    if (heldCode) machine?.keyUp ();
    heldCode = null;
    hint ();
  });
  hint ();

  canvas.addEventListener ("keydown", (e) => {
    if (!machine) return;
    if (e.repeat) {           // zerogap repeats keys itself
      e.preventDefault ();
      return;
    }
    const mods = (e.shiftKey ? MOD_SHIFT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.altKey ? MOD_ALT : 0);
    if (machine.keyDown (e.key, mods)) {
      heldCode = e.code;
      e.preventDefault ();
    } else if (BROWSER_KEYS.has (e.key)) {
      e.preventDefault ();
    }
  });
  canvas.addEventListener ("keyup", (e) => {
    // zerogap has one key down at a time: release it only when that key is
    // let go (not, say, the Shift that came with it).
    if (machine && e.code === heldCode) {
      machine.keyUp ();
      heldCode = null;
    }
    e.preventDefault ();
  });

  // Mouse: CSS pixels on the scaled canvas -> zerogap's screen pixels.
  const toScreen = (e) => {
    const r = canvas.getBoundingClientRect ();
    const x = (e.clientX - r.left) * canvas.width / r.width;
    const y = (e.clientY - r.top) * canvas.height / r.height;
    return [Math.min (Math.max (x, 0), canvas.width - 1), Math.min (Math.max (y, 0), canvas.height - 1)];
  };
  canvas.addEventListener ("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.focus ();
    canvas.setPointerCapture (e.pointerId);   // keep dragging outside the canvas
    machine?.pointer (...toScreen (e), true);
    e.preventDefault ();
  });
  canvas.addEventListener ("pointermove", (e) => machine?.pointer (...toScreen (e), (e.buttons & 1) !== 0));
  canvas.addEventListener ("pointerup", (e) => {
    if (e.button === 0) machine?.pointer (...toScreen (e), false);
  });
  canvas.addEventListener ("contextmenu", (e) => e.preventDefault ());

  const paint = () => {
    if (machine) machine.draw (canvas);
    requestAnimationFrame (paint);
  };
  requestAnimationFrame (paint);
}

// ---------------------------------------------------------------------------
// File actions

function template (id) {
  const name = id.split ("-").map ((w) => w[0].toUpperCase () + w.slice (1)).join (" ");
  return {
    [`apps/${id}/manifest.json`]: JSON.stringify ({
      id, name, version: "0.1.0", description: "A new app.", icon: "file",
    }, null, 2) + "\n",
    [`apps/${id}/main.js`]:
`// ${name}: a new zerogap app. See docs/APPS.md and docs/API.md.

import * as ui from "zg:ui";

const label = new ui.Label({ text: "Hello from ${id}!", font: 24 });

let count = 0;
const button = new ui.Button({
  text: ui.symbols.plus + " Click me",
  onClick: () => {
    count++;
    label.text = \`Clicked \${count} time\${count === 1 ? "" : "s"}\`;
    console.log("clicked", count);
  },
});

button.focus();
`,
  };
}

const appIds = () => new Set ([...files.keys ()].map (appOf).filter (Boolean));

async function newApp () {
  const id = prompt ("New app id (a-z, 0-9 and -; also its folder name):", "myapp")?.trim ();
  if (!id) return;
  if (!APP_ID.test (id)) return alert (`"${id}" is not a valid app id: use a-z, 0-9 and -.`);
  if (BUILTIN.has (id)) return alert (`"${id}" is a built-in app's id; Examples adds a copy of it to edit.`);
  if (appIds ().has (id)) return alert (`There is already an app "${id}".`);
  await addFiles (template (id));
  openFile (`apps/${id}/main.js`);
}

// The folder new files go in: the selected app or folder, or that of the
// selected file.
function targetFolder () {
  const s = selected || (current && { path: current, kind: "file" });
  if (!s) return null;
  return s.kind === "file" ? s.path.slice (0, s.path.lastIndexOf ("/")) : s.path;
}

async function newFile () {
  const folder = targetFolder ();
  if (!folder) return alert ("Select an app (or a folder in it) first.");
  const rel = prompt (`New file in ${folder}/ (subfolders with /):`, "lib/util.js")?.trim ();
  if (!rel) return;
  if (!validPath (rel)) return alert ("Names may use A-Z a-z 0-9 . _ - and must not start with \".\".");
  const path = `${folder}/${rel}`;
  if (files.has (path)) return alert (`${path} exists already.`);
  if (pathsUnder (path).length) return alert (`${path} is a folder.`);
  if (!/\.(js|json|txt)$/.test (rel)) ideLog (`note: zerogap ignores files other than .js, .json and .txt (${rel})`);
  await addFiles ({ [path]: /\.js$/.test (rel) ? "import * as ui from \"zg:ui\";\n\n" : "" });
  openFile (path);
}

async function renameSelected () {
  if (!selected) return alert ("Select an app, folder or file first.");
  const { path, kind } = selected;
  if (kind === "app") {
    const old = appOf (path);
    const id = prompt (`Rename app "${old}" (its folder and its manifest's id) to:`, old)?.trim ();
    if (!id || id === old) return;
    if (!APP_ID.test (id)) return alert (`"${id}" is not a valid app id: use a-z, 0-9 and -.`);
    if (appIds ().has (id)) return alert (`There is already an app "${id}".`);
    await movePaths (path, `apps/${id}`);
    // The id must match the folder: update the manifest when it is plain JSON.
    const mpath = `apps/${id}/manifest.json`;
    try {
      const m = JSON.parse (files.get (mpath));
      if (m.id === old) {
        m.id = id;
        await addFiles ({ [mpath]: JSON.stringify (m, null, 2) + "\n" });
      }
    } catch {
      ideLog (`check the id in ${mpath}: it must be "${id}"`, true);
    }
    selected = { path: `apps/${id}`, kind };
    if (expanded.has (path)) toggle (`apps/${id}`, true);
  } else {
    const app = path.split ("/").slice (0, 2).join ("/");
    const rel = prompt (`Rename (path inside ${app}/):`, relOf (path))?.trim ();
    if (!rel || rel === relOf (path)) return;
    if (!validPath (rel)) return alert ("Names may use A-Z a-z 0-9 . _ - and must not start with \".\".");
    const to = `${app}/${rel}`;
    if (pathsUnder (to).length) return alert (`${to} exists already.`);
    await movePaths (path, to);
    selected = { path: to, kind };
    if (kind === "dir") reveal (to + "/x");
  }
  renderTree ();
}

async function deleteSelected () {
  if (!selected) return alert ("Select an app, folder or file first.");
  const paths = pathsUnder (selected.path);
  const what = selected.kind === "file" ? selected.path : `${selected.path}/ (${paths.length} files)`;
  if (!confirm (`Delete ${what}? This cannot be undone (export it first to keep a copy).`)) return;
  await deletePaths (paths);
  selected = null;
  renderTree ();
}

// <input webkitdirectory> gives every file with its path from the chosen
// folder: "counter/main.js" for an app, "apps/counter/main.js" for a folder
// of apps (a card's apps/, or the repository's).
async function importFolder (list) {
  const all = [...list].filter ((f) => !f.webkitRelativePath.split ("/").some ((p) => p.startsWith (".")));
  if (!all.length) return;
  const top = all[0].webkitRelativePath.split ("/")[0];
  const single = all.some ((f) => f.webkitRelativePath === `${top}/manifest.json`);
  const apps = new Map ();   // id -> [[rel, File]]
  for (const f of all) {
    const parts = f.webkitRelativePath.split ("/").slice (1);
    const id = single ? top : parts.shift ();
    if (!parts.length) continue;   // a loose file in a folder of apps
    if (!apps.has (id)) apps.set (id, []);
    apps.get (id).push ([parts.join ("/"), f]);
  }
  for (const [id, entries] of apps) {
    if (!entries.some (([rel]) => rel === "manifest.json")) {
      ideLog (`import: skipped ${id}/ (no manifest.json)`, true);
      continue;
    }
    if (!APP_ID.test (id)) ideLog (`import: "${id}" is not a valid app id; zerogap will refuse it until renamed`, true);
    if (appIds ().has (id)) {
      if (!confirm (`Replace the app "${id}" with the imported one?`)) continue;
      await deletePaths (pathsUnder (`apps/${id}`));
    }
    const add = {};
    for (const [rel, f] of entries) add[`apps/${id}/${rel}`] = decode (await f.arrayBuffer ());
    await addFiles (add);
    ideLog (`imported ${id} (${entries.length} files)`);
    toggle (`apps/${id}`, true);
  }
  renderTree ();
}

async function exportApp () {
  const id = appOf (selected?.path) || appOf (current);
  if (!id) return alert ("Select the app to export first.");
  const saved = await saveAll ((p) => appOf (p) === id);
  if (saved) ideLog (`saved ${saved} file${saved === 1 ? "" : "s"} of ${id} before exporting`);
  const entries = pathsUnder (`apps/${id}`).sort ().map ((p) => ({ name: `${id}/${relOf (p)}`, data: files.get (p) }));
  download (makeZip (entries), `${id}.zip`);
  ideLog (BUILTIN.has (id)
    ? `exported ${id}.zip (${entries.length} files): ${id} is built in, so unzip it over apps/${id} in the repository and rebuild the kernel`
    : `exported ${id}.zip (${entries.length} files): unzip it into the card's apps/ folder`);
}

// The example apps that tools/zgide.sh copies to sim/build/web/examples.
// only: the apps to add (default: all).
async function fetchExamples (only = null) {
  const r = await fetch (EXAMPLES_URL);
  if (!r.ok) throw new Error (`${EXAMPLES_URL}: ${r.status} (start the IDE with tools/zgide.sh)`);
  const index = (await r.json ()).apps;
  const add = {};
  for (const [id, list] of Object.entries (index)) {
    if (only && !only.includes (id)) continue;
    await Promise.all (list.map (async (rel) => {
      const f = await fetch (EXAMPLES_DIR + id + "/" + rel);
      if (!f.ok) throw new Error (`${id}/${rel}: ${f.status}`);
      add[`apps/${id}/${rel}`] = decode (await f.arrayBuffer ());
    }));
  }
  await addFiles (add);
  return Object.keys (index).filter ((id) => !only || only.includes (id));
}

async function restoreExamples () {
  try {
    const r = await fetch (EXAMPLES_URL);
    const ids = Object.keys ((await r.json ()).apps).filter ((id) => !appIds ().has (id));
    if (!ids.length) return ideLog ("all the example apps are there already");
    await fetchExamples (ids);
    ideLog (`added ${ids.join (", ")}`);
    renderTree ();
  } catch (e) {
    ideLog (`could not fetch the examples: ${e.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Start

function setupUi () {
  $("new-app").onclick = newApp;
  $("new-file").onclick = newFile;
  $("rename").onclick = renameSelected;
  $("delete").onclick = deleteSelected;
  $("import").onclick = () => $("import-input").click ();
  $("import-input").onchange = async (e) => {
    await importFolder (e.target.files);
    e.target.value = "";
  };
  $("export").onclick = exportApp;
  $("examples").onclick = restoreExamples;
  $("run").onclick = () => run (appToRun ());
  $("stop").onclick = () => { stopMachine (); updateStatus (); renderTree (); };
  $("home").onclick = home;
  $("restart").onclick = () => run (null);
  $("clear").onclick = () => $("console").replaceChildren ();

  // Ctrl/Cmd+S and Ctrl/Cmd+Enter everywhere except on the screen, where
  // every key belongs to zerogap. Capture phase, so Monaco doesn't see them.
  window.addEventListener ("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target === $("screen")) return;
    if (e.key === "s" || e.key === "S") {
      e.preventDefault ();
      e.stopPropagation ();
      if (current) saveFile (current);
    } else if (e.key === "Enter") {
      e.preventDefault ();
      e.stopPropagation ();
      run (appToRun ());
    }
  }, true);

  window.addEventListener ("beforeunload", (e) => {
    if ([...models.keys ()].some (isDirty)) e.preventDefault ();
  });
}

async function main () {
  setupUi ();
  setupScreen ();
  try {
    await setupEditor ();
  } catch (e) {
    const msg = document.createElement ("div");
    msg.className = "message error";
    msg.textContent = `The editor did not load: ${e.message || e}`;
    $("editor").append (msg);
    setStatus ("no editor", "error");
    return;
  }
  store = await Store.open ();
  for (const [path, data] of await store.loadAll ()) files.set (path, data);
  if (!(await store.getMeta ("seeded"))) {
    try {
      const ids = await fetchExamples ();
      ideLog (`welcome: added the example apps ${ids.join (", ")}`);
      await store.setMeta ("seeded", true);
    } catch (e) {
      ideLog (`could not fetch the example apps: ${e.message}`, true);
    }
  }
  for (const path of files.keys ()) ensureModel (path);
  const last = localStorage.getItem ("zgide.open");
  if (last && files.has (last)) openFile (last);
  else if (files.has ("apps/hello/main.js")) openFile ("apps/hello/main.js");
  else renderTree ();
  // Boot into the launcher, as the device does when switched on.
  await run (null, { focus: false });
}

// For scripts and tests: window.zgide.run("hello"), .open("apps/x/main.js", 3)...
window.zgide = {
  run, home, openFile, files, stop: () => $("stop").click (),
  get machine () { return machine; },
  get editor () { return editor; },
  get monaco () { return monaco; },
};

main ().catch ((e) => {
  setStatus ("failed to start", "error");
  ideLog (`failed to start: ${e.stack || e}`, true);
});
