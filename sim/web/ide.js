// ide.js - the GapKeep browser IDE (docs/IDE.md): a file tree of the apps
// on a simulated SD card, a Monaco editor, the GapKeep screen (the
// simulator compiled to WebAssembly, through gapkeep.js) and its log.
// Static files only; the work is kept in the browser's IndexedDB.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { Gapkeep } from "./gapkeep.js";
import { TextInput, MOD_SHIFT } from "./textinput.js";
import { Store } from "./store.js";
import { makeZip } from "./zip.js";
import { CameraBar } from "./camera.js";

const $ = (id) => document.getElementById (id);
const here = (rel) => new URL (rel, import.meta.url).href;

const SIZES = [[640, 480], [800, 480], [800, 600], [1024, 600], [1024, 768], [1280, 720], [1824, 984]];
// Apps built into GapKeep. The IDE's copy of one replaces it in the
// simulator (its "builtin" folder), so the launcher can be worked on here;
// on the device, built-in apps come from the kernel image only.
const BUILTIN = new Set (["launcher"]);
// Fetched with cache: "no-cache": a hard reload doesn't refresh what a page
// fetches later, and http.server sends no cache headers, so a browser would
// otherwise keep an old copy after tools/gkide.sh rebuilds them.
const EXAMPLES_URL = here ("../build/web/examples.json");   // written by tools/gkide.sh
const EXAMPLES_DIR = here ("../build/web/examples/");
const TYPES_URL = here ("types/gapkeep.d.ts");
const MONACO_VS = here ("vendor/monaco/vs");

// What docs/APPS.md allows: app ids, and file and folder names.
const APP_ID = /^[a-z0-9-]+$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// The phone layout (ide.css has the same media query): the screen first,
// the panes under it, folded; the editor loaded only when unfolded.
const PHONE = matchMedia ("(max-width: 760px), (pointer: coarse) and (max-height: 500px)");

// The address's parameters (docs/IDE.md, "Links"): ?run=<app id> boots
// into that app; ?lang=pt-BR boots in that language (the card's gapkeep.txt).
const params = new URLSearchParams (location.search);
const LANG_RE = /^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|qps)$/;
const language = LANG_RE.test (params.get ("lang") || "") ? params.get ("lang") : null;

// ---------------------------------------------------------------------------
// State

let store;                  // Store (IndexedDB)
const files = new Map ();   // "apps/<id>/<rel>" -> string | Uint8Array, as saved
let monaco, editor;
const models = new Map ();  // path -> Monaco model (text files)
const savedVersion = new Map ();  // path -> model version id when last saved
let current = null;         // path of the file in the editor
let selected = null;        // { path, kind: "app" | "dir" | "file" }
const expanded = new Set (JSON.parse (localStorage.getItem ("gkide.expanded") || "[]"));
let binaryModel = null;     // read-only stand-in shown for binary files

let machine = null;         // the running Gapkeep instance
let camera = null;          // CameraBar: what the camera films
let runToken = 0;           // the latest run() wins when several overlap
let runningApp = null;      // the app GapKeep says it started (from the log)
let lastApp = null;         // what Run launched last (for screen size changes)
const sizeName = ([w, h]) => `${w}x${h}`;
let size = SIZES.find ((s) => sizeName (s) === localStorage.getItem ("gkide.size")) || SIZES[0];

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

// A line from GapKeep's log.
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
  if (!monaco) return undefined;   // made for every file once the editor loads
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
    // the card's data folders (gk:data) show as one folder, "data"
    const data = parts[0] === "data";
    if ((parts[0] !== "apps" && !data) || parts.length < 3) continue;
    let node = root, acc = parts[0];
    if (data) {
      if (!root.children.has ("data/")) {
        root.children.set ("data/", { name: "data", path: "data", kind: "dir", children: new Map () });
      }
      node = root.children.get ("data/");
    }
    for (let i = 1; i < parts.length; i++) {
      acc += "/" + parts[i];
      if (!node.children.has (parts[i])) {
        const kind = i === parts.length - 1 ? "file" : i === 1 && !data ? "app" : "dir";
        node.children.set (parts[i], { name: parts[i], path: acc, kind, children: new Map () });
      }
      node = node.children.get (parts[i]);
    }
  }
  return root;
}

