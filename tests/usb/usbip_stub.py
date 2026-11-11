#!/usr/bin/env python3
"""
A USB/IP server offering one fake USB device, for gk:usb's tests on the
simulator (sim/src/usbip.cpp is the client; tests/usb.txt the scenario).

The device, 1209:0001 (pid.codes' test id), full speed:
  interface 0  HID boot keyboard, with a feature report (id 1, 32 bytes):
               it must not become a keyboard while claimed
  interface 1  vendor class, no endpoints
Control requests on endpoint 0:
  standard     GET_DESCRIPTOR (device, configuration, strings 0-3, the HID
               report descriptor), GET_STATUS, SET_CONFIGURATION
  HID class    SET_IDLE; SET_REPORT and GET_REPORT, feature report 1: what
               was set (the id and 32 bytes) comes back
  vendor       IN 0x01: "GK" and a 16-bit count of the requests so far
               0x02: stalls
               0x03: never answered (until the client unlinks it)
               IN 0x04: answers with 8 bytes more than asked for
               OUT 0x05: keeps the data; IN 0x06 gives it back

Usage: usbip_stub.py [--port N] [--busid ID]
  Prints "usbip_stub: listening on <port>" (with --port 0, the port the
  system chose) and serves until stdin closes. Lines on stdin:
    unplug     drops the connection (the device is unplugged) and offers
               it again 0.5 s later, as a device plugged back in
    quit       exits
One client at a time, as a real server: while one has the device, the list
is empty and imports are refused. The log (stderr) has each request.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import select
import socket
import struct
import sys
import time

VID, PID = 0x1209, 0x0001
STRINGS = {1: 'GapKeep tests', 2: 'USB test device', 3: 'TEST-0001'}
EPIPE, ECONNRESET = -32, -104

HID_REPORT = bytes([
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01,          # Generic Desktop, Keyboard, Collection
    0x85, 0x01,                                  # Report ID 1
    0x06, 0x00, 0xFF, 0x09, 0x01,                # vendor page, usage 1
    0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x20,
    0xB1, 0x02,                                  # Feature, 32 bytes
    0xC0])

DEVICE = struct.pack('<BBHBBBBHHHBBBB', 18, 1, 0x0200, 0, 0, 0, 64, VID, PID, 0x0100, 1, 2, 3, 1)
INTERFACES = (
    struct.pack('<BBBBBBBBB', 9, 4, 0, 0, 1, 3, 1, 1, 0)       # HID, boot, keyboard
    + struct.pack('<BBHBBBH', 9, 0x21, 0x0111, 0, 1, 0x22, len(HID_REPORT))
    + struct.pack('<BBBBHB', 7, 5, 0x81, 3, 8, 10)              # interrupt IN
    + struct.pack('<BBBBBBBBB', 9, 4, 1, 0, 0, 0xFF, 0, 0, 0))  # vendor
CONFIG = struct.pack('<BBHBBBBB', 9, 2, 9 + len(INTERFACES), 2, 1, 0, 0x80, 50) + INTERFACES


def log(*a):
    print('usbip_stub:', *a, file=sys.stderr, flush=True)


def string_desc(i):
    if i == 0:
        return bytes([4, 3, 0x09, 0x04])
    s = STRINGS[i].encode('utf-16-le')
    return bytes([2 + len(s), 3]) + s


class Device:
    def __init__(self):
        self.feature = bytes([1]) + bytes(32)
        self.vendor = b''
        self.count = 0

    def control(self, setup, data):
        """(status, data) or None: no answer"""
        rtype, req, value, index, length = struct.unpack('<BBHHH', setup)
        self.count += 1
        kind = rtype & 0x60
        if kind == 0:
            if req == 6:
                dtype, di = value >> 8, value & 0xFF
                if dtype == 1:
                    return 0, DEVICE[:length]
                if dtype == 2:
                    return 0, CONFIG[:length]
                if dtype == 3 and (di == 0 or di in STRINGS):
                    return 0, string_desc(di)[:length]
                if dtype == 0x22 and index == 0:
                    return 0, HID_REPORT[:length]
                return EPIPE, b''
            if req == 0:
                return 0, b'\0\0'[:length]
            if req == 9:
                return 0, b''
            return EPIPE, b''
        if kind == 0x20:
            if req == 0x0A:                              # SET_IDLE
                return 0, b''
            if value == 0x0301 and req == 0x09:          # SET_REPORT, feature 1
                if len(data) != 33 or data[0] != 1:
                    return EPIPE, b''
                self.feature = bytes(data)
                return 0, b''
            if value == 0x0301 and req == 0x01:          # GET_REPORT, feature 1
                return 0, self.feature[:length]
            return EPIPE, b''
        if kind == 0x40:
            if req == 0x01:
                return 0, (b'GK' + struct.pack('<H', self.count & 0xFFFF))[:length]
            if req == 0x02:
                return EPIPE, b''
            if req == 0x03:
                return None
            if req == 0x04:
                return 0, bytes(range(length + 8))
            if req == 0x05:
                self.vendor = bytes(data)
                return 0, b''
            if req == 0x06:
                return 0, self.vendor[:length]
        return EPIPE, b''


def device_record(busid):
    path = ('/sys/devices/stub/' + busid).encode().ljust(256, b'\0')
    return (path + busid.encode().ljust(32, b'\0')
            + struct.pack('>IIIHHHBBBBBB', 1, 2, 2, VID, PID, 0x0100, 0, 0, 0, 1, 1, 2))


def recv_all(conn, n):
    b = b''
    while len(b) < n:
        c = conn.recv(n - len(b))
        if not c:
            raise EOFError
        b += c
    return b


def serve(args):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', args.port))
    srv.listen(4)
    print('usbip_stub: listening on %d' % srv.getsockname()[1], flush=True)

    dev = Device()
    client = None           # the connection that imported the device
    offered_at = 0.0        # not offered before this time (after an unplug)
    stdin = sys.stdin
    while True:
        socks = [srv, stdin] + ([client] if client else [])
        ready, _, _ = select.select(socks, [], [], 0.5)
        if stdin in ready:
            line = stdin.readline()
            if not line or line.strip() == 'quit':
                return
            if line.strip() == 'unplug' and client:
                log('unplugged')
                client.close()
                client = None
                offered_at = time.time() + 0.5
        if srv in ready:
            conn, _ = srv.accept()
            try:
                h = recv_all(conn, 8)
                version, code, _ = struct.unpack('>HHI', h)
                offered = client is None and time.time() >= offered_at
                if code == 0x8005:                       # devlist
                    conn.sendall(struct.pack('>HHII', 0x0111, 5, 0, 1 if offered else 0)
                                 + (device_record(args.busid)
                                    + bytes([3, 1, 1, 0, 0xFF, 0, 0, 0]) if offered else b''))
                    conn.close()
                elif code == 0x8003:                     # import
                    busid = recv_all(conn, 32).rstrip(b'\0').decode()
                    if not offered or busid != args.busid:
                        log('import of %r refused' % busid)
                        conn.sendall(struct.pack('>HHI', 0x0111, 3, 1))
                        conn.close()
                    else:
                        log('imported')
                        conn.sendall(struct.pack('>HHI', 0x0111, 3, 0) + device_record(args.busid))
                        client = conn
                        dev = Device()
                else:
                    conn.close()
            except (EOFError, OSError):
                conn.close()
        if client and client in ready:
            try:
                urb(client, dev)
            except (EOFError, OSError):
                log('the client left')
                client.close()
                client = None


pending = {}        # seqnum -> (direction) of transfers never answered


def urb(conn, dev):
    h = recv_all(conn, 48)
    cmd, seq, devid, direction, ep = struct.unpack('>IIIII', h[:20])
    if cmd == 2:                                         # CMD_UNLINK
        victim = struct.unpack('>I', h[20:24])[0]
        status = ECONNRESET if pending.pop(victim, None) is not None else 0
        log('unlink of %d: %d' % (victim, status))
        conn.sendall(struct.pack('>IIIIIii', 4, seq, devid, 0, 0, status, 0) + bytes(20))
        return
    if cmd != 1:
        raise EOFError
    length = struct.unpack('>i', h[24:28])[0]
    setup = h[40:48]
    data = recv_all(conn, length) if direction == 0 and length > 0 else b''
    if ep != 0:
        conn.sendall(struct.pack('>IIIIIii', 3, seq, devid, 0, 0, EPIPE, 0) + bytes(20))
        return
    log('setup %s, %d bytes out' % (setup.hex(), len(data)))
    answer = dev.control(setup, data)
    if answer is None:
        pending[seq] = direction
        return
    status, body = answer
    if direction == 0:
        actual, body = (len(data) if status == 0 else 0), b''
    else:
        actual = len(body)
    conn.sendall(struct.pack('>IIIIIii', 3, seq, devid, 0, 0, status, actual)
                 + bytes(20) + body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--busid', default='stub-1')
    try:
        serve(ap.parse_args())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
