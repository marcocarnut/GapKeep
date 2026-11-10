// The BIP-93 test vectors, all of them, as published in
// https://github.com/bitcoin/bips/blob/master/bip-0093.mediawiki
// (fetched 2026-11-05). Used by lib/selftest.js, in the app and under Node.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Valid: each recovers `seed` (hex) and the codex32 secret `secret`.
// `shares` are what is typed; `derived` are more shares of the same split,
// as the BIP gives them: any `k` of shares + derived recover the seed too.
export const VALID = [
  { name: "vector 1 (unshared, threshold 0)", k: 1,
    shares: ["ms10testsxxxxxxxxxxxxxxxxxxxxxxxxxx4nzvca9cmczlw"],
    secret: "ms10testsxxxxxxxxxxxxxxxxxxxxxxxxxx4nzvca9cmczlw",
    seed: "318c6318c6318c6318c6318c6318c631" },
  { name: "vector 2 (2 of n, upper case)", k: 2,
    shares: ["MS12NAMEA320ZYXWVUTSRQPNMLKJHGFEDCAXRPP870HKKQRM",
             "MS12NAMECACDEFGHJKLMNPQRSTUVWXYZ023FTR2GDZMPY6PN"],
    derived: ["MS12NAMEDLL4F8JLH4E5VDVULDLFXU2JHDNLSM97XVENRXEG"],
    secret: "ms12names6xqguzttxkeqnjsjzv4jv3nz5k3kwgsphuh6evw",
    seed: "d1808e096b35b209ca12132b264662a5" },
  { name: "vector 3 (3 of 5)", k: 3,
    shares: ["ms13casha320zyxwvutsrqpnmlkjhgfedca2a8d0zehn8a0t",
             "ms13cashcacdefghjklmnpqrstuvwxyz023949xq35my48dr",
             "ms13cashd0wsedstcdcts64cd7wvy4m90lm28w4ffupqs7rm"],
    derived: ["ms13casheekgpemxzshcrmqhaydlp6yhms3ws7320xyxsar9",
              "ms13cashf8jh6sdrkpyrsp5ut94pj8ktehhw2hfvyrj48704"],
    secret: "ms13cashsllhdmn9m42vcsamx24zrxgs3qqjzqud4m0d6nln",
    seed: "ffeeddccbbaa99887766554433221100" },
  { name: "vector 4 (256 bits, unshared)", k: 1,
    shares: ["ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqqtum9pgv99ycma"],
    secret: "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqqtum9pgv99ycma",
    seed: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100" },
  { name: "vector 5 (512 bits, long checksum)", k: 1,
    shares: ["MS100C8VSM32ZXFGUHPCHTLUPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZYGSFJD6AN074RXVCEMLH8WU3TK925ACDEFGHJKLMNPQRSTUVWXY06FHPV80UNDVARHRAK"],
    secret: "ms100c8vsm32zxfguhpchtlupzry9x8gf2tvdw0s3jn54khce6mua7lqpzygsfjd6an074rxvcemlh8wu3tk925acdefghjklmnpqrstuvwxy06fhpv80undvarhrak",
    seed: "dc5423251cb87175ff8110c8531d0952d8d73e1194e95b5f19d6f9df7c01111104c9baecdfea8cccc677fb9ddc8aec5553b86e528bcadfdcc201c17c638c47e9" },
  { name: "vector 6 (160 bits)", k: 1,
    shares: ["ms10seedsqqqsyqcyq5rqwzqfpg9scrgwpugpzysn9vaqzzvs20xnl"],
    secret: "ms10seedsqqqsyqcyq5rqwzqfpg9scrgwpugpzysn9vaqzzvs20xnl",
    seed: "000102030405060708090a0b0c0d0e0f10111213" },
  { name: "vector 7 (192 bits, padding 101)", k: 1,
    shares: ["ms10seedsyqsjygeyy5nzw2pf9g4jctfw9ucrzv3nxs6nvdau84gz0632s0xs"],
    secret: "ms10seedsyqsjygeyy5nzw2pf9g4jctfw9ucrzv3nxs6nvdau84gz0632s0xs",
    seed: "202122232425262728292a2b2c2d2e2f3031323334353637" },
  { name: "vector 8 (224 bits, padding 1)", k: 1,
    shares: ["ms10seedsgpq5ys6yg4rywjzfff95cn2wfag9z5jn2324v46ct9d9hrcduqw8c3lccl"],
    secret: "ms10seedsgpq5ys6yg4rywjzfff95cn2wfag9z5jn2324v46ct9d9hrcduqw8c3lccl",
    seed: "404142434445464748494a4b4c4d4e4f505152535455565758595a5b" },
];

// Vector 3's other valid encodings of the same seed (any padding bits), and
// vector 4's sixteen: all decode to the same seed.
export const ALTERNATIVES = [
  { seed: "ffeeddccbbaa99887766554433221100", secrets: [
    "ms13cashsllhdmn9m42vcsamx24zrxgs3qqjzqud4m0d6nln",
    "ms13cashsllhdmn9m42vcsamx24zrxgs3qpte35dvzkjpt0r",
    "ms13cashsllhdmn9m42vcsamx24zrxgs3qzfatvdwq5692k6",
    "ms13cashsllhdmn9m42vcsamx24zrxgs3qrsx6ydhed97jx2"] },
  { seed: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100", secrets: [
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqqtum9pgv99ycma",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqpj82dp34u6lqtd",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqzsrs4pnh7jmpj5",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqrfcpap2w8dqezy",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqy5tdvphn6znrf0",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyq9dsuypw2ragmel",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqx05xupvgp4v6qx",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyq8k0h5p43c2hzsk",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqgum7hplmjtr8ks",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqf9q0lpxzt5clxq",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyq28y48pyqfuu7le",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqt7ly0paesr8x0f",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqvrvg7pqydv5uyz",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqd6hekpea5n0y5j",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyqwcnrwpmlkmt9dt",
    "ms10leetsllhdmn9m42vcsamx24zrxgs3qrl7ahwvhw4fnzrhve25gvezzyq0pgjxpzx0ysaam"] },
];