function appName (id) {
  try {
    const suite = files.get (`apps/${id}/suite.json`);   // a suite: its name, marked
    if (suite !== undefined) return (JSON.parse (suite).name || "") + " (suite)";
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
        meta.title = "Built into GapKeep. This copy replaces it in the simulator; " +
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
  localStorage.setItem ("gkide.expanded", JSON.stringify ([...expanded]));
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
  localStorage.setItem ("gkide.open", path || "");
  if (!editor) {
    // Monaco loads late (after the boot, or when a phone unfolds the
    // editor): it opens this file, at this line, when it is there.
    pendingLine = path && line ? [line, col] : null;
    if (path) {
      reveal (path);
      selected = { path, kind: "file" };
      showEditor ();
    }
    updateTitle ();
    renderTree ();
    return;
  }
  if (!path) {
    editor.setModel (null);
  } else if (isText (files.get (path))) {
    editor.setModel (ensureModel (path));
    editor.updateOptions ({ readOnly: false });
  } else {
    binaryModel.setValue (path.startsWith ("data/")
      ? `(${path}: binary, ${files.get (path).length} bytes; apps read it with gk:data)`
      : `(${relOf (path)}: binary, ${files.get (path).length} bytes; ` +
        "GapKeep only reads .js, .json and .txt files)");
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

// The editor, loaded once, when first needed: Monaco is several MB, and
// GapKeep's screen comes first (on a phone, it may never be needed).
let pendingLine = null;     // [line, col] to go to in the current file once loaded
let editorLoading = null;
function ensureEditor () {
  if (!editorLoading) {
    editorMessage ("Loading the editor...");
    editorLoading = setupEditor ().then (() => {
      for (const path of files.keys ()) ensureModel (path);
      const at = pendingLine || [];
      pendingLine = null;
      if (current && files.has (current)) openFile (current, ...at);
      else renderTree ();
    }, (e) => {
      editorMessage (`The editor did not load: ${e.message || e}`, true);
      ideLog (`the editor did not load: ${e.message || e}`, true);
    });
  }
  return editorLoading;
}

function editorMessage (text, error = false) {
  const msg = document.createElement ("div");
  msg.className = "message" + (error ? " error" : "");
  msg.textContent = text;
  $("editor").replaceChildren (msg);
}

// Shows the editor: on a phone, unfolds it (which loads it) and scrolls to it.
function showEditor () {
  if (PHONE.matches) {
    fold ("editor-pane", false);
    $("editor-pane").scrollIntoView ({ block: "start", behavior: "smooth" });
  } else {
    ensureEditor ();
  }
}

// Monaco's AMD build (vendor/monaco/vs, from tools/fetch_monaco.sh). It
// adds its own stylesheet.
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
// completions in manifest.json. GapKeep checks it again at boot.
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
    permissions: { type: "array", items: { enum: ["apps", "camera", "rtc", "settings", "epaper"] }, description: "Extra rights: \"apps\" (gk:apps), \"camera\" (ui.Scanner), \"rtc\" (setting gk:clock), \"settings\" (gk:i18n's setters), \"epaper\" (ui.epaper)." },
    hidden: { type: "boolean", description: "true: not listed in the launcher." },
    experimental: { type: "boolean", description: "true: only with experimental features on (docs/EXPERIMENTAL.md)." },
    data: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }, description: "The card's data folders (data/<name>) the app reads with gk:data." },
  },
};
// a suite's suite.json (docs/APPS.md, "Suites")
const SUITE_SCHEMA = {
  type: "object",
  required: ["id", "name"],
  additionalProperties: false,
  properties: {
    id: MANIFEST_SCHEMA.properties.id,
    name: MANIFEST_SCHEMA.properties.name,
    description: MANIFEST_SCHEMA.properties.description,
    icon: MANIFEST_SCHEMA.properties.icon,
  },
};

