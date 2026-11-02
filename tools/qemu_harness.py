#!/usr/bin/env python3
"""
Scripted QEMU runner for zerogap.

Boots a kernel image on QEMU's raspi0 machine (the Pi Zero emulation) with a
USB keyboard and mouse attached, then plays a scenario against it: type text,
press keys, move and click the mouse, take screenshots, and wait for lines
to appear on the serial log. Exits non-zero if an expectation fails, so it can
serve as an automated test.

Scenario file: one command per line, '#' starts a comment.

    wait <seconds>              sleep
    expect <regex> [timeout]    wait until the serial log matches (default 30 s)
    type <text>                 type text (rest of line, verbatim)
    key <qemu-key> [...]        press keys, e.g. "key tab", "key ret", "key ctrl-a"
    mouse <dx> <dy>             relative mouse move, split into small steps
    moveto <x> <y>              move to the top-left corner, then by (x, y)
    click [left|right]          press and release a mouse button
    shot <name>                 save a screenshot as <outdir>/<name>.png
    serialshot <name>           same, but fetched over the serial line from a
                                test build (as on real hardware)

Usage:
    qemu_harness.py [--kernel K] [--out DIR] [--keep] scenario.txt
    qemu_harness.py --kernel K --interactive     # just boot, print serial, Ctrl-C to stop
"""

import argparse
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

KEYNAMES = {
    ' ': 'spc', '\t': 'tab', '\n': 'ret',
    '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
    ';': 'semicolon', "'": 'apostrophe', '`': 'grave_accent', '\\': 'backslash',
    ',': 'comma', '.': 'dot', '/': 'slash',
}
SHIFTED = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
    '*': '8', '(': '9', ')': '0', '_': 'minus', '+': 'equal', '{': 'bracket_left',
    '}': 'bracket_right', ':': 'semicolon', '"': 'apostrophe', '~': 'grave_accent',
    '|': 'backslash', '<': 'comma', '>': 'dot', '?': 'slash',
}


def char_to_key(c):
    if c.isalpha() and c.isascii():
        return ('shift-' + c.lower()) if c.isupper() else c
    if c.isdigit():
        return c
    if c in KEYNAMES:
        return KEYNAMES[c]
    if c in SHIFTED:
        return 'shift-' + KEYNAMES.get(SHIFTED[c], SHIFTED[c])
    raise ValueError('cannot type character %r' % c)


