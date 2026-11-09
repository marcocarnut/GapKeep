#!/usr/bin/env python3
"""
GapKeep hardware rig: runs on the Raspberry Pi wired to the Pi Zero.

Wiring (see docs/RIG.md): Zero's UART on /dev/ttyAMA0, Zero's RUN pad on
GPIO17 (pulled low to reset, otherwise left floating).

  gkrig.py reset                       reset the Zero (into the bootloader)
  gkrig.py flash kernel.hex [--log N]  reset, load a kernel, run it, log N s
  gkrig.py log [N] [--until REGEX]     print serial output
  gkrig.py shot out.png                screenshot (test builds only)
  gkrig.py run kernel.hex scenario.txt [--out DIR]
                                       flash, then play a QEMU harness
                                       scenario (tests/*.txt) on the Zero
  gkrig.py peek [kernel.hex]           the Pi Camera's grey frames, one after
                                       another, as PGM on stdout: with a kernel,
                                       flash it and open the scanner first;
                                       without, one is running. For camview.py

Keyboard and mouse come from this machine's USB gadget (gadget.sh up):
/dev/hidg0 and /dev/hidg1.

Kernels from "make kernel.hex" in src/. The SD card holds Circle's serial
bootloader (tools/make_sdcard.sh).
"""
import argparse
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serialshot  # noqa: E402  (copied next to this file)
import qemu_harness  # noqa: E402  (scenario runner and key names)

PORT = '/dev/ttyAMA0'
BAUD = 921600
RESET_GPIO = '17'


def open_port():
    import serial
    return serial.Serial(PORT, BAUD, timeout=0)


def reset():
    subprocess.run(['pinctrl', 'set', RESET_GPIO, 'op', 'dl'], check=True)
    time.sleep(0.1)
    subprocess.run(['pinctrl', 'set', RESET_GPIO, 'ip', 'pn'], check=True)


def read_until(port, pattern, timeout, echo=False):
    """Reads until pattern (bytes regex) matches; returns everything read."""
    buf = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = port.read(65536)
        if data:
            if echo:
                sys.stdout.write(data.decode('utf-8', 'replace'))
                sys.stdout.flush()
            buf += data
            if pattern is not None and re.search(pattern, buf, re.M):
                return buf
        else:
            time.sleep(0.02)
    if pattern is not None:
        raise TimeoutError('no %r within %d s' % (pattern, timeout))
    return buf


def hex_to_binary(text):
    """Intel HEX -> the bootloader's binary records: '=' followed by the
    record's bytes (count, address, type, data, checksum) unencoded. Same
    records, half the bytes on the wire."""
    out = bytearray()
    for line in text.split():
        if not line.startswith(b':'):
            raise ValueError('not an Intel HEX file')
        out += b'=' + bytes.fromhex(line[1:].decode())
    return bytes(out)


