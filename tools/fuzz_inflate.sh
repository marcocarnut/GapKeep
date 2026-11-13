#!/bin/sh
#
# Fuzzes gk:zlib's decompression (src/runtime/inflate.c, zlib's inflate in
# third_party/zlib) on this machine with AddressSanitizer and UBSan:
# tests/fuzz/fuzz_inflate.cpp. Seeds come from Python's zlib (raw DEFLATE
# and zlib streams of empty, small, repetitive, random and large data, at
# several levels); each must decompress exactly, then mutated ones must
# never break a limit or memory.
#
#   tools/fuzz_inflate.sh [rounds] [seed]      (default 100000 rounds, seed 1)
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/sim/build/fuzz
mkdir -p "$OUT"
python3 -I - "$OUT/inflate-seeds.bin" <<'EOF'
import random, sys, zlib
rnd = random.Random(7)
with open(sys.argv[1], "wb") as f:
    datas = [b"", b"a", b"GapKeep " * 1000, bytes(70000), rnd.randbytes(3000), rnd.randbytes(200000),
             b"".join(rnd.choice([b"ab", b"cde", b"\0" * 50]) for _ in range(5000))]
    for d in datas:
        for level in (0, 1, 6, 9):
            for fmt, wbits in ((0, -15), (1, 15)):
                c = zlib.compressobj(level, zlib.DEFLATED, wbits)
                s = c.compress(d) + c.flush()
                f.write(bytes([fmt]) + len(d).to_bytes(4, "big") + d + len(s).to_bytes(4, "big") + s)
EOF
SAN="-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -g -O1"
Z=$ROOT/third_party/zlib
for f in adler32 inffast inflate inftrees zutil; do
	gcc -std=gnu11 -DNO_GZIP -DZ_SOLO $SAN -I "$Z" -c -o "$OUT/z_$f.o" "$Z/$f.c"
done
gcc -std=gnu11 -Wall -DZ_SOLO $SAN -I "$Z" -c -o "$OUT/gk_inflate.o" "$ROOT/src/runtime/inflate.c"
gcc -std=gnu11 -Wall $SAN -c -o "$OUT/gk_wipe.o" "$ROOT/src/crypto/wipe.c"
g++ -std=c++17 -Wall $SAN -I "$ROOT/src/runtime" -o "$OUT/fuzz_inflate" "$ROOT/tests/fuzz/fuzz_inflate.cpp" \
	"$OUT/gk_inflate.o" "$OUT/gk_wipe.o" "$OUT"/z_*.o
exec "$OUT/fuzz_inflate" "$OUT/inflate-seeds.bin" "${1:-100000}" "${2:-1}"
