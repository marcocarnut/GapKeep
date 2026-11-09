// User-facing text. The warnings are dice39's own wording (English), with
// the HTML taken out: each is [headline, explanation].
//
// Translated through gk:i18n (lang/<language>.json): the English is the key.
// The values (counts, bits, odds, tables) are {placeholders}, so a
// translation can reword a sentence but not change what it shows.

import { t } from "gk:i18n";

export const S = {
  tagline: t("Entropy you see."),
  need: t("You need a coin, four six-sided dice (one works: roll it four times) and the printed dice tables. " +
    "Print the tables from the dice39 web page on any computer: they hold no secret."),
  procedure: t("For each word: flip the coin to pick the table, then roll two pairs of dice. First pair = column, " +
    "second pair = row. If the cell says REROLL, roll the dice again on this same table; do not re-flip the coin."),
  order: t("Read each pair left to right, where the dice land, never smallest first: column 3-5 means first die 3, " +
    "second die 5; 5-3 is a different column."),
  lenNote: t("24 words carry 256 bits of entropy and 8 checksum bits; 18 words carry 192 and 6, 15 words 160 and 5, " +
    "and 12 words 128 and 4. All four are far beyond anything brute-forceable, and 12 is what many hardware wallets " +
    "show by default: pick a shorter one if you want less to write down and check by hand. The same words mean a " +
    "different wallet at each length."),
  entryHelp: t("Type each word, or its dice code instead: a3526 or b3526 (table, then the four dice). " +
    "Just 3526 offers both tables' words to pick from. Enter moves to the next box; Enter on an empty box " +
    "goes on to the entropy pad below."),
  reroll: t("REROLL: throw the four dice again on this same table, and do not re-flip the coin."),

  coinSkip: (n, table, odds, actual, ideal) => [
    t("All {n} of your words come from Table {table}.", { n, table }),
    t("If you flipped the coin before every word, that is a 1-in-{odds} coincidence; much more likely the coin got " +
      "skipped and every word was read off one table. That costs about 1 bit per word: your {n} words carry roughly " +
      "{actual} bits instead of {ideal}. The phrase is still far beyond anything breakable, so this is your call, " +
      "but if the coin was skipped and you want the full {ideal}, start over and roll again.",
    { n, odds, actual, ideal })],
  patternIdentical: (n) => [
    t("All {n} of the words you typed are the same word.", { n }),
    t("Dice do not do that. It looks like the boxes were filled in by hand rather than read off a throw, which means " +
      "those {n} positions carry about 11 bits between them, not 11 each. The phrase is valid and the words this " +
      "device supplied are unaffected, so this is your call, but if these were not rolled, start over and roll them.",
    { n })],
  patternOrdered: (n, up) => [
    up ? t("The {n} words you typed run in ascending wordlist order.", { n })
      : t("The {n} words you typed run in descending wordlist order.", { n }),
    t("A real throw does that with probability under one in a hundred million even at 12 words, so this almost " +
      "certainly means the boxes were filled in by hand rather than read off the dice. The phrase is valid and the " +
      "words this device supplied are unaffected, so this is your call, but if these were not rolled, start over " +
      "and roll them.")],
  sortedPairs: (n, up, odds) => [
    up ? t("Every pair of dice you looked up was in lowest-first order.")
      : t("Every pair of dice you looked up was in highest-first order."),
    t("The printed tables are read left to right: the first die of a pair names the column digit, the second names " +
      "the row digit. It looks like each pair was sorted before it was looked up. A real set of {n} throws lands " +
      "this way about once in {odds} times, so this is much more likely a misread of the procedure. Sorting folds " +
      "5-3 onto 3-5: fifteen of the thirty-six columns become unreachable and the rest stop being equally likely, " +
      "which costs roughly a bit and a half per word. The phrase is valid, so nothing is broken, but if you sorted " +
      "the dice, start over and read each pair in the order it fell.", { n, odds })],

  // a phrase you already have (dice39's import mode, a start of its own here)
  importIntro: (total) => t("Type all {total} words of the seed phrase you already have, in order. This splits an " +
    "existing key: nothing is generated and no device entropy is mixed in. The words are checked and used exactly " +
    "as they are, to make codex32 shares and show the account's public key. (The length is chosen on the start " +
    "page.)", { total }),
  importNeedAll: (total, n) => t("All {total} boxes are needed here: {n} filled so far.", { total, n }),
  importChecksumOk: (total) => t("{total} words, checksum valid: a well-formed BIP-39 phrase.", { total }),
  importChecksumBad: (cs) => t("Checksum does not match: probably a typo, a wrong word, or two words swapped. " +
    "Nothing is corrected here: check the phrase against your backup. (Roughly 1 wrong phrase in " +
    "{space} passes this test anyway, as this phrase carries {cs} checksum bits, so a tick is not proof " +
    "you typed the right one.)", { space: 2 ** cs, cs }),
  importPattern: (total) => [
    t("These {total} words are in wordlist order, or repeat a single word.", { total }),
    t("Phrases shaped like that are published examples, not private ones: every one of them is watched, and " +
      "anything sent to such an address is taken within seconds. Fine if you are trying this out. If this is a " +
      "phrase you actually hold funds on, it is not yours alone and no amount of splitting will make it so.")],
  summaryImport: (total, ent) => t("All {total} words are yours, used exactly as typed: {ent} bits, none of it " +
    "from this device. Its checksum was verified, not rewritten.", { total, ent }),

  // the account's public key
  pubkeyHeading: t("Public key, for a watch-only wallet"),
  pubkeyBody: t("The native segwit account (BIP-84) on Bitcoin's main network, as an output descriptor or a zpub " +
    "(for Electrum): give it to a wallet that watches an account, to see its balance and receive addresses. " +
    "It cannot spend. " +
    "It depends on the BIP-39 passphrase as much as on the words: each passphrase is a different wallet."),
  pubkeyNoPassphrase: t("No passphrase: this is the key of the words alone. If you use a BIP-39 passphrase with " +
    "them, type it above and press Enter."),
  pubkeyPassphrase: (n) => (n === 1
    ? t("With the passphrase typed above ({n} character). A typo in it gives another wallet, with no error: check " +
      "the master fingerprint where you use it.", { n })
    : t("With the passphrase typed above ({n} characters). A typo in it gives another wallet, with no error: check " +
      "the master fingerprint where you use it.", { n })),

  shareQrWarning: t("A share's QR code can be read by any camera that sees this screen. One share alone reveals " +
    "nothing, but enough of them are your seed: scan it live, and keep no photo of it."),

  qrWarning: t("This shows your whole seed as a code that any camera pointed at this screen can read. " +
    "Make sure no camera, window or person can see the screen, and only scan it with the wallet you mean to use."),
  codex32Warning: t("These shares split the entropy of your phrase, not a BIP-32 seed. Recovering them with a " +
    "generic BIP-93 tool gives back the entropy, and handing that to a wallet as a raw seed opens a different, " +
    "empty wallet, silently. Recover with dice39's codex32_recover page, which turns the entropy back into your " +
    "words."),
  deviceEntropy: t("The device words come from GapKeep's hardware random generator (health-checked, SHA-256 " +
    "conditioned) mixed with what you did on the entropy pad and the timing of every key you pressed, hashed " +
    "together with SHA-256."),

  // the entropy pad: dice39's own wording, plus the keyboard way in
  step2Heading: t("Add device entropy"),
  step2Body: t("Press and drag inside the box below, or tap it repeatedly, until the bar fills. Only real drags " +
    "and taps count: moving the pointer across it without pressing does nothing, and neither does jiggling in " +
    "place. This mixes with this device's own random generator to source words beyond what you typed. " +
    "Without a mouse: Tab to the box and type on it, any keys, again and again (holding a key down counts once)."),
  padText: t("press and drag here, tap repeatedly, or type on it"),
  bitsLabel: (bits, target, percent) => t("collected: {bits} of {target} bits   {percent}%", { bits, target, percent }),
};
