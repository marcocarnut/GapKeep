// Clock: shows and sets zerogap's clock (docs/CLOCK.md).
//
// A Pi Zero has no battery-backed clock: the time is lost at power-off and
// is set here after each boot. Type the local time a little ahead of a
// reference clock (a phone, a watch), and press Enter when the reference
// shows it. Set it again hours later and the clock measures its own drift;
// the trim that cancels it can be applied here, and written into the
// card's zerogap.txt (from another computer) so it survives reboots.
//
// Its text is translated (gk:i18n, lang/<language>.json): an example of an
// app in more than one language (docs/APPS.md, "Languages"). Numbers on
// screen are written the language's way; the zerogap.txt lines it shows are
// not, since that file is read the same way whatever the language.

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as clock from "gk:clock";
import { t, formatDate, formatTime, formatDateTime, formatNumber, parseNumber } from "gk:i18n";

const pad = (n, w = 2) => String(n).padStart(w, "0");
const DAYS = [
  t("Sun", { $context: "weekday" }), t("Mon", { $context: "weekday" }), t("Tue", { $context: "weekday" }),
  t("Wed", { $context: "weekday" }), t("Thu", { $context: "weekday" }), t("Fri", { $context: "weekday" }),
  t("Sat", { $context: "weekday" }),
];

function offsetText(minutes) {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function dateText(d) {
  return `${DAYS[d.getDay()]} ${formatDate(d.getTime() / 1000)}`;
}
// on screen, the language's way: +1,5
function ppmText(ppm, decimals = 1) {
  return (ppm > 0 ? "+" : "") + formatNumber(ppm, { decimals });
}
// in zerogap.txt, always +1.5
function ppmFileText(ppm) {
  return (ppm > 0 ? "+" : "") + ppm.toFixed(1);
}
function secondsText(s) {
  return formatNumber(Math.abs(s), { decimals: 2 });
}
function durationText(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? t("{h} h {m} min", { h, m: pad(m) }) : t("{m} min", { m });
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
const offsetField = row(form, t("UTC offset"), { width: 120, maxLength: 6, accept: "+-0123456789:Z", placeholder: "-03:00" });
const timeField = row(form, t("Local time"), {
  width: wide ? 320 : 260, maxLength: 19, accept: "0123456789-: ",
  placeholder: t("YYYY-MM-DD HH:MM:SS"),
});
new ui.Label(form, {
  text: t("Type a time a little ahead of a reference clock, and press Enter when the reference shows it."),
  width: "100%", overflow: "wrap", font: 14, color: "#8a9199",
});
const trimField = row(form, t("Trim (ppm)"), {
  width: 120, maxLength: 8, accept: "+-0123456789.,", placeholder: formatNumber(0, { decimals: 1 }),
});

const driftLabel = new ui.Label({ text: "", width: "100%", overflow: "wrap" });
const buttons = new ui.Container({ layout: "row", gap: 8 });
const applyDrift = new ui.Button(buttons, {
  text: ui.symbols.ok + " " + t("Apply measured trim"),
  hidden: true,
  onClick: () => {
    const st = clock.status();
    if (st.drift) setTrim(Math.round(st.drift.trimPpm * 10) / 10);
  },
});
new ui.Button(buttons, { text: ui.symbols.home + " " + t("Back"), onClick: () => sys.exit() });

const cardLabel = new ui.Label({ text: "", width: "100%", overflow: "wrap", font: 14 });
const message = new ui.Label({ text: "", width: "100%", overflow: "wrap", color: "#ffc107" });

// --- behaviour ------------------------------------------------------------------

function say(text) {
  message.text = text;
}

function render() {
  const st = clock.status();
  const now = new Date(st.time);
  timeLabel.text = formatTime(st.time / 1000);
  dateLabel.text = `${dateText(now)}   UTC${offsetText(st.utcOffset)}`;
  statusLabel.text = st.set
    ? t("Set since this boot. Trim {ppm} ppm.", { ppm: ppmText(st.trimPpm, 3) })
    : t("Not set since this boot: ZeroGap has no battery-backed clock, so it counts from 1970 until the time is set here.");

  if (st.drift) {
    const d = st.drift;
    const s = secondsText(d.correction);
    const how = Math.abs(d.correction) < 0.05 ? t("right on time")
      : d.correction > 0 ? t("{s} s fast", { s }) : t("{s} s slow", { s });
    driftLabel.text = t("At the last setting, after {duration}, the clock was {how}. " +
      "The trim that keeps it right: {ppm} ppm, ± {uncertainty} ppm " +
      "(a week between settings measures it to about 2 ppm).", {
      duration: durationText(d.over), how, ppm: ppmText(d.trimPpm),
      uncertainty: formatNumber(d.uncertaintyPpm, { decimals: 1 }),
    });
    applyDrift.hidden = false;
  } else {
    driftLabel.text = t("Set the clock again a day or more from now to measure its drift (at least an hour).");
    applyDrift.hidden = true;
  }

  cardLabel.text = t("To keep the trim and offset across reboots, put these lines in zerogap.txt at the top of the SD card:") +
    `\nclock_trim_ppm = ${ppmFileText(st.trimPpm)}\nutc_offset = ${offsetText(st.utcOffset)}`;
}

function setTrim(ppm) {
  try {
    clock.setTrim(ppm);
    trimField.text = ppmText(ppm);
    say(t("Trim set to {ppm} ppm.", { ppm: ppmText(ppm) }));
  } catch (e) {
    say(e.message);
  }
  render();
}

timeField.on("submit", () => {
  const ms = parseLocal(timeField.text, clock.status().utcOffset);
  if (ms === null) {
    say(t("The time must be YYYY-MM-DD HH:MM:SS (a real date, 24-hour time)."));
    console.log("clock app: refused the time");
    return;
  }
  try {
    const st = clock.set(ms);
    const s = st.drift && secondsText(st.drift.correction);
    say(!st.drift ? t("Clock set.")
      : st.drift.correction > 0 ? t("Clock set. It was {s} s fast.", { s })
      : t("Clock set. It was {s} s slow.", { s }));
    console.log(`clock app: set ${new Date().toISOString()}`);
  } catch (e) {
    say(e.message);
  }
  render();
});

offsetField.on("submit", () => {
  const minutes = parseOffset(offsetField.text);
  if (minutes === null) {
    say(t("The offset must look like -03:00 or +05:30."));
    return;
  }
  try {
    clock.setUtcOffset(minutes);
    offsetField.text = offsetText(minutes);
    say(t("Local time is now UTC{offset}.", { offset: offsetText(minutes) }));
  } catch (e) {
    say(e.message);
  }
  render();
});

trimField.on("submit", () => {
  let ppm;
  try {
    ppm = parseNumber(trimField.text);
  } catch {
    say(t("The trim is a number of ppm, like {example}.", { example: formatNumber(-21.4, { decimals: 1 }) }));
    return;
  }
  setTrim(ppm);
});

// start: fields filled from the clock; the time a minute ahead, on the minute
const st = clock.status();
const ahead = new Date(Math.ceil((st.time + 60000) / 60000) * 60000);
timeField.text = st.set
  ? formatDateTime(ahead.getTime() / 1000)
  : "";
offsetField.text = offsetText(st.utcOffset);
trimField.text = ppmText(st.trimPpm);
render();
clock.every(1, render);
(st.set ? timeField : offsetField).focus();
console.log("clock ready");