def flash(port, hexfile):
    data = hex_to_binary(open(hexfile, 'rb').read())
    port.reset_input_buffer()
    reset()
    read_until(port, rb'IHEX-F', 10)
    # Noise on the line during reset can leave the bootloader in its error
    # state, which ignores everything until 'R' (restart). 0x80 is ignored.
    time.sleep(0.05)
    port.write(b'\x80R')
    read_until(port, rb'IHEX-F\r\n', 5)
    port.reset_input_buffer()
    t = time.time()
    port.write(data)
    port.flush()
    answer = read_until(port, rb'#EOF:ok|#ERR:\w+', 30 + len(data) * 10 / BAUD)
    if b'#ERR' in answer:
        raise RuntimeError('the bootloader refused the kernel: %s' % re.search(rb'#ERR:\w+', answer).group().decode())
    print('gkrig: %d KB loaded in %.1f s' % (len(data) // 1024, time.time() - t), file=sys.stderr)
    # 'g' starts the kernel. One lost byte would leave the Zero waiting and
    # the log empty (seen about 1 boot in 8): if nothing comes back, send it
    # again. Only peeks (in_waiting), so the kernel's first lines stay for
    # the caller to read.
    for attempt in range(3):
        time.sleep(0.1)
        port.write(b'g')
        port.flush()
        deadline = time.time() + 3
        while time.time() < deadline and port.in_waiting == 0:
            time.sleep(0.02)
        if port.in_waiting:
            return
        print('gkrig: no answer to "g", sending it again', file=sys.stderr)
    raise TimeoutError('the kernel did not start after 3 tries')


# USB HID usage IDs for QEMU's sendkey names (as used in scenarios)
HID_KEYS = {'ret': 40, 'esc': 41, 'backspace': 42, 'tab': 43, 'spc': 44,
            'minus': 45, 'equal': 46, 'bracket_left': 47, 'bracket_right': 48,
            'backslash': 49, 'semicolon': 51, 'apostrophe': 52, 'grave_accent': 53,
            'comma': 54, 'dot': 55, 'slash': 56, 'insert': 73, 'home': 74,
            'pgup': 75, 'delete': 76, 'end': 77, 'pgdn': 78,
            'right': 79, 'left': 80, 'down': 81, 'up': 82,
            # ABNT2's extra keys: "less" (\ | left of Z) and "ro" (/ ?, left
            # of right Shift). Beyond the gadget's declared range (0x65), but
            # Circle reads boot-protocol reports as bytes.
            'less': 100, 'ro': 135}
HID_KEYS.update({chr(ord('a') + i): 4 + i for i in range(26)})
HID_KEYS.update({str(i): 30 + (i - 1) for i in range(1, 10)})
HID_KEYS['0'] = 39
HID_KEYS.update({'f%d' % i: 57 + i for i in range(1, 13)})
HID_MODS = {'ctrl': 0x01, 'shift': 0x02, 'alt': 0x04, 'meta_l': 0x08,
            'ctrl_r': 0x10, 'shift_r': 0x20, 'alt_r': 0x40, 'meta_r': 0x80}


class RigMachine:
    """The Pi Zero, driven like qemu_harness.Machine: same methods, so
    qemu_harness.run_scenario() plays scenarios on real hardware."""

    def __init__(self, port, hexfile):
        import threading
        self.port = port
        self.hexfile = hexfile
        self.rx = bytearray()
        self.lock = threading.Lock()
        self.kbd = open('/dev/hidg0', 'wb', buffering=0)
        self.mouse_dev = open('/dev/hidg1', 'wb', buffering=0)
        self.buttons = 0
        self.mark = 0			# expect() looks at the log from here on
        self.pause = threading.Event()	# set: the reader leaves the port alone
        self.paused = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            if self.pause.is_set():
                self.paused.set()
                time.sleep(0.01)
                continue
            self.paused.clear()
            data = self.port.read(65536)
            if data:
                with self.lock:
                    self.rx += data
            else:
                time.sleep(0.01)

    def serial(self):
        with self.lock:
            return bytes(self.rx).decode('utf-8', 'replace').replace('\r', '')

    def expect(self, pattern, timeout=30.0):
        rx = re.compile(pattern, re.M)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if rx.search(self.serial()[self.mark:]):
                return True
            time.sleep(0.1)
        return False

    def send(self, line):
        # Test builds read the UART by polling its 16-byte FIFO from the main
        # loop, which can stall for a few hundred ms (a QR decode on the
        # Zero): longer lines would overflow it. Send them in pieces, with
        # pauses longer than such a stall.
        data = (line + '\n').encode()
        for i in range(0, len(data), 12):
            if i:
                time.sleep(0.6)
            self.port.write(data[i:i + 12])

    def reset(self):
        """Reset the Zero and upload the kernel again (the bootloader on its
        card waits for one)."""
        self.mark = len(self.serial())
        self.pause.set()
        self.paused.wait(5)
        try:
            flash(self.port, self.hexfile)
        finally:
            self.pause.clear()

    def key(self, name, hold_ms=60):
        mods, code = 0, 0
        for part in name.split('-'):
            if part in HID_MODS:
                mods |= HID_MODS[part]
            elif part in HID_KEYS:
                code = HID_KEYS[part]
            else:
                raise ValueError('unknown key %r' % name)
        self.kbd.write(bytes([mods, 0, code, 0, 0, 0, 0, 0]))
        time.sleep(hold_ms / 1000)
        self.kbd.write(bytes(8))
        time.sleep(0.12)

    def type(self, text):
        for c in text:
            self.key(qemu_harness.char_to_key(c))

    def _move(self, dx, dy):
        self.mouse_dev.write(bytes([self.buttons, dx & 0xff, dy & 0xff]))
        time.sleep(0.012)

    def mouse(self, dx, dy):
        steps = max(1, int(max(abs(dx), abs(dy)) / 10))
        for i in range(steps):
            self._move(dx * (i + 1) // steps - dx * i // steps,
                       dy * (i + 1) // steps - dy * i // steps)

    def moveto(self, x, y):
        # same edge pinning as qemu_harness.Machine.moveto (Circle scales
        # moves by 1.8 and drops those that would leave the screen)
        for step, count in ((100, 12), (10, 12), (1, 20)):
            for _ in range(count):
                self._move(-step, -step)
        xs = qemu_harness.Machine._axis_steps(None, x)
        ys = qemu_harness.Machine._axis_steps(None, y)
        for i in range(max(len(xs), len(ys))):
            self._move(xs[i] if i < len(xs) else 0, ys[i] if i < len(ys) else 0)
        time.sleep(0.1)

    def click(self, button='left'):
        self.mousedown(button)
        self.mouseup()

    def mousedown(self, button='left'):
        self.buttons = {'left': 1, 'right': 2, 'middle': 4}[button]
        self._move(0, 0)
        time.sleep(0.15)

    def mouseup(self):
        self.buttons = 0
        self._move(0, 0)
        time.sleep(0.15)

    def serialshot(self, png_path):
        with self.lock:
            pos = len(self.rx)

        def read():
            nonlocal pos
            with self.lock:
                data = bytes(self.rx[pos:])
                pos = len(self.rx)
            return data
        serialshot.capture(read, self.port.write, timeout=60).save(png_path)
        return png_path

    shot = serialshot	# no other way to see the screen on the rig

    def grey(self):
        """The running Pi Camera's last grey frame: (info, payload)."""
        with self.lock:
            del self.rx[:]		# frames add up, and nothing reads them
        pos = 0

        def read():
            nonlocal pos
            with self.lock:
                data = bytes(self.rx[pos:])
                pos = len(self.rx)
            return data
        return serialshot.capture_raw(read, self.port.write, timeout=15, command=b'#camera grey')

    def serialraw(self, path):
        """The running Pi Camera's next raw frame: path (.raw) and path.json."""
        import json
        with self.lock:
            pos = len(self.rx)

        def read():
            nonlocal pos
            with self.lock:
                data = bytes(self.rx[pos:])
                pos = len(self.rx)
            return data
        info, payload = serialshot.capture_raw(read, self.port.write, timeout=60)
        with open(path, 'wb') as f:
            f.write(payload)
        with open(path + '.json', 'w') as f:
            json.dump(info, f, indent=1)
        return path


def peek(port, hexfile):
    """PGM frames on stdout until the reader goes away; all else on stderr."""
    out = sys.stdout.buffer
    sys.stdout = sys.stderr
    if hexfile:
        flash(port, hexfile)
    m = RigMachine(port, hexfile)
    if hexfile:
        here = os.path.dirname(os.path.abspath(__file__))
        if qemu_harness.run_scenario(m, os.path.join(here, 'peek.txt'), '/tmp'):
            print(m.serial()[-2000:])
            sys.exit('gkrig: the camera did not start')
    while True:
        try:
            info, grey = m.grey()
        except serialshot.ShotError as e:	# a log line in the frame: the next one
            print('gkrig: %s' % e)
            continue
        try:
            out.write(b'P5\n%d %d\n255\n' % (info['width'], info['height']) + grey)
            out.flush()
        except BrokenPipeError:
            return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('reset')
    p = sub.add_parser('flash')
    p.add_argument('hexfile')
    p.add_argument('--log', type=float, default=0, help='then print serial output for N s')
    p.add_argument('--until', help='... or until this regex appears')
    p = sub.add_parser('log')
    p.add_argument('seconds', type=float, nargs='?', default=5)
    p.add_argument('--until')
    p = sub.add_parser('shot')
    p.add_argument('out')
    p = sub.add_parser('run')
    p.add_argument('hexfile')
    p.add_argument('scenario')
    p.add_argument('--out', default='rig-out')
    p = sub.add_parser('peek')
    p.add_argument('hexfile', nargs='?')
    args = ap.parse_args()

    if args.cmd == 'reset':
        reset()
        return
    with open_port() as port:
        if args.cmd == 'flash':
            flash(port, args.hexfile)
            if args.log or args.until:
                until = args.until.encode() if args.until else None
                read_until(port, until, args.log or 60, echo=True)
        elif args.cmd == 'log':
            until = args.until.encode() if args.until else None
            read_until(port, until, args.seconds, echo=True)
        elif args.cmd == 'shot':
            port.reset_input_buffer()
            image = serialshot.capture(lambda: port.read(65536), port.write, timeout=60)
            image.save(args.out)
            print('%s: %dx%d' % (args.out, image.width, image.height))
        elif args.cmd == 'peek':
            peek(port, args.hexfile)
        elif args.cmd == 'run':
            os.makedirs(args.out, exist_ok=True)
            flash(port, args.hexfile)
            m = RigMachine(port, args.hexfile)
            failures = qemu_harness.run_scenario(m, args.scenario, args.out)
            log = m.serial()
            open(os.path.join(args.out, 'serial.log'), 'w').write(log)
            print('--- serial log ---')
            print(re.sub(r'\nZGSHOT1 .*?\nZGEND\n', '\n[screenshot]\n', log, flags=re.S))
            print('RESULT: %s' % ('PASS' if failures == 0 else 'FAIL'))
            sys.exit(1 if failures else 0)


if __name__ == '__main__':
    try:
        main()
    except (TimeoutError, serialshot.ShotError) as e:
        sys.exit('gkrig: %s' % e)