async function setupEditor () {
  monaco = await loadMonaco ();

  // JavaScript as GapKeep runs it: ES2023 modules on QuickJS, no DOM. The
  // gk:* modules and the few globals (console, timers) come from
  // gapkeep.d.ts. (monaco.typescript is new in 0.55; older: languages.typescript.)
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
    const r = await fetch (TYPES_URL, { cache: "no-cache" });
    if (!r.ok) throw new Error (r.status + " " + r.statusText);
    js.addExtraLib (await r.text (), "file:///types/gapkeep.d.ts");
  } catch (e) {
    ideLog (`could not load types/gapkeep.d.ts (${e.message}): no gk:* completions`, true);
  }

  const json = monaco.json || monaco.languages.json;
  json.jsonDefaults.setDiagnosticsOptions ({
    validate: true,
    schemas: [{ uri: "gapkeep://manifest.schema.json", fileMatch: ["**/manifest.json"], schema: MANIFEST_SCHEMA },
              { uri: "gapkeep://suite.schema.json", fileMatch: ["**/suite.json"], schema: SUITE_SCHEMA }],
  });

  monaco.editor.defineTheme ("gapkeep", {
    base: "vs-dark", inherit: true, rules: [],
    colors: {
      "editor.background": "#292831",
      "editorGutter.background": "#292831",
      "editor.lineHighlightBackground": "#30303a",
      "editorCursor.foreground": "#ffc300",
      "focusBorder": "#00968c",
    },
  });
  $("editor").replaceChildren ();   // "Loading the editor..."
  editor = monaco.editor.create ($("editor"), {
    model: null,
    theme: "gapkeep",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
  });
  binaryModel = monaco.editor.createModel ("", "plaintext", monaco.Uri.parse ("gkide:binary"));
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
  camera?.apply ();    // stops feeding it
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
  let gk;
  try {
    gk = await Gapkeep.create ({
      onLog: (line) => { if (machine === gk) onLog (line); },
      onHalt: () => { if (machine === gk) { updateStatus (); renderTree (); } },
    });
  } catch (e) {
    ideLog (`could not load the simulator (${e.message}); build it with tools/gkide.sh`, true);
    updateStatus ("no simulator");
    return;
  }
  if (token !== runToken) return;   // a later run() took over
  machine = gk;
  logApp = null;
  const card = {}, builtin = {};
  for (const [path, data] of files) {
    if (path.startsWith ("data/")) card[path] = data;   // data folders (gk:data)
    if (!path.startsWith ("apps/")) continue;
    if (BUILTIN.has (appOf (path))) builtin[path.slice (5)] = data;
    else card[path] = data;
  }
  // the card's gapkeep.txt: the experimental switch (docs/EXPERIMENTAL.md)
  // and the language of the address's ?lang=
  let settings = "";
  if (localStorage.getItem ("gkide.experimental") === "yes") settings += "experimental = yes\n";
  if (language) settings += `language = ${language}\n`;
  const epaperModel = localStorage.getItem ("gkide.epaper") || "none";
  // mounted wider than tall (the 2.9" and 2.13" are taller natively)
  if (epaperModel !== "none") settings += `epaper = ${epaperModel}\nepaper_rotate = ${epaperModel === "weact-4.2-bw" ? 0 : 90}\n`;
  if (settings) card["gapkeep.txt"] = settings;
  if (Object.keys (card).length) gk.writeCard (card);
  if (Object.keys (builtin).length) gk.writeBuiltin (builtin);
  const canvas = $("screen");
  canvas.width = w;
  canvas.height = h;
  fitScreen ();
  ideLog (`boot ${w}x${h}` + (appId ? `, then start ${appId}` : ""));
  try {
    gk.boot (w, h);
  } catch (e) {
    ideLog (e.message, true);
    if (builtin["launcher/main.js"] !== undefined) {
      ideLog ("GapKeep starts with the launcher, and that is the copy in apps/launcher: " +
        "fix it (see the error above), or delete apps/launcher to use the built-in one", true);
    }
    stopMachine ();
    updateStatus ();
    return;
  }
  gk.start ();
  camera.apply ();
  lastApp = appId;
  if (appId && !gk.launch (appId)) {
    ideLog (`${appId} did not start (see "not loaded" above); staying on the launcher`, true);
  }
  updateStatus ();
  renderTree ();
  // (not on a phone: there the focus brings up its keyboard; a tap on the screen does)
  if (focus && !PHONE.matches) $("screen-input").focus ({ preventScroll: true });
}

// The app to run: that of the open file, else the selected one.
// in a suite (apps/<suite>/suite.json), the app is the next folder down
const runnable = (path) => {
  const id = appOf (path);
  if (!id || !files.has (`apps/${id}/suite.json`)) return id;
  const sub = path.split ("/")[2];
  return sub && files.has (`apps/${id}/${sub}/manifest.json`) ? sub : null;
};
const appToRun = () => runnable (current) || runnable (selected?.path);

