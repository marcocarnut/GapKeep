// User-facing text: codex32_recover.html's own English strings (in
// ../vendor/recover.js, STRINGS.en), with the HTML taken out, and a few
// replaced where they speak of a browser: pasting, the clipboard, closing
// the page. tests/codex32/run_node.mjs checks that the page's are still its
// own, word for word.
//
// Translated through gk:i18n (lang/<language>.json): the English is the key.
// The page's {placeholders} stay in the text, as on the page, and F() fills
// them; the pt-BR catalog starts from the page's own Portuguese (STRINGS.pt).

import { t } from "gk:i18n";

export const S = {
  // the page's, as it has them
  h1Title: t("Recombine codex32 shares"),
  subtitle: t("Rebuilds a BIP-39 phrase (12, 15, 18 or 24 words) from shares made by dice39."),
  recoverBtn: t("Recover the phrase"),
  scanBtn: t("Scan with camera"),
  scanStop: t("Stop camera"),
  scanAiming: t("Point the camera at a share QR. {n} collected so far."),
  scanAdded: t("Added share index {i}. {n} of {k} collected."),
  scanDuplicate: t("That is share index {i}, which you already have."),
  scanNotShare: t("That QR is not a codex32 share."),
  scanMismatch: t("That share belongs to a different split ({id}, threshold {k})."),
  scanNoCamera: t("No camera was found. Type the shares instead."),
  clearBtn: t("Clear"),
  resultHeading: t("Recovered phrase"),
  metaThreshold: t("Threshold"),
  metaId: t("Identifier"),
  metaShares: t("Shares used"),
  entropyLabel: t("Entropy ({bytes} bytes, hex)"),
  secretLabel: t("codex32 secret (index s)"),
  resultNote: t("Type these {t} words into your wallet in this order. This is a BIP-39 phrase: give it to a " +
    "wallet as a BIP-39 recovery phrase, not as a raw BIP-32 seed."),
  errWrongSize: t("These shares carry {n} bytes. dice39 makes seeds of 16, 20, 24 and 32 bytes (12, 15, 18 and " +
    "24 words), and {n} is none of those — recovery stopped rather than guess."),
  tabWordsLabel: t("QR of the words"),
  tabSeedLabel: t("SeedQR"),
  qrIntro: t("Use this if your wallet is on another device — a hardware wallet, or a phone."),
  qrWarningHtml: t("A QR code of your seed is scannable the instant a camera sees it. Only reveal this on your " +
    "air-gapped device, scan it live with the importing wallet’s camera, and never let it sit as a " +
    "saved photo (camera roll, cloud backup, screenshot). Prefer the 3-part split below if your " +
    "wallet supports scanning multiple codes — it raises the bar against an opportunistic single " +
    "photo, though each part alone still leaks those {third} words in the clear."),
  qrConfirmLabel: t("I understand this reveals my seed as a scannable code, and I will scan it live rather than " +
    "save it."),
  qrBtnSingle: t("Show single QR (all {t} words)"),
  qrBtnSplit: t("Show 3-part QR ({third} + {third} + {third} words)"),
  qrLabelSingle: t("All {t} words — scan live, do not screenshot"),
  qrLabelSplit: t("Words {a}–{b} of {t} — scan live, do not screenshot"),
  seedIntro: t("Use this if the wallet you are restoring into reads SeedSigner-style codes rather than a line " +
    "of text — SeedSigner itself, Krux, and others that followed them."),
  seedWarningHtml: t("These carry exactly what the words carry, in a notation no human reads back — which cuts " +
    "both ways. Nothing on the code says what it is, so nothing warns whoever finds it, and a Compact " +
    "SeedQR is the whole secret in {bytes} anonymous bytes. Reveal it only on your air-gapped " +
    "device, scan it live with the importing wallet’s camera, and never let it sit as a saved " +
    "photo (camera roll, cloud backup, screenshot)."),
  seedConfirmLabel: t("I understand these codes are the recovered seed in another notation, and I will scan them " +
    "live rather than save them."),
  qrBtnSeed: t("Show SeedQR (SeedSigner format)"),
  qrBtnCompact: t("Show Compact SeedQR (smallest grid)"),
  qrLabelSeed: t("SeedQR, {g} — scan live, do not screenshot"),
  qrLabelCompact: t("Compact SeedQR, {g} — scan live, do not screenshot"),
  qrFormatNote: t("Both carry the same seed as numbers rather than words. SeedQR spells out each word’s position " +
    "in the BIP-39 list; Compact SeedQR carries only the entropy, so its grid is one size smaller " +
    "— quicker to scan, and appreciably less work to copy by hand onto metal. A wallet that reads " +
    "one of these often reads neither the other nor the plain words, so check what yours takes " +
    "before you rely on it."),

  // replaced: the page's first sentence (do this offline) goes without saying
  // here, and there is no pasting, clipboard or page to close
  warnHtml: t("The moment enough shares are in one place, the seed exists again — that is the point of the " +
    "exercise and also its whole risk. Press Clear when you are done: it erases the shares and the result from " +
    "this app."),
  inputHeading: t("Type your shares"),
  inputHelp: t("One per box. You need exactly as many as the threshold the shares were made with — a 2-of-3 " +
    "split needs 2, no more and no fewer. Case does not matter, and spaces are ignored. Enter goes on to the " +
    "next box, and recovers from the last one."),
  errNoShares: t("Type your shares first, one per box."),
  exportHeading: t("Getting the phrase off this device"),
  exportCompare: t("The shares you just combined were the safe form of this secret — no one of them was worth " +
    "stealing. What is on screen now is the whole of it in one place, and every way out of here carries all " +
    "of it.\n" +
    "- QR of the words — the same secret carried by light rather than a cable, which is what makes an " +
    "air-gapped machine practical. The price is a camera, a lit screen, and whatever else can see either.\n" +
    "- SeedQR and Compact SeedQR — the same exposure in a different notation, for wallets that read these and " +
    "not plain text. A different format, not a safer one.\n\n" +
    "When you are done here, press Clear. The shares are what this secret should go back to living as."),
};

// The page's keys above, as STRINGS.en has them (tests/codex32/run_node.mjs)
export const PAGE_KEYS = ["h1Title", "subtitle", "recoverBtn", "scanBtn", "scanStop", "scanAiming", "scanAdded",
  "scanDuplicate", "scanNotShare", "scanMismatch", "scanNoCamera", "clearBtn", "resultHeading", "metaThreshold",
  "metaId", "metaShares", "entropyLabel", "secretLabel", "resultNote", "errWrongSize", "tabWordsLabel",
  "tabSeedLabel", "qrIntro", "qrWarningHtml", "qrConfirmLabel", "qrBtnSingle", "qrBtnSplit", "qrLabelSingle",
  "qrLabelSplit", "seedIntro", "seedWarningHtml", "seedConfirmLabel", "qrBtnSeed", "qrBtnCompact", "qrLabelSeed",
  "qrLabelCompact", "qrFormatNote"];

// "{t} words" and the like: the page's placeholders
export const F = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
