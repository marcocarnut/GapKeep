#!/usr/bin/env python3
"""Writes tests/native/argon2_vectors.json: Argon2id known answers made
with the reference implementation (P-H-C/phc-winner-argon2, built as a
shared library: give its path), for tools/check_pgp.py and the pgpcrypto
test app. RFC 9106's own vector is among them.

    python3 tools/make_argon2_vectors.py path/to/libargon2.so

SPDX-License-Identifier: GPL-3.0-or-later
"""
import ctypes, json, random, sys

OUT = "tests/native/argon2_vectors.json"


class Ctx(ctypes.Structure):
    _fields_ = [("out", ctypes.c_char_p), ("outlen", ctypes.c_uint32),
                ("pwd", ctypes.c_char_p), ("pwdlen", ctypes.c_uint32),
                ("salt", ctypes.c_char_p), ("saltlen", ctypes.c_uint32),
                ("secret", ctypes.c_char_p), ("secretlen", ctypes.c_uint32),
                ("ad", ctypes.c_char_p), ("adlen", ctypes.c_uint32),
                ("t_cost", ctypes.c_uint32), ("m_cost", ctypes.c_uint32),
                ("lanes", ctypes.c_uint32), ("threads", ctypes.c_uint32),
                ("version", ctypes.c_uint32), ("allocate_cbk", ctypes.c_void_p),
                ("free_cbk", ctypes.c_void_p), ("flags", ctypes.c_uint32)]


def main():
    lib = ctypes.CDLL(sys.argv[1])

    def argon2id(pw, salt, t, p, m, length, key=b"", ad=b""):
        out = ctypes.create_string_buffer(length)
        ctx = Ctx(ctypes.cast(out, ctypes.c_char_p), length, pw, len(pw), salt, len(salt), key or None, len(key),
                  ad or None, len(ad), t, m, p, 1, 0x13, None, None, 0)
        assert lib.argon2_ctx(ctypes.byref(ctx), 2) == 0
        return out.raw.hex()

    rnd = random.Random(2026)
    vectors = []
    # RFC 9106, 5.3
    vectors.append({"t": 3, "p": 4, "m": 32, "password": "01" * 32, "salt": "02" * 16, "key": "03" * 8,
                    "ad": "04" * 12, "length": 32,
                    "tag": argon2id(b"\1" * 32, b"\2" * 16, 3, 4, 32, 32, b"\3" * 8, b"\4" * 12)})
    # OpenPGP S2K type 4 shapes: 16-byte salt, m = 2^e KiB, key-sized tags
    for t, p, e, length in ((1, 4, 6, 16), (3, 4, 8, 32), (1, 1, 3, 24), (2, 2, 10, 32), (1, 8, 6, 16)):
        pw, salt = rnd.randbytes(rnd.randrange(1, 30)), rnd.randbytes(16)
        vectors.append({"t": t, "p": p, "m": 1 << e, "password": pw.hex(), "salt": salt.hex(), "length": length,
                        "tag": argon2id(pw, salt, t, p, 1 << e, length)})
    # odd sizes: m not a multiple of 4p, long and short tags, empty password
    for t, p, m, length in ((1, 3, 100, 4), (2, 1, 9, 65), (1, 2, 17, 1024), (4, 3, 50, 32)):
        pw, salt = rnd.randbytes(rnd.randrange(0, 20)), rnd.randbytes(rnd.choice((8, 16, 20)))
        vectors.append({"t": t, "p": p, "m": m, "password": pw.hex(), "salt": salt.hex(), "length": length,
                        "tag": argon2id(pw, salt, t, p, m, length)})
    json.dump(vectors, open(OUT, "w"), indent=1)
    print(f"{OUT}: {len(vectors)} vectors")


if __name__ == "__main__":
    main()