function home () {
  if (!machine) return;
  // GapKeep's Home is the Windows key, which browsers and desktops keep
  // for themselves; the button sends it.
  machine.keyDown ("Meta");
  setTimeout (() => machine?.keyUp (), 50);
  if (!PHONE.matches) $("screen-input").focus ({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// The screen: size, scaling, input, painting

function fitScreen () {
  const canvas = $("screen"), box = $("screen-box");
  const [w, h] = [canvas.width, canvas.height];
  const dpr = window.devicePixelRatio || 1;
  let s;
  if (PHONE.matches) {
    // The page's width, in any ratio (640 is wider than a phone), and no
    // taller than the view (a phone on its side). Smoothed when the pixels
    // would come out uneven and large enough to see it.
    s = Math.min (box.clientWidth / w, (Math.max (window.innerHeight, 300) - 56) / h) * dpr;
    if (Math.abs (s - Math.round (s)) < 0.01) s = Math.round (s);
    canvas.classList.toggle ("smooth", !Number.isInteger (s) && s < 2.5);
  } else {
    // In device pixels, so "integer" means really sharp on HiDPI screens too.
    s = Math.min ((box.clientWidth - 8) * dpr / w, (box.clientHeight - 8) * dpr / h);
    if (s >= 1) s = Math.floor (s);
    canvas.classList.remove ("smooth");
  }
  if (!(s > 0)) s = 1;
  canvas.style.width = (w * s) / dpr + "px";
  canvas.style.height = (h * s) / dpr + "px";
  const scale = Number.isInteger (s) ? s + "x" : s.toFixed (2) + "x";
  $("screen-info").textContent = `${w}x${h} at ${scale}`;
}

function setupScreen () {
  const canvas = $("screen");
  const sel = $("size");
  SIZES.forEach (([w, h], i) => sel.add (new Option (`${w} x ${h}`, i)));
  sel.value = SIZES.indexOf (size);
  sel.onchange = () => {
    size = SIZES[sel.value];
    localStorage.setItem ("gkide.size", sizeName (size));
    run (machine ? lastApp : null);
  };
  const experimental = $("experimental");
  experimental.checked = localStorage.getItem ("gkide.experimental") === "yes";
  experimental.onchange = () => {
    localStorage.setItem ("gkide.experimental", experimental.checked ? "yes" : "no");
    run (machine ? lastApp : null);
  };

  new ResizeObserver (fitScreen).observe ($("screen-box"));

  // The keyboard: a hidden textarea beside the canvas has the focus while
  // the person types into the screen, so that the OS's layout, dead keys,
  // AltGr and input methods work (textinput.js says which event types what).
  const input = $("screen-input");
  const keys = new TextInput ({
    keyDown: (key, mods) => machine ? machine.keyDown (key, mods) : false,
    keyUp: () => machine?.keyUp (),
    type: (text) => machine ? machine.type (text) : 0,
  }, {
    mac: /Mac|iPhone|iPad/.test (navigator.platform),
    warn: (message) => { console.warn (message); ideLog (message, true); },
    log: (message) => ideLog (message),
  });
  const hint = () => {
    const focused = document.activeElement === input;
    canvas.classList.toggle ("focused", focused);
    $("screen-hint").textContent = focused ? "keyboard goes to GapKeep"
      : PHONE.matches ? "tap the screen to type into it" : "click the screen to type into it";
    $("kbd-toggle").setAttribute ("aria-pressed", focused);
    $("screen-hint").classList.toggle ("focused", focused);
  };
  input.addEventListener ("focus", hint);
  input.addEventListener ("blur", () => {
    keys.blur ();
    hint ();
  });
  hint ();

  const event = (e) => ({ key: e.key, code: e.code, repeat: e.repeat, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey,
    altKey: e.altKey, metaKey: e.metaKey, isComposing: e.isComposing,
    altGraph: !!(e.getModifierState && e.getModifierState ("AltGraph")) });
  input.addEventListener ("keydown", (e) => {
    if (machine && keys.keydown (event (e))) e.preventDefault ();
  });
  input.addEventListener ("keyup", (e) => {
    keys.keyup (event (e));
  });
  input.addEventListener ("compositionstart", () => keys.compositionstart ());
  input.addEventListener ("compositionend", () => {
    if (keys.compositionend (input.value)) input.value = "";
  });
  input.addEventListener ("input", (e) => {
    if (keys.input ({ isComposing: e.isComposing, inputType: e.inputType }, input.value)) input.value = "";
  });
  // a phone keyboard's Backspace can come only as an edit of the textarea
  input.addEventListener ("beforeinput", (e) => {
    if (keys.beforeinput ({ isComposing: e.isComposing, inputType: e.inputType })) e.preventDefault ();
  });
  // Pasting types the clipboard's text into GapKeep, a key at a time (a
  // simulator convenience: the device has no clipboard).
  input.addEventListener ("paste", (e) => {
    e.preventDefault ();
    if (machine) keys.paste (e.clipboardData.getData ("text/plain"));
  });

  // Mouse: CSS pixels on the scaled canvas -> GapKeep's screen pixels.
  const toScreen = (e) => toScreenAt (e.clientX, e.clientY);
  const toScreenAt = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect ();
    const x = (clientX - r.left) * canvas.width / r.width;
    const y = (clientY - r.top) * canvas.height / r.height;
    return [Math.min (Math.max (x, 0), canvas.width - 1), Math.min (Math.max (y, 0), canvas.height - 1)];
  };
  canvas.addEventListener ("pointerdown", (e) => {
    if (e.pointerType === "touch") return touchDown (e);
    if (e.button !== 0) return;
    input.focus ({ preventScroll: true });
    canvas.setPointerCapture (e.pointerId);   // keep dragging outside the canvas
    machine?.pointer (...toScreen (e), true);
    e.preventDefault ();
  });
  canvas.addEventListener ("pointermove", (e) => {
    if (e.pointerType === "touch") return touchMove (e);
    machine?.pointer (...toScreen (e), (e.buttons & 1) !== 0);
  });
  canvas.addEventListener ("pointerup", (e) => {
    if (e.pointerType === "touch") return touchUp (e, false);
    if (e.button === 0) machine?.pointer (...toScreen (e), false);
  });
  canvas.addEventListener ("pointercancel", (e) => {
    if (e.pointerType === "touch") touchUp (e, true);
  });

  // Touch (ide.css gives the screen touch-action: none, so the page neither
  // scrolls nor zooms there). A finger is GapKeep's mouse: a tap is a click
  // where it touched, and brings up the phone's keyboard; held still, it
  // presses (and then drags, as for a slider); moved sideways, it drags at
  // once; swiped up or down, it turns the wheel, as on the device, where
  // the content follows the finger. One finger at a time.
  const TAP_SLOP = 10;      // CSS pixels a tap may wander
  const HOLD_MS = 300;      // a press, not a tap, after this
  const CLICK_MS = 80;      // how long a tap holds the button: LVGL reads the pointer every 33 ms
  const NOTCH = 60;         // screen pixels of swipe per wheel notch (about 3 lines of text)
  let touch = null;         // { id, m, x0, y0, lastY, rest, mode: "wait" | "drag" | "swipe", timer }
  function touchDown (e) {
    e.preventDefault ();
    if (touch || !machine) return;
    canvas.setPointerCapture (e.pointerId);
    const m = machine;
    m.pointer (...toScreen (e), false);   // GapKeep's cursor goes there
    touch = { id: e.pointerId, m, x0: e.clientX, y0: e.clientY, lastY: e.clientY, rest: 0, mode: "wait" };
    touch.timer = setTimeout (() => {
      if (touch?.mode !== "wait") return;
      touch.mode = "drag";
      m.pointer (...toScreenAt (touch.x0, touch.y0), true);
    }, HOLD_MS);
  }
  function touchMove (e) {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0;
    if (touch.mode === "wait" && Math.hypot (dx, dy) > TAP_SLOP) {
      clearTimeout (touch.timer);
      if (Math.abs (dy) >= Math.abs (dx)) {
        touch.mode = "swipe";
      } else {
        touch.mode = "drag";
        touch.m.pointer (...toScreenAt (touch.x0, touch.y0), true);
      }
    }
    if (touch.mode === "drag") {
      touch.m.pointer (...toScreen (e), true);
    } else if (touch.mode === "swipe") {
      // the finger going up shows what is below: the wheel turned down (> 0)
      touch.rest += (touch.lastY - e.clientY) * canvas.height / canvas.getBoundingClientRect ().height / NOTCH;
      touch.lastY = e.clientY;
      const notches = Math.trunc (touch.rest);
      if (notches) {
        touch.rest -= notches;
        touch.m.wheel (notches);
      }
    }
  }
  function touchUp (e, cancelled) {
    if (!touch || e.pointerId !== touch.id) return;
    clearTimeout (touch.timer);
    const t = touch;
    touch = null;
    if (t.mode === "drag") {
      t.m.pointer (...toScreen (e), false);
    } else if (t.mode === "wait" && !cancelled) {
      const at = toScreenAt (t.x0, t.y0);
      t.m.pointer (...at, true);
      setTimeout (() => t.m.pointer (...at, false), CLICK_MS);
      if (wantKeyboard) showKeyboard ();
    }
  }

  // The phone's keyboard comes up when the hidden textarea gets the focus,
  // from a tap (a user's gesture: browsers refuse it otherwise). Focus it
  // again even if it has it: Android hides its keyboard without taking the
  // focus away. The ⌨ key hides it, and taps then leave it hidden until ⌨
  // brings it back.
  let wantKeyboard = true;
  const showKeyboard = () => {
    if (document.activeElement === input) input.blur ();
    input.focus ({ preventScroll: true });
  };

  // The key bar (phones): the keys their keyboards lack. A key is down
  // while the finger is, so GapKeep repeats a held Backspace or arrow, as
  // the device does. It never takes the focus (that would hide the phone's
  // keyboard).
  const keybar = $("keybar");
  let barKey = null;        // the button whose key is down
  const barUp = () => {
    if (!barKey) return;
    barKey.classList.remove ("down");
    barKey = null;
    machine?.keyUp ();
  };
  keybar.addEventListener ("pointerdown", (e) => {
    e.preventDefault ();     // keep the focus where it is
    const b = e.target.closest ("button[data-key]");
    if (!b || !machine) return;
    barUp ();
    if (machine.keyDown (b.dataset.key, b.dataset.shift ? MOD_SHIFT : 0)) {
      barKey = b;
      b.classList.add ("down");
      keybar.setPointerCapture (e.pointerId);
    }
  });
  keybar.addEventListener ("pointerup", barUp);
  keybar.addEventListener ("pointercancel", barUp);
  keybar.addEventListener ("mousedown", (e) => e.preventDefault ());
  // from a keyboard (Enter or Space on a focused key): a press and a release
  keybar.addEventListener ("click", (e) => {
    const b = e.target.closest ("button[data-key]");
    if (!b || e.detail !== 0 || !machine) return;
    if (machine.keyDown (b.dataset.key, b.dataset.shift ? MOD_SHIFT : 0)) setTimeout (() => machine?.keyUp (), 50);
  });
  $("kbd-toggle").addEventListener ("click", () => {
    wantKeyboard = document.activeElement !== input;
    if (wantKeyboard) showKeyboard ();
    else input.blur ();
  });
  canvas.addEventListener ("contextmenu", (e) => e.preventDefault ());
  // The wheel: notches, as a mouse's (a pixel delta of 100, or 3 lines, is
  // one; trackpads add up). Over the screen only: elsewhere the page scrolls.
  let wheelRest = 0;
  canvas.addEventListener ("wheel", (e) => {
    if (!machine) return;
    e.preventDefault ();
    const perNotch = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 / 3 : 100;
    wheelRest += e.deltaY / perNotch;
    const notches = Math.trunc (wheelRest);
    if (notches === 0) return;
    wheelRest -= notches;
    machine.pointer (...toScreen (e), (e.buttons & 1) !== 0);
    machine.wheel (notches);
  }, { passive: false });

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
`// ${name}: a new GapKeep app. See docs/APPS.md and docs/API.md.

import * as ui from "gk:ui";

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
  if (!/\.(js|json|txt)$/.test (rel)) ideLog (`note: GapKeep ignores files other than .js, .json and .txt (${rel})`);
  await addFiles ({ [path]: /\.js$/.test (rel) ? "import * as ui from \"gk:ui\";\n\n" : "" });
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
// of apps (a card's apps/, or the repository's). A folder named "data" is
// the card's data folders (gk:data): "data/pgp/alice.asc" goes on the card
// as it is, binary or not.
async function importFolder (list) {
  const all = [...list].filter ((f) => !f.webkitRelativePath.split ("/").some ((p) => p.startsWith (".")));
  if (!all.length) return;
  const top = all[0].webkitRelativePath.split ("/")[0];
  if (top === "data") {
    const add = {};
    for (const f of all) {
      if (f.webkitRelativePath.split ("/").length < 3) continue;   // a loose file in data/
      // as text only if that keeps every byte (TextDecoder drops a BOM)
      const bytes = new Uint8Array (await f.arrayBuffer ());
      const bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      add[f.webkitRelativePath] = bom ? bytes : decode (bytes.buffer);
    }
    await addFiles (add);
    ideLog (`imported ${Object.keys (add).length} data files into data/`);
    toggle ("data", true);
    renderTree ();
    return;
  }
  // one app, or one suite (suite.json and its apps), or a folder of either
  const single = all.some ((f) => f.webkitRelativePath === `${top}/manifest.json` || f.webkitRelativePath === `${top}/suite.json`);
  const apps = new Map ();   // id -> [[rel, File]]
  for (const f of all) {
    const parts = f.webkitRelativePath.split ("/").slice (1);
    const id = single ? top : parts.shift ();
    if (!parts.length) continue;   // a loose file in a folder of apps
    if (!apps.has (id)) apps.set (id, []);
    apps.get (id).push ([parts.join ("/"), f]);
  }
  for (const [id, entries] of apps) {
    if (!entries.some (([rel]) => rel === "manifest.json" || rel === "suite.json")) {
      ideLog (`import: skipped ${id}/ (no manifest.json)`, true);
      continue;
    }
    if (!APP_ID.test (id)) ideLog (`import: "${id}" is not a valid app id; GapKeep will refuse it until renamed`, true);
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

// The example apps that tools/gkide.sh copies to sim/build/web/examples.
// only: the apps to add (default: all).
async function fetchExamples (only = null) {
  const r = await fetch (EXAMPLES_URL, { cache: "no-cache" });
  if (!r.ok) throw new Error (`${EXAMPLES_URL}: ${r.status} (start the IDE with tools/gkide.sh)`);
  const index = (await r.json ()).apps;
  const add = {};
  for (const [id, list] of Object.entries (index)) {
    if (only && !only.includes (id)) continue;
    await Promise.all (list.map (async (rel) => {
      const f = await fetch (EXAMPLES_DIR + id + "/" + rel, { cache: "no-cache" });
      if (!f.ok) throw new Error (`${id}/${rel}: ${f.status}`);
      add[`apps/${id}/${rel}`] = decode (await f.arrayBuffer ());
    }));
  }
  await addFiles (add);
  return Object.keys (index).filter ((id) => !only || only.includes (id));
}

async function restoreExamples () {
  try {
    const r = await fetch (EXAMPLES_URL, { cache: "no-cache" });
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

// The e-paper panel (docs/EPAPER.md): which one the card's gapkeep.txt
// names (it reboots), the panel as its pigments look, the refresh as it
// happens (18 s on the 2.9" B/W/R), and plugging panels in and out, as a
// person writing one share a panel does. Each panel keeps its picture.
function setupEPaper () {
  const model = $("epaper-model"), plug = $("epaper-plug"), fresh = $("epaper-new");
  const canvas = $("epaper"), info = $("epaper-info");
  model.value = localStorage.getItem ("gkide.epaper") || "none";
  model.onchange = () => {
    localStorage.setItem ("gkide.epaper", model.value);
    run (machine ? lastApp : null);
  };
  let panels = 1, last = "1";
  plug.onclick = () => {
    if (!machine?.hasEPaper ()) return;
    const name = machine.epaperPlugged;
    if (name) {
      last = name;
      machine.epaperUnplug ();
    } else {
      machine.epaperPlug (last);
    }
  };
  fresh.onclick = () => {
    if (!machine?.hasEPaper ()) return;
    last = String (++panels);
    machine.epaperPlug (last);
  };
  let shown = null;
  const paint = () => {
    const on = machine && !machine.halted && machine.hasEPaper () && model.value !== "none";
    plug.disabled = fresh.disabled = !on;
    let text = "";
    if (on) {
      const visible = machine.drawEPaper (canvas);
      canvas.hidden = !visible;
      if (visible) {
        canvas.style.width = canvas.width * 2 + "px";
        const p = machine.epaperProgress;
        const name = machine.epaperPlugged;
        text = `panel ${name}` + (p >= 0 ? `: refreshing, ${Math.round (p * 100)}%` : "");
        plug.textContent = "Unplug";
      } else {
        text = "unplugged";
        plug.textContent = "Plug in";
      }
    } else {
      canvas.hidden = true;
      if (model.value !== "none" && machine && !machine.hasEPaper ()) text = "this simulator has none: rebuild it";
    }
    if (text !== shown) info.textContent = shown = text;
    requestAnimationFrame (paint);
  };
  requestAnimationFrame (paint);
}

function setupUi () {
  camera = new CameraBar (() => machine, ideLog);
  setupEPaper ();
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

  // On gapkeep.org itself, its link stays in the same tab.
  if (/^(www\.)?gapkeep\.org$/.test (location.hostname)) {
    $("site").removeAttribute ("target");
    $("site").removeAttribute ("rel");
  }

  // Ctrl/Cmd+S and Ctrl/Cmd+Enter everywhere except on the screen, where
  // every key belongs to GapKeep. Capture phase, so Monaco doesn't see them.
  window.addEventListener ("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target === $("screen-input")) return;
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

// The phone layout's panes fold (ide.css hides a folded pane's body). They
// start folded, but for the console when it has news; the editor loads when
// first unfolded.
function fold (id, folded = !$(id).classList.contains ("folded")) {
  const pane = $(id);
  pane.classList.toggle ("folded", folded);
  pane.querySelector (".fold").setAttribute ("aria-expanded", !folded);
  if (!folded && id === "editor-pane" && PHONE.matches) ensureEditor ();
}

function setupFolds () {
  for (const id of ["files-pane", "editor-pane", "console-pane"]) {
    if (PHONE.matches) fold (id, true);
    // the whole bar is the button, but for the bar's own buttons
    $(id).querySelector (".pane-head").addEventListener ("click", (e) => {
      if (!PHONE.matches) return;
      const b = e.target.closest ("button");
      if (b && !b.classList.contains ("fold")) return;
      fold (id);
    });
  }
  // a phone turned into a desktop (a wider window): the editor is shown
  PHONE.addEventListener ("change", () => {
    if (!PHONE.matches) ensureEditor ();
    fitScreen ();
  });
}

// ?run=<id>: the folder of that app (apps/<id>, or apps/<suite>/<id>), if the
// card has it.
function appFolder (id) {
  if (files.has (`apps/${id}/manifest.json`)) return `apps/${id}`;
  for (const path of files.keys ()) {
    const p = path.split ("/");
    if (p.length === 4 && p[2] === id && p[3] === "manifest.json" && files.has (`apps/${p[1]}/suite.json`)) {
      return `apps/${p[1]}/${id}`;
    }
  }
  return null;
}

// The app the address asks for (?run=dice39), if any: its id, once it is
// on the card (an example app deleted from this browser is added back).
async function linkedApp () {
  const id = params.get ("run");
  if (!id) return null;
  if (!APP_ID.test (id)) {
    ideLog (`?run=: "${id}" is not an app id`, true);
    return null;
  }
  if (!appFolder (id)) {
    try {
      const r = await fetch (EXAMPLES_URL, { cache: "no-cache" });
      if (r.ok && (await r.json ()).apps[id]) {
        await fetchExamples ([id]);
        ideLog (`added the example app ${id} back`);
      }
    } catch (e) {
      // not an example (or no examples): said below
    }
  }
  const folder = appFolder (id);
  if (!folder) {
    ideLog (`?run=${id}: there is no app with that id here; starting the launcher`, true);
    fold ("console-pane", false);
    return null;
  }
  // its entry file is the one open (for the editor, and for Run)
  let entry = "main.js";
  try {
    entry = JSON.parse (files.get (`${folder}/manifest.json`)).entry || entry;
  } catch {
    // GapKeep says what is wrong with the manifest
  }
  if (files.has (`${folder}/${entry}`)) {
    current = `${folder}/${entry}`;
    selected = { path: current, kind: "file" };
    reveal (current);
  }
  return id;
}

async function main () {
  setupUi ();
  setupFolds ();
  setupScreen ();
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
  // the file to open once the editor is there (openFile shows the editor)
  const last = localStorage.getItem ("gkide.open");
  if (last && files.has (last)) current = last;
  else if (files.has ("apps/hello/main.js")) current = "apps/hello/main.js";
  if (current) {
    selected = { path: current, kind: "file" };
    reveal (current);
  }
  const app = await linkedApp ();
  updateTitle ();
  renderTree ();
  // Boot into the launcher, as the device does when switched on (or into
  // the app the address names). Then the editor, unless on a phone, where
  // it waits for the editor pane to be unfolded.
  await run (app, { focus: false });
  if (!PHONE.matches) ensureEditor ();
}

// For scripts and tests: window.gkide.run("hello"), .open("apps/x/main.js", 3)...
window.gkide = {
  run, home, openFile, files, stop: () => $("stop").click (),
  get camera () { return camera; },
  get machine () { return machine; },
  get editor () { return editor; },
  get monaco () { return monaco; },
};

main ().catch ((e) => {
  setStatus ("failed to start", "error");
  ideLog (`failed to start: ${e.stack || e}`, true);
});
