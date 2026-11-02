// User-facing text. The warnings are dice39's own wording (English), with
// the HTML taken out: each is [headline, explanation].

export const S = {
  tagline: "Entropy you see.",
  need: "You need a coin, four six-sided dice (one works: roll it four times) and the printed dice tables. " +
    "Print the tables from the dice39 web page on any computer: they hold no secret.",
  procedure: "For each word: flip the coin to pick the table, then roll two pairs of dice. First pair = column, " +
    "second pair = row. If the cell says REROLL, roll the dice again on this same table; do not re-flip the coin.",
  order: "Read each pair left to right, where the dice land, never smallest first: column 3-5 means first die 3, " +
    "second die 5; 5-3 is a different column.",
  lenNote: "24 words carry 256 bits of entropy and 8 checksum bits; 12 words carry 128 and 4. Both are far beyond " +
    "anything brute-forceable. Switching length clears the boxes: the same words mean a different wallet at each length.",
  entryHelp: "Type each word, or its dice code instead: a3526 or b3526 (table, then the four dice). " +
    "Just 3526 offers both tables' words to pick from. Enter moves to the next box; Enter on an empty box " +
    "goes on to the entropy pad below.",
  reroll: "REROLL: throw the four dice again on this same table, and do not re-flip the coin.",

  coinSkip: (n, t, odds, actual, ideal) => [
    `All ${n} of your words come from Table ${t}.`,
    `If you flipped the coin before every word, that is a 1-in-${odds} coincidence; much more likely the coin got ` +
    `skipped and every word was read off one table. That costs about 1 bit per word: your ${n} words carry roughly ` +
    `${actual} bits instead of ${ideal}. The phrase is still far beyond anything breakable, so this is your call, ` +
    `but if the coin was skipped and you want the full ${ideal}, start over and roll again.`],
  patternIdentical: (n) => [
    `All ${n} of the words you typed are the same word.`,
    `Dice do not do that. It looks like the boxes were filled in by hand rather than read off a throw, which means ` +
    `those ${n} positions carry about 11 bits between them, not 11 each. The phrase is valid and the words this ` +
    `device supplied are unaffected, so this is your call, but if these were not rolled, start over and roll them.`],
  patternOrdered: (n, dir) => [
    `The ${n} words you typed run in ${dir} wordlist order.`,
    `A real throw does that with probability under one in a hundred million even at 12 words, so this almost ` +
    `certainly means the boxes were filled in by hand rather than read off the dice. The phrase is valid and the ` +
    `words this device supplied are unaffected, so this is your call, but if these were not rolled, start over and roll them.`],
  sortedPairs: (n, dir, odds) => [
    `Every pair of dice you looked up was in ${dir} order.`,
    `The printed tables are read left to right: the first die of a pair names the column digit, the second names ` +
    `the row digit. It looks like each pair was sorted before it was looked up. A real set of ${n} throws lands ` +
    `this way about once in ${odds} times, so this is much more likely a misread of the procedure. Sorting folds ` +
    `5-3 onto 3-5: fifteen of the thirty-six columns become unreachable and the rest stop being equally likely, ` +
    `which costs roughly a bit and a half per word. The phrase is valid, so nothing is broken, but if you sorted ` +
    `the dice, start over and read each pair in the order it fell.`],

  qrWarning: "This shows your whole seed as a code that any camera pointed at this screen can read. " +
    "Make sure no camera, window or person can see the screen, and only scan it with the wallet you mean to use.",
  codex32Warning: "These shares split the entropy of your phrase, not a BIP-32 seed. Recovering them with a generic " +
    "BIP-93 tool gives back the entropy, and handing that to a wallet as a raw seed opens a different, empty wallet, " +
    "silently. Recover with dice39's codex32_recover page, which turns the entropy back into your words.",
  deviceEntropy: "The device words come from zerogap's hardware random generator (health-checked, SHA-256 " +
    "conditioned) mixed with what you did on the entropy pad and the timing of every key you pressed, hashed " +
    "together with SHA-256.",

  // the entropy pad: dice39's own wording, plus the keyboard way in
  step2Heading: "Add device entropy",
  step2Body: "Press and drag inside the box below, or tap it repeatedly, until the bar fills. Only real drags and " +
    "taps count: moving the pointer across it without pressing does nothing, and neither does jiggling in " +
    "place. This mixes with this device's own random generator to source words beyond what you typed. " +
    "Without a mouse: Tab to the box and press Space, again and again (holding it down counts once).",
  padText: "press and drag here, or tap repeatedly",
  bitsLabel: (bits, target) => `collected: ${bits} of ${target} bits`,
};