// Invalid: [the Codex32Error code checkShare gives, the string]. The BIP's
// groups, in its order.
export const INVALID = [
  // incorrect checksums
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxve740yyge2ghq"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxve740yyge2ghp"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxlk3yepcstwr"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxx6pgnv7jnpcsp"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxx0cpvr7n4geq"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxm5252y7d3lr"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxrd9sukzl05ej"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxc55srw5jrm0"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxgc7rwhtudwc"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxx4gy22afwghvs"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxme084q0vpht7pe0"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxme084q0vpht7pew"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxqyadsp3nywm8a"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzvg7ar4hgaejk"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxcznau0advgxqe"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxch3jrc6j5040j"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx52gxl6ppv40mcv"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx7g4g2nhhle8fk"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx63m45uj8ss4x8"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxy4r708q7kg65x"],
  // the wrong checksum for their data sizes
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxurfvwmdcmymdufv"],
  ["checksum", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxcwm4re8fs78vn"],
  // improper lengths
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxwqey9rfs6smenxa"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxw0a4c70rfefn4"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxk4pavy5n46nea"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxx9lrwar5zwng4w"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxr335l5tv88js3"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxvu7q9nz8p7dj68v"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpq6k542scdxndq3"],
  ["length", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxkmfw6jm270mz6ej"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxzhddxw99w7xws"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxxx42cux6um92rz"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxxxxarja5kqukdhy9"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxky0ua3ha84qk8"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9eheesxadh2n2n9"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9llwmgesfulcj2z"],
  ["length", "ms12fauxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx02ev7caq6n9fgkf"],
  // a "0" threshold with a non-"s" index
  ["threshold0", "ms10fauxxxxxxxxxxxxxxxxxxxxxxxxxxxx0z26tfn0ulw3p"],
  // a threshold that is not a digit
  ["threshold", "ms1fauxxxxxxxxxxxxxxxxxxxxxxxxxxxxxda3kr3s0s2swg"],
  // not beginning with "ms1"
  ["prefix", "0fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["prefix", "10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["prefix", "ms0fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["prefix", "m10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["prefix", "s10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["prefix", "0fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxhkd4f70m8lgws"],
  ["prefix", "10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxhkd4f70m8lgws"],
  ["prefix", "m10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxx8t28z74x8hs4l"],
  ["prefix", "s10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxh9d0fhnvfyx3x"],
  // mixed upper and lower case
  ["case", "Ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["case", "mS10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["case", "MS10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["case", "ms10FAUXsxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["case", "ms10fauxSxxxxxxxxxxxxxxxxxxxxxxxxxxuqxkk05lyf3x2"],
  ["case", "ms10fauxsXXXXXXXXXXXXXXXXXXXXXXXXXXuqxkk05lyf3x2"],
  ["case", "ms10fauxsxxxxxxxxxxxxxxxxxxxxxxxxxxUQXKK05LYF3X2"],
];
