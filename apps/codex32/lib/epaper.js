// Writes secrets onto an e-paper panel (ui.epaper, the "epaper"
// permission): codex32 shares one after the other, one panel each, or one
// of the seed's QR codes. A page of its own on the screen: the panel's
// model, "Panel only" (the secret is drawn on the panel and never on this
// screen), what is written, the refresh's progress, Cancel until the
// refresh has begun, then Next share, Write again, Check with the camera
// (the panel's QR code read back and compared, the result only) and Back.
// The panel's page is laid out by ./epaperlayout.js.
//
// Never logged: what is written. The log gets "wrote share 2 of 3", sizes
// and the layout.
//
// Home: apps/dice39/lib/epaper.js; apps/codex32 has a copy made by
// tools/share_libs.py (never edit the copy).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import * as ui from "gk:ui";
import { t } from "gk:i18n";
import { planPage } from "./epaperlayout.js";

const GREEN = "#66bb6a", AMBER = "#ffb300", RED = "#ef5350", MUTED = "#8a9199";

// The panel, or null: none configured, none on this machine, or no
// "epaper" permission (the same to the person: there is nothing to write on)
export function epaperInfo() {
  try {
    return ui.epaper.info();
  } catch (e) {
    return null;
  }
}

let busy = false;       // a write runs: one at a time, whatever the page
let keyHandler = null;  // the writer page's, while it is shown

// For the app's ui.onKey: Escape cancels a write (before the refresh has
// begun), stops the camera, or goes back. True if the key was used.
export function epaperKey(ev) {
  return keyHandler ? keyHandler(ev) : false;
}

// The time to change one's mind (Cancel, Escape) after Write: once the
// panel's refresh command is sent (some 50 ms later), the waveform must run
// to its end
const START_MS = 2000;

