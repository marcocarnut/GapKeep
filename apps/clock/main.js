// Clock: shows and sets zerogap's clock (docs/CLOCK.md).
//
// A Pi Zero has no battery-backed clock: the time is lost at power-off and
// is set here after each boot. Type the local time a little ahead of a
// reference clock (a phone, a watch), and press Enter when the reference
// shows it. Set it again hours later and the clock measures its own drift;
// the trim that cancels it can be applied here, and written into the
// card's zerogap.txt (from another computer) so it survives reboots.

import * as ui from "zg:ui";
import * as sys from "zg:sys";
import * as clock from "zg:clock";

const pad = (n, w = 2) => String(n).padStart(w, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function offsetText(minutes) {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function dateText(d) {
  return `${DAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function timeText(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function ppmText(ppm, decimals = 1) {
  return (ppm > 0 ? "+" : "") + ppm.toFixed(decimals);
}
function durationText(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${pad(m)} min` : `${m} min`;
}

// "YYYY-MM-DD HH:MM[:SS]" in local time -> ms since 1970 (UTC), or null
function parseLocal(text, utcOffset) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);   // rejects 2026-02-30, 25:00 and the like
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return ms - utcOffset * 60000;
}
// "+05:30", "-03:00", "0" -> minutes, or null
function parseOffset(text) {
  const t = text.trim();
  if (t === "0" || t === "Z") return 0;
  const m = /^([+-])(\d{1,2}):?(\d{2})$/.exec(t);
  if (!m || Number(m[3]) > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// --- the screen -----------------------------------------------------------------

const wide = ui.width >= 800;
ui.screen.set({ gap: wide ? 12 : 8 });

const head = new ui.Container({ layout: "row", alignItems: "end", gap: 16, width: "100%" });
const timeLabel = new ui.Label(head, { text: "", font: 40 });
const dateLabel = new ui.Label(head, { text: "", font: 20 });
const statusLabel = new ui.Label({ text: "", width: "100%", overflow: "wrap" });

// a labelled row: label, field, and room for a note
function row(parent, title, field) {
  const r = new ui.Container(parent, { layout: "row", alignItems: "center", gap: 10, width: "100%" });
  new ui.Label(r, { text: title, width: wide ? 170 : 130 });
  const input = new ui.TextArea(r, { oneLine: true, ...field });
  return input;
}

const form = new ui.Container({ layout: "column", gap: 8, width: "100%" });
const offsetField = row(form, "UTC offset", { width: 120, maxLength: 6, accept: "+-0123456789:Z", placeholder: "-03:00" });
const timeField = row(form, "Local time", {
  width: wide ? 320 : 260, maxLength: 19, accept: "0123456789-: ",
  placeholder: "YYYY-MM-DD HH:MM:SS",
});
new ui.Label(form, {
  text: "Type a time a little ahead of a reference clock, and press Enter when the reference shows it.",
  width: "100%", overflow: "wrap", font: 14, color: "#8a9199",
});
const trimField = row(form, "Trim (ppm)", { width: 120, maxLength: 8, accept: "+-0123456789.", placeholder: "0.0" });

const driftLabel = new ui.Label({ text: "", width: "100%", overflow: "wrap" });
const buttons = new ui.Container({ layout: "row", gap: 8 });
const applyDrift = new ui.Button(buttons, {
  text: ui.symbols.ok + " Apply measured trim",
  hidden: true,
  onClick: () => {
    const st = clock.status();
    if (st.drift) setTrim(Math.round(st.drift.trimPpm * 10) / 10);
  },
});
new ui.Button(buttons, { text: ui.symbols.home + " Back", onClick: () => sys.exit() });

const cardLabel = new ui.Label({ text: "", width: "100%", overflow: "wrap", font: 14 });
const message = new ui.Label({ text: "", width: "100%", overflow: "wrap", color: "#ffc107" });

// --- behaviour ------------------------------------------------------------------

function say(text) {
  message.text = text;
}

function render() {
  const st = clock.status();
  const now = new Date(st.time);
  timeLabel.text = timeText(now);
  dateLabel.text = `${dateText(now)}   UTC${offsetText(st.utcOffset)}`;
  statusLabel.text = st.set
    ? `Set since this boot. Trim ${ppmText(st.trimPpm, 3)} ppm.`
    : "Not set since this boot: zerogap has no battery-backed clock, so it counts from 1970 until the time is set here.";

  if (st.drift) {
    const d = st.drift;
    const how = Math.abs(d.correction) < 0.05 ? "right on time"
      : `${Math.abs(d.correction).toFixed(2)} s ${d.correction > 0 ? "fast" : "slow"}`;
    driftLabel.text = `At the last setting, after ${durationText(d.over)}, the clock was ${how}. ` +
      `The trim that keeps it right: ${ppmText(d.trimPpm)} ppm, ± ${d.uncertaintyPpm.toFixed(1)} ppm ` +
      "(longer between settings is more precise).";
    applyDrift.hidden = false;
  } else {
    driftLabel.text = "Set the clock again some hours from now to measure its drift.";
    applyDrift.hidden = true;
  }

  cardLabel.text = "To keep the trim and offset across reboots, put these lines in zerogap.txt " +
    `at the top of the SD card:\nclock_trim_ppm = ${ppmText(st.trimPpm)}\nutc_offset = ${offsetText(st.utcOffset)}`;
}

function setTrim(ppm) {
  try {
    clock.setTrim(ppm);
    trimField.text = ppmText(ppm);
    say(`Trim set to ${ppmText(ppm)} ppm.`);
  } catch (e) {
    say(e.message);
  }
  render();
}

timeField.on("submit", () => {
  const ms = parseLocal(timeField.text, clock.status().utcOffset);
  if (ms === null) {
    say("The time must be YYYY-MM-DD HH:MM:SS (a real date, 24-hour time).");
    console.log("clock app: refused the time");
    return;
  }
  try {
    const st = clock.set(ms);
    say(st.drift
      ? `Clock set. It was ${Math.abs(st.drift.correction).toFixed(2)} s ${st.drift.correction > 0 ? "fast" : "slow"}.`
      : "Clock set.");
    console.log(`clock app: set ${new Date().toISOString()}`);
  } catch (e) {
    say(e.message);
  }
  render();
});

offsetField.on("submit", () => {
  const minutes = parseOffset(offsetField.text);
  if (minutes === null) {
    say("The offset must look like -03:00 or +05:30.");
    return;
  }
  try {
    clock.setUtcOffset(minutes);
    offsetField.text = offsetText(minutes);
    say(`Local time is now UTC${offsetText(minutes)}.`);
  } catch (e) {
    say(e.message);
  }
  render();
});

trimField.on("submit", () => {
  const ppm = Number(trimField.text);
  if (trimField.text.trim() === "" || !Number.isFinite(ppm)) {
    say("The trim is a number of ppm, e.g. -21.4.");
    return;
  }
  setTrim(ppm);
});

// start: fields filled from the clock; the time a minute ahead, on the minute
const st = clock.status();
const ahead = new Date(Math.ceil((st.time + 60000) / 60000) * 60000);
timeField.text = st.set
  ? `${ahead.getFullYear()}-${pad(ahead.getMonth() + 1)}-${pad(ahead.getDate())} ${timeText(ahead)}`
  : "";
offsetField.text = offsetText(st.utcOffset);
trimField.text = ppmText(st.trimPpm);
render();
clock.every(1, render);
(st.set ? timeField : offsetField).focus();
console.log("clock ready");
