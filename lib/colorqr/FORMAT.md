# colorqr format, version 1

A colorqr symbol is an ordinary QR code in which data modules are coloured instead of black or white.
Each colour stays on the correct side of the dark/light threshold, so ordinary readers decode the QR
code as usual. A colour reader recovers extra data from the colours.

All values are bit-exact. `colorqr/format.py` is the reference and `tests/vectors/golden.json` holds
test vectors.

## Module classes

The base QR code must first be decoded to get the exact dark/light value of every module. That value
is called the module's class. Colours only have to be told apart within their class.

Finder, separator, timing, alignment, format, version and always-dark modules stay pure black or
white. Colour is only applied to data-region modules, including remainder bits.

## Module order

List the data-region modules in row-major order: `(row, col)`, top row first, left to right. Shuffle
that list with Fisher-Yates:

    s = 0xC010C010 XOR version
    for i = K-1 down to 1:
        s ^= (s << 13) & 0xFFFFFFFF;  s ^= s >> 17;  s ^= (s << 5) & 0xFFFFFFFF
        j = s mod (i+1)
        swap m[i], m[j]

The shuffled list `m` has `K` modules and is split in this order:

| Modules | Count | Content |
|---|---|---|
| Header | 80 | 16 header bits, repeated 5 times |
| Pilots | `(K*6 + 50) div 100` | Known symbols for calibration |
| Data | the rest | Symbol stream |

## Header

    word = 0xB << 12 | profile << 8 | rate_index << 4 | crc4(0xB << 8 | profile << 4 | rate_index)

`crc4` is polynomial `x^4 + x + 1`, zero initial state, over the 12 bits, most significant bit first.

Module `i` of the header carries bit `15 - (i mod 16)` of `word`, in these fixed colours regardless of
profile:

| Bit | Dark class | Light class |
|---|---|---|
| 1 | (191, 0, 0) | (255, 255, 64) |
| 0 | (0, 0, 191) | (64, 255, 255) |

To read it, normalise each module by the black and white function modules, then sum `R - B` across the
5 repeats of each bit. A positive sum is a 1. A symbol whose word fails the magic or the CRC has no
colour layer.

`rate_index` selects the code rate from: 1/2, 2/3, 3/4, 5/6, 7/8, 9/10, 37/40, 19/20.

## Profiles

Each profile lists colours by label, in 8-bit sRGB. A profile with `n` colours in each class carries
`log2(n)` bits per module.

| ID | Name | Bits per module | Dark labels 0.. | Light labels 0.. |
|---|---|---|---|---|
| 0 | a4.50 | 2 | (89,13,89) (191,0,0) (0,0,191) (0,64,0) | (166,242,166) (64,255,255) (255,255,64) (255,191,255) |
| 1 | a8.50 | 3 | (64,0,127) (0,0,191) (0,0,64) (0,64,127) (101,0,0) (191,0,0) (71,60,60) (4,64,0) | (191,255,128) (255,255,64) (255,255,191) (255,191,128) (154,255,255) (64,255,255) (184,195,195) (251,191,255) |

Profile 1 needs version 2 or higher: a version 1 symbol has too few modules to calibrate 8 colours.

Every profile keeps at least its stated gray gap under five gray formulas on gamma-encoded values:
Rec.601, Rec.709, (R+2G+B)/4, (R+G+B)/3 and green only.

## Pilots

Walk the pilot modules in order, keeping one counter per class. A pilot's label is its class counter
mod `n`, and the counter then increments.

## Symbol stream

Data modules carry `n = data_modules * bits` stream bits, most significant bit of each label first.

The message is:

    u16 length (big-endian) | u32 CRC-32 of payload (big-endian, zlib) | payload | zero padding

It fills exactly `k` bits, where `k = (n * num div den) div 8 * 8` for rate `num/den`. So
`capacity = k div 8 - 6` bytes. Message bytes become bits most significant bit first.

## Error-correcting code

A repeat-accumulate code, generated at any `n` and `k`, with `m = n - k` checks. `shuffle(a)` is
Fisher-Yates as in "Module order", continuing the same generator state `s` between calls.

    s = (0xC0DEC0DE XOR n XOR (k << 16)) & 0xFFFFFFFF

    sockets = 0,0,0,0, 1,1,1,1, ... k-1,k-1,k-1,k-1      (every information bit, 4 times)
    shuffle(sockets)
    cap = len(sockets) div m + 1
    for i, b in sockets:
        r = i mod m
        while row r already contains b, or row r holds cap entries:
            r = (r + 1) mod m
        append b to row r

    perm = 0, 1, ... n-1
    shuffle(perm)

The search stops after `m` steps if it finds no row, and appends to the row it reached.

Encoding: information bit `i` is codeword bit `i`. Parity bits follow a running XOR, starting from 0:

    p = 0
    for i in 0 .. m-1:
        for b in row i:  p ^= info[b]
        codeword[k + i] = p

Codeword bit `c` goes to stream position `perm[c]`.

Check `i` of the code is: row `i` XOR parity `i` XOR parity `i-1` (no `i-1` for `i = 0`) = 0.

## Reader outline

1. Locate the symbol with any QR locator: four approximate corners and the version.
2. If the input has no gamma curve, for example raw sensor data, take the square root of every value.
3. Refine the corners on known function modules, using a blurred gray image of (R+2G+B)/4.
4. Sample every module, threshold it, read the format bits, and correct the codewords with the QR
   code's Reed-Solomon parity. Rebuild the full module matrix from the corrected codewords.
5. Refine the corners again against the rebuilt matrix, and sample RGB at each module.
6. Read the header, which gives the profile and the rate.
7. Compute colour likelihoods within each module's class. Calibrate from function modules and pilots.
8. Turn them into bit log-likelihood ratios, decode the code, and check the CRC-32. Likelihoods should
   be tempered and clipped: blur makes a Gaussian model overconfident, and belief propagation trusts it.

The wire format above is normative. These steps are not: any reader that recovers the stream is valid.
