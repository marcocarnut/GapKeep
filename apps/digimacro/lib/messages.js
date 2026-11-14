// The macro encoder's messages (vendor/table.js's MSG), in the person's
// language: table.js takes a translator (setMessages) and keeps its English
// as the default. The English here is DigiMacroAsm's (web/i18n.js), with
// gk:i18n's {{ and }} for literal braces; lang/pt-BR.json has its
// Portuguese. They quote what was typed ({what}), which may be anything in
// a macro: they are shown, never logged.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t } from "gk:i18n";

export function encoderMessage(key, p) {
  switch (key) {
    case "lone-backslash": return t("a lone \\ at the end");
    case "bad-escape": return t("\\{what} means nothing", p);
    case "unclosed": return t("a {{ with no }}");
    case "empty-braces": return t("{{}} is empty");
    case "pause-range": return t("{{{what}}}: a pause runs from 0.1 to 25.5 seconds", p);
    case "point-range": return t("{{{what}}}: the pointer goes from 0 to 100, in percent of the screen", p);
    case "point-scale": return t("{{{what}}}: a scale runs from 0.75 to 3.75, in quarters", p);
    case "repeat-range": return t("{{{what}}}: a repeat runs from 1 to 256", p);
    case "nothing-to-rep": return t("{{{what}}}: nothing to repeat yet", p);
    case "group-empty": return t("() has nothing in it");
    case "nested-repeat": return t("a count inside a group: the firmware has one mark, so the inner count would take the outer one over");
    case "goto-nowhere": return t("{{goto {what}}}: there is no macro with that code", p);
    case "ir-button": return t("{{{what}}}: a remote's button is {{IR}} and two bytes in hex, as in {{IR 00 45}}", p);
    case "loop-empty": return t("{what}: these only jump to each other and never type or pause, so the firmware would give up on them rather than run them", p);
    case "no-key-after": return t("{{{what}}}: no key after the +", p);
    case "not-a-modifier": return t("\"{what}\" is not a modifier", p);
    case "not-a-key": return t("\"{what}\" is not a key", p);
    case "no-key-for": return t("no key for \"{what}\"", p);
    case "needs-dead-keys": return t("\"{what}\" needs a keyboard with dead keys: see the computer's keyboard, above the macros", p);
    case "not-a-code": return t("not a code: \"{what}\"", p);
    case "code-twice": return t("\"{what}\" is used twice", p);
    case "not-a-byte": return t("\"{what}\" has a byte that is not a byte", p);
    case "has-a-zero": return t("\"{what}\" contains a zero, which would end it early", p);
    case "too-big": return t("{n} bytes of table, and only {fits} fit", p);
    case "secret-no-key": return t("{{secret}} needs the key, to encrypt what follows it");
    case "secret-twice": return t("one {{secret}} per macro: everything after the first is secret already");
    case "secret-in-group": return t("a {{secret}} inside a group: it takes the rest of the macro, so it cannot be repeated");
    case "secret-ir": return t("an {{IR}} after a {{secret}}: the remote could not find its button in encrypted text");
    case "secret-sealed-last": return t("nothing can follow a sealed {{secret}}: it is the rest of the macro already");
    case "secret-blob": return t("a sealed {{secret}} that is not one: it was changed since it was read");
    case "secret-too-long": return t("a secret of {n} keystrokes: at most {max} fit", p);
    case "host-gone": return t("{{host}} is gone: put {{secret}} where it was, and the rest of the macro is encrypted as well as guarded");
    case "secret-wrong-key": return t("this is not the key these secrets were sealed with");
    case "secret-no-nonce": return t("no nonce would seal this secret: try again");
    case "totp-blob": return t("a {{totp @...}} must be 80 hex digits: it was changed since it was read from the board");
    case "totp-base32": return t("{{totp {what}}}: a secret is base32, letters A-Z and digits 2-7, as an authenticator app shows it", p);
    case "totp-empty": return t("{{totp}} needs the secret: {{totp ABCD EFGH ...}}");
    default: return null;       // table.js's own English
  }
}

// The hardened-mode checklist's lines (lib/board.js's hardening())
export function hardeningLine(key) {
  switch (key) {
    case "hd-pass": return t("a password set: without one, anyone can put firmware on the board that reads it out");
    case "hd-lock": return t("lock bits set, lock byte 0xFC: a programmer cannot read the chip");
    case "hd-eesave": return t("EESAVE unprogrammed: erasing the chip erases the EEPROM too");
    case "hd-dwen": return t("debugWIRE off");
    case "hd-selfprg": return t("SELFPRGEN programmed: the board can update itself");
    case "hd-bod": return t("brown-out detection on: a sagging supply cannot corrupt the flash the board writes");
    case "hd-boot": return t("no bootloader");
    default: return key;
  }
}
