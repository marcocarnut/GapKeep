#!/usr/bin/env python3
"""
Screenshots over the serial line from a GapKeep test build (make TEST=1).

Sends "#shot\\n" and decodes the kernel's answer (see src/testshot.h) into a
PNG. Used on the hardware rig against the Pi Zero's UART, and by
qemu_harness.py ("serialshot" command) against QEMU's serial port.

Usage: serialshot.py [--port /dev/ttyAMA0] [--baud 921600] out.png

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import re
import sys
import time
import zlib

HEADER = re.compile(rb'\nZGSHOT1 (\d+) (\d+) (\d+) (\d+) ([0-9a-f]{8})\n')
TRAILER = b'\nZGEND\n'


class ShotError(Exception):
    pass


def parse(buf):
    """Finds a complete screenshot in buf. Returns (image, rest) or None if
    more data is needed. image is a PIL.Image."""
    m = HEADER.search(buf)
    if not m:
        return None
    width, height, bpp, length = (int(m.group(i)) for i in range(1, 5))
    crc = int(m.group(5), 16)
    start = m.end()
    if len(buf) < start + length + len(TRAILER):
        return None
    payload = buf[start:start + length]
    if buf[start + length:start + length + len(TRAILER)] != TRAILER:
        raise ShotError('missing trailer (data lost on the line?)')
    if zlib.crc32(payload) != crc:
        raise ShotError('CRC mismatch (data corrupted on the line?)')
    return decode(width, height, bpp, payload), buf[start + length + len(TRAILER):]


def decode(width, height, bpp, payload):
    from PIL import Image
    nbytes = bpp // 8
    pixels = bytearray()
    i = 0
    while i < len(payload):
        count = payload[i] | payload[i + 1] << 8
        value = int.from_bytes(payload[i + 2:i + 2 + nbytes], 'little')
        i += 2 + nbytes
        if bpp == 16:   # RGB565
            rgb = bytes((((value >> 11) & 31) * 255 // 31, ((value >> 5) & 63) * 255 // 63,
                         (value & 31) * 255 // 31))
        elif bpp == 32:  # XRGB8888
            rgb = bytes(((value >> 16) & 255, (value >> 8) & 255, value & 255))
        else:
            raise ShotError('unsupported depth %d' % bpp)
        pixels += rgb * count
    if len(pixels) != width * height * 3:
        raise ShotError('decoded %d pixels, expected %d' % (len(pixels) // 3, width * height))
    return Image.frombytes('RGB', (width, height), bytes(pixels))


RAW_HEADER = re.compile(rb'\nZGRAW1 (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) ([0-9a-f]{8})\n')


def parse_raw(buf):
    """Finds a complete raw camera frame ("#camera raw", src/testshot.h) in
    buf. Returns (info, payload) or None if more data is needed."""
    m = RAW_HEADER.search(buf)
    if not m:
        return None
    width, height, stride, exposure, analogue, digital, length = (int(m.group(i)) for i in range(1, 8))
    start = m.end()
    if len(buf) < start + length + len(TRAILER):
        return None
    payload = buf[start:start + length]
    if buf[start + length:start + length + len(TRAILER)] != TRAILER:
        raise ShotError('missing trailer (data lost on the line?)')
    if zlib.crc32(payload) != int(m.group(8), 16):
        raise ShotError('CRC mismatch (data corrupted on the line?)')
    info = {'format': 'RAW8 Bayer, 1 byte a pixel, rows of stride bytes',
            'width': width, 'height': height, 'stride': stride,
            'exposure_lines': exposure, 'analogue_gain_code': analogue, 'digital_gain_4.8': digital}
    return info, payload


def capture_raw(read, write, timeout=120.0, command=b'#camera raw'):
    """Asks for the next raw frame of the running Pi Camera, or with
    command=b'#camera grey' its last grey one. Returns (info, payload)."""
    write(b'\n' + command + b'\n')
    buf = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        buf += read()
        r = parse_raw(buf)
        if r:
            return r
        time.sleep(0.05)
    raise ShotError('no raw frame within %d s' % timeout)


def capture(read, write, timeout=120.0):
    """Generic capture: write(bytes) sends, read() returns new bytes (possibly
    empty). Returns a PIL.Image."""
    write(b'\n#shot\n')
    buf = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        buf += read()
        r = parse(buf)
        if r:
            return r[0]
        time.sleep(0.05)
    raise ShotError('no screenshot within %d s' % timeout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', default='/dev/ttyAMA0')
    ap.add_argument('--baud', type=int, default=921600)
    ap.add_argument('out')
    args = ap.parse_args()

    import serial
    with serial.Serial(args.port, args.baud, timeout=0) as port:
        port.reset_input_buffer()
        image = capture(lambda: port.read(65536), port.write)
    image.save(args.out)
    print('%s: %dx%d' % (args.out, image.width, image.height))


if __name__ == '__main__':
    try:
        main()
    except ShotError as e:
        sys.exit('serialshot: ' + str(e))
