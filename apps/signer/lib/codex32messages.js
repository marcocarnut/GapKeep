// lib/codex32.js's errors in the person's language (zg:i18n). The library
// words them in English, for logs and Node; each error carries its code and
// details, and this module words them again through t(), the English the
// same as the library's.

import { t, plural } from "zg:i18n";

const q = (c) => `'${c}'`;
const up = (s) => String(s).toUpperCase();

// The errors of one share, which recover() marks with the share's number
const ONE_SHARE = new Set(["empty", "case", "prefix", "char", "length", "threshold", "threshold0", "checksum",
  "invalid"]);

export function codex32Message(e) {
  const text = wording(e);
  if (text === null) return e.message;
  return e.share && ONE_SHARE.has(e.code) ? t("Share {n}: {problem}", { n: e.share, problem: text }) : text;
}

function wording(e) {
  switch (e.code) {
    case "empty": return t("Nothing typed.");
    case "case": return t("Upper and lower case are mixed: type it all in capitals, or all in small letters.");
    case "prefix":
      return e.partial ? t("A share starts with MS1.") : t("This does not start with MS1, as every codex32 share does.");
    case "char": {
      const p = { position: e.position, char: q(e.char) };
      if (e.suggestion) {
        return t("Character {position} is {char}, which codex32 does not use. {suggestion} there makes the " +
          "checksum valid: check it against the paper.", { ...p, suggestion: q(e.suggestion) });
      }
      let text = e.lookalike
        ? t("Character {position} is {char}, which codex32 does not use (perhaps {lookalike}?).",
          { ...p, lookalike: q(e.lookalike) })
        : t("Character {position} is {char}, which codex32 does not use.", p);
      if (e.count > 1) {
        text += " " + plural(e.count - 1, "{n} more character is not codex32 either.",
          "{n} more characters are not codex32 either.");
      }
      return text;
    }
    case "length": {
      const n = e.length;
      const short = e.shortBy === null ? null : plural(e.shortBy, "{n} character short of {length}",
        "{n} characters short of {length}", { length: n + e.shortBy });
      const over = e.overBy === null ? null : plural(e.overBy, "{n} character over {length}",
        "{n} characters over {length}", { length: n - e.overBy });
      if (short && over) {
        return t("This has {n} characters; a share has 48, 54, 61, 67, 74 or 127 (this is {short}, or {over}).",
          { n, short, over });
      }
      return t("This has {n} characters; a share has 48, 54, 61, 67, 74 or 127 (this is {hint}).",
        { n, hint: short || over });
    }
    case "threshold": return t("Character 4 is the threshold: {char} is not 0 or 2 to 9.", { char: q(e.char) });
    case "threshold0":
      return t("Threshold 0 means an unshared secret, whose index (character 9) must be S, not {char}.",
        { char: q(e.char) });
    case "checksum":
      if (e.suggestion) {
        return t("The checksum does not match. Most likely character {position} is mistyped: {suggestion} there " +
          "instead of {char} makes it valid. Check it against the paper.",
        { position: e.position, suggestion: q(e.suggestion), char: q(e.char) });
      }
      return t("The checksum does not match: a character is mistyped. More than one is wrong, or one is missing " +
        "and another is extra.");
    case "invalid": return t("Not a valid share: {reason}.", { reason: e.reason });
    case "none": return t("Type at least one share.");
    case "mismatch":
      return t("Share {share} belongs to a different split ({id}, threshold {k}) than share 1 ({firstId}, " +
        "threshold {firstK}).", { share: e.share, id: up(e.id), k: e.thresholdChar, firstId: up(e.firstId),
        firstK: e.firstThresholdChar });
    case "lengths":
      return t("Share {share} is {length} characters long and share 1 {firstLength}: the shares of one split are " +
        "all the same length.", { share: e.share, length: e.length, firstLength: e.firstLength });
    case "duplicate":
      return t("Shares {other} and {share} are the same share (index {index}).",
        { other: e.other, share: e.share, index: up(e.index) });
    case "count":
      return plural(e.have, "These shares have threshold {k}: exactly {k} are needed, and there is {n}.",
        "These shares have threshold {k}: exactly {k} are needed, and there are {n}.", { k: e.need });
    case "recover": return t("Could not recover: {reason}.", { reason: e.reason });
    case "size": return t("The secret has {bytes} bytes, which BIP-93 does not allow.", { bytes: e.bytes });
    default: return null;
  }
}
