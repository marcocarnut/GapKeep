// Settings: the language, the marks numbers are written with, and the
// keyboard layout (docs/plans/I18N.md, "Settings"). Each applies at once,
// for this session: GapKeep never writes to the card, so a choice lasts
// until power-off. Like the clock app, it shows the gapkeep.txt lines that
// make it last, to be written on the card from another computer.
//
// Its text is in every language it offers (lang/), and the languages are
// named in themselves ("Português (Brasil)"). It logs each change, never
// what is typed in the box for trying the keyboard.

import * as ui from "gk:ui";
import * as sys from "gk:sys";
import * as session from "gk:session";
import * as i18n from "gk:i18n";
import { t } from "gk:i18n";

// The marks on offer: the language's own, or one of these. [decimal, group]
const MARKS = [null, [".", ","], [",", "."], [".", ""], [",", ""]];
const sample = (m) => `1${m[1]}234${m[0]}5`;

// The keyboard layouts' names; a layout not here shows its code
const LAYOUTS = () => ({ us: t("US"), "br-abnt2": t("Brazilian (ABNT2)") });

// Which MARKS entry was chosen here (kept for the session); else the first.
// (Marks set in gapkeep.txt show in the samples, not here.)
function marksChoice() {
  const kept = session.get("marks");
  if (Number.isInteger(kept) && kept >= 0 && kept < MARKS.length) return kept;
  return 0;
}

let focusOn = 0;	// the control to focus after a redraw

function build() {
  ui.screen.clear();
  ui.screen.set({ gap: 10, scrollable: true });

  new ui.Label({ text: ui.symbols.settings + "  " + t("Settings"), font: 28 });

  const controls = [];
  const row = (title) => {
    const r = new ui.Container({ layout: "row", alignItems: "center", gap: 12, width: "100%" });
    new ui.Label(r, { text: title, width: 150 });
    return r;
  };

  // language
  const languages = i18n.languages();
  const current = Math.max(0, languages.findIndex((l) => l.tag === i18n.language()));
  controls.push(new ui.Dropdown(row(t("Language")), {
    options: languages.map((l) => l.name),
    selected: current,
    width: 280,
    onChange: (ev) => {
      focusOn = 0;
      const tag = languages[ev.value].tag;
      console.log("settings: language", tag);
      i18n.setLanguage(tag);	// redraws: onLanguageChange below
    },
  }));

  // number marks
  controls.push(new ui.Dropdown(row(t("Numbers")), {
    options: MARKS.map((m) => (m ? sample(m) : t("As the language writes them"))),
    selected: marksChoice(),
    width: 280,
    onChange: (ev) => {
      focusOn = 1;
      session.set("marks", ev.value);
      const m = MARKS[ev.value];
      console.log("settings: numbers", m ? sample(m) : "the language's");
      i18n.setMarks(m ? { decimal: m[0], group: m[1] } : null);
    },
  }));

  // keyboard: applies at once, to what is typed in every app
  const layouts = i18n.keyboards();
  const names = LAYOUTS();
  const r = row(t("Keyboard"));
  controls.push(new ui.Dropdown(r, {
    options: layouts.map((l) => names[l] ?? l),
    selected: Math.max(0, layouts.indexOf(i18n.keyboard())),
    width: 280,
    onChange: (ev) => {
      focusOn = 2;
      console.log("settings: keyboard", layouts[ev.value]);
      i18n.setKeyboard(layouts[ev.value]);
      build();
    },
  }));
  controls.push(new ui.TextArea({
    oneLine: true,
    width: "100%",
    placeholder: t("Type here to try the keyboard"),
  }));

  // what they look like
  const m = i18n.marks();
  const panel = new ui.Panel({ width: "100%", layout: "column", gap: 4 });
  for (const line of [
    t("Amount: {amount} BTC", { amount: i18n.formatBtc(123456789) }),
    t("Number: {number}", { number: i18n.formatNumber(1234567.89, { decimals: 2 }) }),
    t("Date and time: {date}", { date: i18n.formatDateTime(Date.now() / 1000) }),
  ]) {
    new ui.Label(panel, { text: line });
  }

  // the lines that keep them (the file is read the same way in every language)
  const lines = [`language = ${i18n.language()}`, `keyboard = ${i18n.keyboard()}`];
  if (marksChoice() !== 0) lines.push(`decimal_mark = ${m.decimal}`, `group_mark = ${m.group}`);
  new ui.Label({
    text: t("These apply now, until GapKeep is switched off. To keep them, put these lines in gapkeep.txt at the top of the SD card:") +
      "\n" + lines.join("\n"),
    width: "100%",
    font: 14,
  });

  controls.push(new ui.Button({ text: ui.symbols.home + " " + t("Back"), onClick: () => sys.exit() }));
  controls[Math.min(focusOn, controls.length - 1)].focus();
}

i18n.onLanguageChange(() => {
  build();
  console.log("settings: redrawn in", i18n.language());
});
build();
console.log("settings ready");
