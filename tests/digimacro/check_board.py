#!/usr/bin/env python3
"""
After tests/digimacro.txt: does the board type what the DigiMacro app wrote?

Imports the simulated board over USB/IP (as Linux's vhci-hcd would: the
descriptors, SET_CONFIGURATION, SET_IDLE, then interrupt INs on the
keyboard's endpoint), taps the pad (its FIFO: a "." tap), and reads the
keystrokes the board types. Macro "." is "hello{totp #1}": "hello", then
the six-digit TOTP code of RFC 6238's SHA-1 seed for the board's time,
which the app set to GapKeep's (the log: "the board's clock set to T").
The board's clock has run since, in real time: any step from T to T plus
the seconds since the scenario started is accepted (a chance of about one
in 10^5 of a wrong code passing).

    check_board.py <host> <port> <pad fifo> <serial.log> <scenario start, unix s>

SPDX-License-Identifier: GPL-3.0-or-later
"""
import hashlib
import hmac
import re
import socket
import struct
import sys
import time

HOST, PORT, PAD, LOG, START = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], int(sys.argv[5])
SEED = b'12345678901234567890'          # RFC 6238's SHA-1 seed: the QR code of the scenario
seq = 0


def recv(s, n):
    b = b''
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise EOFError('the board went away')
        b += c
    return b


def submit(s, ep, dirin, setup=bytes(8), data=b'', length=None, interval=0):
    global seq
    seq += 1
    length = len(data) if length is None else length
    s.sendall(struct.pack('>IIIII', 1, seq, 1 << 16 | 1, 1 if dirin else 0, ep)
              + struct.pack('>IiiiI', 0, length, 0, 0, interval) + setup + (b'' if dirin else data))
    return seq


def reply(s, dirin_of):
    h = recv(s, 48)
    cmd, sq = struct.unpack('>II', h[:8])
    status, actual = struct.unpack('>ii', h[20:28])
    body = recv(s, actual) if cmd == 3 and dirin_of(sq) and actual > 0 else b''
    return cmd, sq, status, body


def control(s, rtype, req, value, index, length, data=b''):
    sq = submit(s, 0, bool(rtype & 0x80), struct.pack('<BBHHH', rtype, req, value, index, length), data, length)
    cmd, rsq, status, body = reply(s, lambda q: bool(rtype & 0x80))
    assert cmd == 3 and rsq == sq, (cmd, rsq, sq)
    return status, body


def connect():
    for _ in range(40):         # offered again once the simulator let it go
        s = socket.create_connection((HOST, PORT))
        s.sendall(struct.pack('>HHI', 0x0111, 0x8003, 0) + b'softusb-1'.ljust(32, b'\0'))
        if struct.unpack('>I', recv(s, 8)[4:8])[0] == 0:
            dev = recv(s, 312)
            assert struct.unpack('>HH', dev[300:304]) == (0x16c0, 0x27db), 'not a DigiMacro'
            return s
        s.close()
        time.sleep(0.25)
    sys.exit('check_board: the board is not offered')


def code_at(t):
    mac = hmac.new(SEED, struct.pack('>Q', t // 30), hashlib.sha1).digest()
    off = mac[-1] & 15
    return '%06d' % ((struct.unpack('>I', mac[off:off + 4])[0] & 0x7fffffff) % 1000000)


KEYS = {0x28: '\n', 0x2b: '\t', 0x2c: ' ', 0x2d: '-'}


def char(usage, mods):
    if 0x04 <= usage <= 0x1d:
        c = chr(ord('a') + usage - 4)
        return c.upper() if mods & 0x22 else c
    if 0x1e <= usage <= 0x27:
        return '1234567890'[usage - 0x1e]
    return KEYS.get(usage, '<%02x>' % usage)


def main():
    found = re.findall(r"digimacro: the board's clock set to (\d+)", open(LOG, errors='replace').read())
    if not found:
        sys.exit("check_board: the log does not say the board's clock was set")
    t0 = int(found[-1])
    s = connect()
    st, d = control(s, 0x80, 6, 0x0100, 0, 18)
    st, d = control(s, 0x80, 6, 0x0200, 0, 9)
    st, cfg = control(s, 0x80, 6, 0x0200, 0, d[2] | d[3] << 8)
    st, _ = control(s, 0x00, 9, cfg[5], 0, 0)
    assert st == 0, 'SET_CONFIGURATION'
    control(s, 0x21, 0x0a, 0, 0, 0)                     # SET_IDLE
    ins = set()
    ins.add(submit(s, 1, True, length=8, interval=10))
    with open(PAD, 'w') as f:
        f.write('.\n')                                  # a tap: macro "."
    typed, down, tapped = '', b'', time.time()
    last = None                 # the last keystroke: the tap's code ends after a pause
    s.settimeout(0.5)
    while (time.time() - tapped < 15 if last is None else time.time() - last < 3) and time.time() - START < 600:
        try:
            cmd, sq, status, rep = reply(s, lambda q: q in ins)
        except socket.timeout:
            continue
        ins.discard(sq)
        if cmd == 3 and status == 0 and len(rep) >= 6 and rep[0] == 1:
            keys = rep[3:]
            for k in keys:
                if k and k not in down:
                    typed += char(k, rep[1])
                    last = time.time()
            down = keys
        ins.add(submit(s, 1, True, length=8, interval=10))
    s.close()
    elapsed = int(time.time()) - START + 1
    candidates = {code_at(t) for t in range(t0, t0 + elapsed + 1, 15)} | {code_at(t0 + elapsed)}
    print('check_board: the board typed %d characters: "hello" and %d more' % (len(typed), len(typed) - 5))
    ok = typed.startswith('hello') and typed[5:] in candidates
    print('check_board: %s (the board\'s clock set to %d, %d s ago at most: %d candidate steps)'
          % ('the TOTP code is right' if ok else 'WRONG: not hello and the code', t0, elapsed, len(candidates)))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