class Machine:
    def __init__(self, kernel, workdir, extra_args=()):
        self.workdir = workdir
        workdir = os.path.abspath(workdir)
        self.serial_path = os.path.join(workdir, 'serial.log')
        self.mon_path = os.path.join(workdir, 'monitor.sock')
        cmd = [
            'qemu-system-arm', '-M', 'raspi0', '-bios', os.path.abspath(kernel),
            '-display', 'none',
            # serial on a socket (for "serialshot"), everything also logged
            '-chardev', 'socket,id=ser0,path=serial.sock,server=on,wait=off,logfile=serial.log',
            '-serial', 'chardev:ser0',
            '-device', 'usb-kbd', '-device', 'usb-mouse',
            # relative socket path: AF_UNIX paths are limited to ~108 bytes
            '-monitor', 'unix:monitor.sock,server,nowait',
            *extra_args,
        ]
        self.proc = subprocess.Popen(cmd, cwd=workdir, stdout=subprocess.DEVNULL,
                                     stderr=open(os.path.join(workdir, 'qemu.stderr'), 'w'))
        for _ in range(100):
            if os.path.exists(self.mon_path):
                break
            time.sleep(0.05)
        self.mon = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        cwd = os.getcwd()
        os.chdir(workdir)
        try:
            self.mon.connect('monitor.sock')
        finally:
            os.chdir(cwd)
        self.mon.settimeout(2)
        self._drain()

        # keep the serial socket drained, or the guest would block on output
        import threading
        self.rx = bytearray()
        self.rx_lock = threading.Lock()
        self.ser = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        for _ in range(100):
            try:
                cwd = os.getcwd()
                os.chdir(workdir)
                try:
                    self.ser.connect('serial.sock')
                finally:
                    os.chdir(cwd)
                break
            except OSError:
                time.sleep(0.05)
        threading.Thread(target=self._serial_reader, daemon=True).start()

    def _serial_reader(self):
        while True:
            try:
                data = self.ser.recv(65536)
            except OSError:
                return
            if not data:
                return
            with self.rx_lock:
                self.rx += data

    def serialshot(self, png_path):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import serialshot
        with self.rx_lock:
            pos = len(self.rx)

        def read():
            nonlocal pos
            with self.rx_lock:
                data = bytes(self.rx[pos:])
                pos = len(self.rx)
            return data
        image = serialshot.capture(read, self.ser.sendall, timeout=60)
        image.save(png_path)
        return png_path

    def _drain(self):
        try:
            while self.mon.recv(65536):
                pass
        except socket.timeout:
            pass

    def monitor(self, line, delay=0.02):
        self.mon.sendall((line + '\n').encode())
        time.sleep(delay)

    def serial(self):
        try:
            with open(self.serial_path, 'r', errors='replace') as f:
                return f.read().replace('\r', '')
        except FileNotFoundError:
            return ''

    def key(self, name, hold_ms=60):
        self.monitor('sendkey %s %d' % (name, hold_ms))
        # USB HID is polled; give the guest time to see press and release
        time.sleep(0.12)

    def type(self, text):
        for c in text:
            self.key(char_to_key(c))

    def mouse(self, dx, dy):
        # QEMU's USB mouse is relative; big jumps get clamped/accelerated,
        # so move in small steps.
        steps = max(1, int(max(abs(dx), abs(dy)) / 10))
        for i in range(steps):
            sx = dx * (i + 1) // steps - dx * i // steps
            sy = dy * (i + 1) // steps - dy * i // steps
            self.monitor('mouse_move %d %d' % (sx, sy))
            time.sleep(0.03)

    # Circle's CMouseBehaviour multiplies each report by 18/10 (integer math)
    # and *drops* a move that would leave the screen instead of clamping.
    ACCEL_NUM, ACCEL_DEN = 18, 10

    def _axis_steps(self, px):
        """Split a pixel distance into HID units: 10 units = 18 px, 1 unit = 1 px."""
        sign = -1 if px < 0 else 1
        px = abs(px)
        return [sign * 10] * (px // 18) + [sign] * (px % 18)

    def moveto(self, x, y):
        # Pin to the top-left corner: big steps first (180 px each), then
        # smaller ones (18 px), then single pixels. Circle drops a move that
        # would cross the edge, so the last stage lands exactly on (0, 0).
        for step, count in ((100, 12), (10, 12), (1, 20)):
            for _ in range(count):
                self.monitor('mouse_move %d %d' % (-step, -step))
        xs, ys = self._axis_steps(x), self._axis_steps(y)
        for i in range(max(len(xs), len(ys))):
            self.monitor('mouse_move %d %d' % (xs[i] if i < len(xs) else 0,
                                               ys[i] if i < len(ys) else 0))
        time.sleep(0.1)

    def click(self, button='left'):
        mask = {'left': 1, 'right': 2, 'middle': 4}[button]
        self.monitor('mouse_button %d' % mask)
        time.sleep(0.15)
        self.monitor('mouse_button 0')
        time.sleep(0.15)

    def shot(self, png_path):
        ppm = png_path[:-4] + '.ppm'
        if os.path.exists(ppm):
            os.remove(ppm)
        self.monitor('screendump %s' % ppm)
        for _ in range(50):
            if os.path.exists(ppm) and os.path.getsize(ppm) > 0:
                break
            time.sleep(0.1)
        time.sleep(0.2)
        try:
            from PIL import Image
            Image.open(ppm).save(png_path)
            os.remove(ppm)
        except ImportError:
            png_path = ppm
        return png_path

    def expect(self, pattern, timeout=30.0):
        rx = re.compile(pattern, re.M)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if rx.search(self.serial()):
                return True
            if self.proc.poll() is not None:
                return False
            time.sleep(0.1)
        return False

    def stop(self):
        try:
            self.monitor('quit')
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def run_scenario(m, path, outdir):
    failures = 0
    with open(path) as f:
        for lineno, raw in enumerate(f, 1):
            line = raw.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            cmd, _, rest = line.strip().partition(' ')
            where = '%s:%d' % (os.path.basename(path), lineno)
            if cmd == 'wait':
                time.sleep(float(rest))
            elif cmd == 'type':
                m.type(line.strip()[len('type '):])
            elif cmd == 'key':
                for k in rest.split():
                    m.key(k)
            elif cmd == 'mouse':
                dx, dy = (int(v) for v in rest.split())
                m.mouse(dx, dy)
            elif cmd == 'moveto':
                x, y = (int(v) for v in rest.split())
                m.moveto(x, y)
            elif cmd == 'click':
                m.click(rest.strip() or 'left')
            elif cmd == 'serialshot':
                p = m.serialshot(os.path.join(outdir, rest.strip() + '.png'))
                print('[%s] serial screenshot %s' % (where, p))
            elif cmd == 'shot':
                p = m.shot(os.path.join(outdir, rest.strip() + '.png'))
                print('[%s] screenshot %s' % (where, p))
            elif cmd == 'expect':
                parts = rest.rsplit(' ', 1)
                timeout = 30.0
                if len(parts) == 2 and re.fullmatch(r'\d+(\.\d+)?', parts[1]):
                    pattern, timeout = parts[0], float(parts[1])
                else:
                    pattern = rest
                ok = m.expect(pattern, timeout)
                print('[%s] expect %r: %s' % (where, pattern, 'ok' if ok else 'FAILED'))
                if not ok:
                    failures += 1
                    break
            else:
                raise SystemExit('%s: unknown command %r' % (where, cmd))
    return failures


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('scenario', nargs='?')
    ap.add_argument('--kernel', default=os.path.join(here, '..', 'src', 'kernel.img'))
    ap.add_argument('--out', default=None, help='directory for screenshots and logs')
    ap.add_argument('--interactive', action='store_true')
    ap.add_argument('--keep', action='store_true', help='leave QEMU running at the end')
    args = ap.parse_args()

    outdir = args.out or tempfile.mkdtemp(prefix='zerogap-qemu-')
    os.makedirs(outdir, exist_ok=True)
    m = Machine(args.kernel, outdir)
    failures = 0
    try:
        if args.interactive or not args.scenario:
            print('serial log: %s  (Ctrl-C to stop)' % m.serial_path)
            seen = 0
            while m.proc.poll() is None:
                s = m.serial()
                sys.stdout.write(s[seen:])
                sys.stdout.flush()
                seen = len(s)
                time.sleep(0.2)
        else:
            failures = run_scenario(m, args.scenario, outdir)
            if args.keep:
                print('QEMU still running; monitor socket %s' % m.mon_path)
                return 0
    except KeyboardInterrupt:
        pass
    finally:
        if not args.keep:
            m.stop()
    print('--- serial log (%s) ---' % m.serial_path)
    print(m.serial())
    print('RESULT: %s' % ('PASS' if failures == 0 else 'FAIL'))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