function pause(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The writer page. opts:
//   tag          the app's name, for the log
//   start(title) clears the screen and starts the app's page
//   items        [{ label (on the screen), title, note (on the panel), data,
//                ecc, variants (epaperlayout.js), log (for the log: no secret) }]
//   choose       true: a dropdown picks one item (the seed's QR codes);
//                false: one after the other (shares: Next share)
//   index        the item to start with
//   intro        a paragraph under the title
//   panelOnly    the "Panel only" box's state; onPanelOnly(value) when changed
//   camera       true: offer "Check with the camera" (the "camera" permission)
//   onBack       Back (and Escape)
export function showWriter(opts) {
  const info = epaperInfo();
  const { items, tag } = opts;
  const w = { index: opts.index || 0, written: false, cancellable: false, abort: null, scanner: null, timer: null };
  let panelOnly = opts.panelOnly !== false;

  opts.start(t("Write to e-paper"));
  const root = new ui.Container({ layout: "column", gap: 10, width: "100%" });
  const para = (text, props) => new ui.Label(root, { text, width: "100%", font: 14, ...props });
  para(opts.intro);
  para(!info ? t("There is no e-paper panel.") : info.colors.includes("red")
    ? t("Panel: {model}, black, white and red.", { model: info.model })
    : t("Panel: {model}, black and white.", { model: info.model }), { color: MUTED });
  const only = new ui.Checkbox(root, { text: t("Panel only: never show it on this screen"), checked: panelOnly });
  const choice = opts.choose
    ? new ui.Dropdown(root, { options: items.map((x) => x.label), selected: w.index, width: 320 })
    : null;
  const heading = new ui.Label(root, { font: 20, width: "100%" });
  const status = para("", { font: 16 });
  const bar = new ui.Bar(root, { min: 0, max: 100, value: 0, width: "100%", hidden: true });
  const buttons = new ui.Container(root, { layout: "row-wrap", gap: 10, width: "100%" });
  const write = new ui.Button(buttons, { onClick: () => doWrite() });
  const next = new ui.Button(buttons, { text: ui.symbols.right + "  " + t("Next share"), onClick: () => {
    w.index++;
    w.written = false;
    doWrite();
  } });
  const cancel = new ui.Button(buttons, { text: ui.symbols.close + "  " + t("Cancel"), onClick: () => doCancel() });
  const check = new ui.Button(buttons, { onClick: () => (w.scanner ? stopCheck(true, check) : startCheck()) });
  const back = new ui.Button(buttons, { text: ui.symbols.left + "  " + t("Back"), onClick: () => leave() });
  const camera = new ui.Container(root, { layout: "column", gap: 6, width: "100%" });
  const preview = new ui.Container(root, { layout: "row-wrap", gap: 16, width: "100%", alignItems: "start" });

  const say = (text, color) => status.set({ text, color: color || MUTED });

  function render(focus) {
    if (!root.alive) return;
    const item = items[w.index];
    heading.text = item.label;
    write.text = (w.written ? ui.symbols.refresh + "  " + t("Write again") : ui.symbols.download + "  " +
      t("Write to the panel"));
    write.hidden = busy;
    write.disabled = !info;
    next.hidden = busy || opts.choose || !w.written || w.index >= items.length - 1;
    cancel.hidden = !busy;
    cancel.disabled = !w.cancellable;
    check.hidden = busy || !w.written || !opts.camera;
    check.text = w.scanner ? ui.symbols.stop + "  " + t("Stop the camera") : ui.symbols["eye-open"] + "  " +
      t("Check with the camera");
    back.disabled = busy;
    only.disabled = busy;
    if (choice) choice.disabled = busy;
    bar.hidden = !busy;
    const f = typeof focus === "function" ? focus() : focus;
    if (f) f.focus();
  }
  // the next thing to do, once a write has ended (after render: what is shown)
  const after = () => (!next.hidden ? next : !check.hidden ? check : write);
  const afterCheck = () => (!next.hidden ? next : back);

  // What is written, on this screen: only without "Panel only"
  function showPreview() {
    preview.clear();
    if (panelOnly) return;
    const item = items[w.index];
    const size = Math.max(160, Math.min(ui.height - 290, Math.floor(ui.width / 2), 320));   // in view at 640x480
    new ui.QRCode(preview, { data: item.data, ecc: item.ecc, size });
    const v = item.variants[0];
    new ui.Label(preview, { text: v.tokens.join(" "), mono: true, font: 16, grow: 1, minWidth: 200 });
  }

  only.onChange = (ev) => {
    panelOnly = ev.value;
    if (opts.onPanelOnly) opts.onPanelOnly(panelOnly);
    showPreview();
    if (w.scanner) w.scanner.hidden = panelOnly;
  };
  if (choice) {
    choice.onChange = (ev) => {
      stopCheck();
      w.index = ev.value;
      w.written = false;
      say(t("Not written yet."));
      showPreview();
      render();
    };
  }

  // The panel's page for an item: opened in the orientation the layout
  // picks, the widgets placed. { panel, plan, modules }, or null if it
  // doesn't fit this panel.
  function layout(item) {
    let panel = ui.epaper.open();
    try {
      const probe = new ui.QRCode(panel, { data: item.data, ecc: item.ecc, size: Math.max(panel.width, panel.height) });
      const modules = probe.modules;
      const plan = planPage({ width: panel.width, height: panel.height },
        { title: item.title, note: item.note, qrSide: modules + 8, variants: item.variants });
      if (!plan) {
        panel.close();
        return null;
      }
      if (plan.orientation !== "landscape") {
        panel.close();
        panel = ui.epaper.open({ orientation: plan.orientation });
      } else {
        probe.delete();
      }
      panel.set({ layout: "none", padding: 0 });
      const red = panel.colors.includes("red") ? 0xff0000 : 0x000000;   // B/W panels: a black title
      new ui.QRCode(panel, { data: item.data, ecc: item.ecc, size: plan.qr.size, x: plan.qr.x, y: plan.qr.y });
      for (const b of plan.blocks) {
        new ui.Label(panel, { family: "epdmono", font: b.font, text: b.lines.join("\n"), x: b.x, y: b.y,
          color: b.role === "title" ? red : 0x000000 });
      }
      return { panel, plan, modules };
    } catch (e) {
      panel.close();
      throw e;
    }
  }

  async function doWrite() {
    if (busy || !info) return;
    stopCheck();
    const item = items[w.index];
    let page;
    try {
      page = layout(item);
    } catch (e) {
      say(ui.symbols.close + " " + t("Could not write: {reason}", { reason: e.message }), RED);
      console.log(`${tag}: e-paper: could not lay out ${item.log}: ${e.name}`);
      return render(write);
    }
    showPreview();
    if (!page) {
      say(ui.symbols.close + " " + t("This does not fit on this panel: its QR code is too large."), RED);
      console.log(`${tag}: e-paper: ${item.log} does not fit the panel`);
      return render(write);
    }
    const { panel, plan, modules } = page;
    busy = true;
    w.written = false;
    w.cancellable = true;
    w.abort = new AbortController();
    const signal = w.abort.signal;
    bar.value = 0;
    say(t("Writing {what} to the panel in a moment: Cancel or Escape stops it.", { what: item.label }), AMBER);
    render(cancel);
    await pause(START_MS, signal);
    let outcome;
    if (signal.aborted) {
      panel.close();
      outcome = "cancelled";
    } else {
      say(t("Writing {what} to the panel...", { what: item.label }));
      console.log(`${tag}: e-paper: writing ${item.log}: ${plan.orientation}, QR ${modules}x${modules} at ` +
        `${plan.qr.scale} px a module, text ${plan.textFont} px`);
      const done = panel.refresh({
        signal,
        onProgress: (f) => {
          if (!root.alive) return;
          bar.value = Math.round(f * 100);
          // from the refresh command on, the waveform runs to its end
          if (f >= 0.05 && w.cancellable) {
            w.cancellable = false;
            say(t("The panel is refreshing: don't unplug it until this page says so."), AMBER);
            render(cancel);
          }
        },
      });
      panel.close();   // the picture was taken: its widgets go now
      try {
        await done;
        outcome = "written";
      } catch (e) {
        outcome = e && e.name === "AbortError" ? "cancelled" : e;
      }
    }
    busy = false;
    w.cancellable = false;
    w.abort = null;
    if (outcome === "written") {
      w.written = true;
      console.log(`${tag}: e-paper: wrote ${item.log}`);
    } else if (outcome === "cancelled") {
      console.log(`${tag}: e-paper: cancelled ${item.log}`);
    } else {
      console.log(`${tag}: e-paper: writing ${item.log} failed: ${outcome && outcome.message}`);
    }
    if (!root.alive) return;
    if (outcome === "written") {
      say(ui.symbols.ok + " " + t("{what} written to the panel: you can unplug it now.", { what: item.label }), GREEN);
    } else if (outcome === "cancelled") {
      say(t("Cancelled: nothing was written, the panel shows what it showed before."), AMBER);
    } else {
      say(ui.symbols.close + " " + t("Could not write: {reason}", { reason: outcome && outcome.message }), RED);
    }
    render(outcome === "written" ? after : write);
  }

  function doCancel() {
    if (busy && w.cancellable && w.abort) {
      w.abort.abort();
      w.cancellable = false;
      say(t("Cancelling..."), AMBER);
      render(cancel);
    }
  }

  // Reads the panel's QR code back with the camera, and says whether it is
  // what was written; never what it says. In "Panel only" the camera's view
  // is not shown either: it would show the panel. The field alternates: a
  // panel held close fills the centre, one further away needs the whole view.
  function startCheck() {
    stopCheck();
    const item = items[w.index];
    camera.clear();
    new ui.Label(camera, { text: panelOnly ? t("Hold the panel in front of the camera (its view is not shown: " +
      "the panel holds a secret).") : t("Hold the panel in front of the camera."), width: "100%", font: 14,
    color: MUTED });
    let field = "center", other = false;
    try {
      w.scanner = new ui.Scanner(camera, {
        detect: ["qr"], width: 320, height: 240, hidden: panelOnly, field,
        onDetect: ({ text, bytes }) => {
          const match = typeof item.data === "string" ? text === item.data : sameBytes(bytes, item.data);
          if (match) {
            console.log(`${tag}: e-paper: read back ${item.log}: it matches`);
            stopCheck(true);
            say(ui.symbols.ok + " " + t("Checked: the panel's QR code reads back as {what}.", { what: item.label }),
              GREEN);
            render(afterCheck);
          } else if (!other) {
            other = true;
            console.log(`${tag}: e-paper: read back ${item.log}: another code`);
            say(ui.symbols.close + " " + t("The camera read another code, not {what}.", { what: item.label }), RED);
          }
        },
        onError: ({ reason }) => {
          console.log(`${tag}: e-paper: camera: ${reason}`);
          stopCheck(true, check);
          say(ui.symbols.close + " " + t("The camera stopped: {reason}.", { reason }), RED);
        },
      });
    } catch (e) {
      w.scanner = null;
      say(ui.symbols.close + " " + t("The camera stopped: {reason}.", { reason: e.message }), RED);
      return render(check);
    }
    w.timer = setInterval(() => {
      if (w.scanner && w.scanner.alive) w.scanner.field = field = field === "center" ? "full" : "center";
    }, 4000);
    console.log(`${tag}: e-paper: checking ${item.log} with the camera`);
    say(t("Looking for the panel's QR code..."));
    render(check);
  }

  function stopCheck(keepStatus, focus) {
    if (w.timer) clearInterval(w.timer);
    w.timer = null;
    if (w.scanner) {
      if (w.scanner.alive) w.scanner.delete();
      w.scanner = null;
      if (root.alive) camera.clear();
      if (!keepStatus) say("");
    }
    if (focus) render(focus);
  }

  function leave() {
    if (busy) return;
    stopCheck();
    keyHandler = null;
    opts.onBack();
  }

  keyHandler = (ev) => {
    if (!root.alive) {
      keyHandler = null;
      return false;
    }
    if (ev.key !== "Escape") return false;
    if (busy) doCancel();
    else if (w.scanner) stopCheck(true, check);
    else leave();
    return true;
  };

  say(info ? t("Not written yet.") : t("There is no e-paper panel."));
  showPreview();
  render(write);
}
