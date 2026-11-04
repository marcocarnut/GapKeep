#!/usr/bin/env python3
"""
Makes the Google Authenticator exports (otpauth-migration://offline?data=...)
used by apps/totp/lib/selftest.js and tests/totp.txt, with an encoder
independent of the app's decoder. Field numbers: migration.proto of
https://github.com/dim13/otpauth (migration/migration.proto).

    python3 tests/totp/make_migration.py
"""

import base64
import urllib.parse


def varint(n):
    if n < 0:
        n += 1 << 64            # int32/int64: two's complement, 10 bytes
    out = b''
    while True:
        b = n & 0x7f
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def field(num, wire, value):
    tag = varint(num << 3 | wire)
    if wire == 2:
        return tag + varint(len(value)) + value
    return tag + varint(value)


# OtpParameters: 1 secret, 2 name, 3 issuer, 4 algorithm (1 SHA1, 2 SHA256,
# 3 SHA512, 4 MD5), 5 digits (1 six, 2 eight), 6 type (1 HOTP, 2 TOTP)
def otp(secret, name, issuer, algorithm, digits, otp_type):
    return (field(1, 2, secret) + field(2, 2, name.encode()) + field(3, 2, issuer.encode()) +
            field(4, 0, algorithm) + field(5, 0, digits) + field(6, 0, otp_type))


# MigrationPayload: 1 otp_parameters, 2 version, 3 batch_size, 4 batch_index, 5 batch_id
def payload(otps, size=1, index=0, batch_id=12345):
    return (b''.join(field(1, 2, o) for o in otps) + field(2, 0, 1) + field(3, 0, size) +
            field(4, 0, index) + field(5, 0, batch_id))


def uri(p):
    return 'otpauth-migration://offline?data=' + urllib.parse.quote(base64.b64encode(p).decode(), safe='')


# RFC 6238's seeds
S1 = b'12345678901234567890'
S256 = b'12345678901234567890123456789012'

print('two accounts (SHA1 and SHA256, 8 digits):')
print(uri(payload([otp(S1, 'alice@example.com', 'Example', 1, 2, 2),
                   otp(S256, 'ACME Co:bob', '', 2, 2, 2)])))
print('part 2 of 2, batch -7: HOTP, MD5, and TOTP with defaults:')
print(uri(payload([otp(S1, 'carol', 'Hotp Inc', 1, 1, 1),
                   otp(S1, 'dave', 'Md5 Inc', 4, 1, 2),
                   otp(S1, 'erin', 'Good', 0, 0, 2)], size=2, index=1, batch_id=-7)))
