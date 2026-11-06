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
    key <qemu-key> [...]        press keys, e.g. "key tab", "key ret", "key ctrl-a";
                                "key spc@1500" holds the key 1.5 s (auto-repeat)
    mouse <dx> <dy>             relative mouse move, split into small steps
    moveto <x> <y>              move to the top-left corner, then by (x, y);
                                "50%" is half the screen width (or height),
                                so scenarios work at any resolution
    click [left|right]          press and release a mouse button
    mousedown [left|right]      press a mouse button (moves then drag)
    mouseup                     release the mouse buttons
    shot <name>                 save a screenshot as <outdir>/<name>.png
    serialshot <name>           same, but fetched over the serial line from a
                                test build (as on real hardware)
    serialraw <name>            rig only: the Pi Camera's next raw frame
                                (RAW8 Bayer) as <outdir>/<name>.raw, with
                                its size and exposure in <name>.raw.json
    send <text>                 send a line on the serial port (test builds
                                take commands: #shot, #crash <kind>)
    tile <id>                   open that app from the launcher: moves the
                                focus to its tile (by the order in the
                                launcher's last "launcher ready: ..." log
                                line) and presses Enter. Works everywhere.
    tilefocus <id>              the same, without pressing Enter
    launch <id>                 simulator only: start that app, as the
                                launcher would
    camera qr <text>            what the camera films (test builds and the
    camera scene | none         simulator have a synthetic camera, see
                                docs/CAMERA.md): a QR code of <text>, nothing,
                                or no camera at all. The simulator also takes
                                "camera qrhex <hex>", "camera picture <file>"
                                (PGM, PPM or PNG, colour kept; relative to the
                                scenario's folder); test builds take the
                                colour codes of tests/colorqr by name
    reset                       reset the machine (on the rig: and upload
                                the kernel again); "expect" only looks at
                                what was logged after the reset

Usage:
    qemu_harness.py [--kernel K] [--sd IMG] [--out DIR] [--keep] scenario.txt
    qemu_harness.py --kernel K --interactive     # just boot, print serial, Ctrl-C to stop
    qemu_harness.py --sim sim/build/zgsim [--card DIR] [--size WxH] scenario.txt
        plays the scenario on the simulator (sim/) instead of QEMU: the same
        runtime, natively, in a fraction of the time; DIR plays the SD card
        (apps in DIR/apps). "send" and "serialshot" need a serial port, which
        the simulator doesn't have: "serialshot" takes a normal screenshot,
        "send" fails.
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
        self.cmd = [
            'qemu-system-arm', '-M', 'raspi0', '-bios', os.path.abspath(kernel),
            '-display', 'none',
            # serial on a socket (for "serialshot"), everything also logged
            # (appended: "reset" restarts QEMU)
            '-chardev', 'socket,id=ser0,path=serial.sock,server=on,wait=off,'
                        'logfile=serial.log,logappend=on',
            '-serial', 'chardev:ser0',
            '-device', 'usb-kbd', '-device', 'usb-mouse',
            # relative socket path: AF_UNIX paths are limited to ~108 bytes
            '-monitor', 'unix:monitor.sock,server,nowait',
            *extra_args,
        ]
        if os.path.exists(self.serial_path):
            os.remove(self.serial_path)
        self._start()

    def _start(self):
        workdir = os.path.abspath(self.workdir)
        cmd = self.cmd
        for sock in ('monitor.sock', 'serial.sock'):
            if os.path.exists(os.path.join(workdir, sock)):
                os.remove(os.path.join(workdir, sock))
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
        self.mousedown(button)
        self.mouseup()

    def mousedown(self, button='left'):
        self.monitor('mouse_button %d' % {'left': 1, 'right': 2, 'middle': 4}[button])
        time.sleep(0.15)

    def mouseup(self):
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

    mark = 0	# expect() looks at the log from here on

    def expect(self, pattern, timeout=30.0):
        rx = re.compile(pattern, re.M)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if rx.search(self.serial()[self.mark:]):
                return True
            if self.proc.poll() is not None:
                return False
            time.sleep(0.1)
        return False

    def send(self, line):
        self.ser.sendall((line + '\n').encode())

    def reset(self):
        # QEMU's system_reset does not reboot the raspi machine: restart QEMU
        self.mark = len(self.serial())
        self.stop()
        self._start()

    def stop(self):
        try:
            self.monitor('quit')
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


class SimMachine:
    """The simulator (sim/build/zgsim): log on stdout, commands on stdin."""

    def __init__(self, binary, workdir, card=None, size=None):
        self.binary = os.path.abspath(binary)
        self.workdir = workdir
        self.card = os.path.abspath(card) if card else None
        self.size = size
        self.serial_path = os.path.join(workdir, 'serial.log')
        if os.path.exists(self.serial_path):
            os.remove(self.serial_path)
        self.x = self.y = None          # pointer, once the screen size is known
        self.buttons = 0
        self._start()

    def _start(self):
        import threading
        args = [self.binary]
        if self.card:
            args += ['--card', self.card]
        if self.size:
            args += ['--size', self.size]
        self.log = open(self.serial_path, 'a')
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, cwd=self.workdir)
        self.answers = []
        threading.Thread(target=self._reader, args=(self.proc, self.log), daemon=True).start()
        self.x = self.y = None
        self.buttons = 0

    def _reader(self, proc, log):
        for raw in proc.stdout:
            line = raw.decode('utf-8', 'replace')
            if line.startswith('#'):
                self.answers.append(line.strip())
            log.write(line)
            log.flush()

    def _cmd(self, line):
        self.proc.stdin.write((line + '\n').encode())
        self.proc.stdin.flush()

    def serial(self):
        try:
            with open(self.serial_path, 'r', errors='replace') as f:
                return f.read()
        except OSError:
            return ''

    def key(self, name, hold_ms=60):
        if hold_ms == 60:
            self._cmd('key %s' % name)
        else:
            self._cmd('keydown %s' % name)
            time.sleep(hold_ms / 1000)
            self._cmd('keyup')
        time.sleep(0.12)

    def type(self, text):
        for c in text:
            self.key(char_to_key(c))

    def _screen(self):
        found = re.search(r'Screen (\d+)x(\d+)', self.serial())
        return (int(found.group(1)), int(found.group(2))) if found else (640, 480)

    def _pointer(self):
        if self.x is None:
            w, h = self._screen()
            self.x, self.y = (w + 1) // 2, (h + 1) // 2      # as at boot
        self._cmd('pointer %d %d %d' % (self.x, self.y, 1 if self.buttons else 0))

    def _move(self, dx, dy):
        # as Circle turns QEMU's relative mouse reports into pixels:
        # times 18/10 in integer math, a move off the screen is dropped
        w, h = self._screen()
        if self.x is None:
            self.x, self.y = (w + 1) // 2, (h + 1) // 2
        px = int(dx * 18 / 10)
        py = int(dy * 18 / 10)
        if 0 <= self.x + px < w:
            self.x += px
        if 0 <= self.y + py < h:
            self.y += py

    def mouse(self, dx, dy):
        steps = max(1, int(max(abs(dx), abs(dy)) / 10))
        for i in range(steps):
            sx = dx * (i + 1) // steps - dx * i // steps
            sy = dy * (i + 1) // steps - dy * i // steps
            self._move(sx, sy)
            self._pointer()
            time.sleep(0.03)

    def moveto(self, x, y):
        self.x, self.y = x, y
        self._pointer()
        time.sleep(0.1)

    def click(self, button='left'):
        self.mousedown(button)
        self.mouseup()

    def mousedown(self, button='left'):
        self.buttons = 1 if button == 'left' else 0
        self._pointer()
        time.sleep(0.15)

    def mouseup(self):
        self.buttons = 0
        self._pointer()
        time.sleep(0.15)

    def shot(self, png_path):
        png_path = os.path.abspath(png_path)
        want = '#shot %s' % png_path
        self._cmd('shot %s' % png_path)
        deadline = time.time() + 10
        while time.time() < deadline and want not in self.answers:
            time.sleep(0.02)
        return png_path

    serialshot = shot
    mark = 0

    def expect(self, pattern, timeout=30.0):
        rx = re.compile(pattern, re.M)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if rx.search(self.serial()[self.mark:]):
                return True
            if self.proc.poll() is not None:
                return bool(rx.search(self.serial()[self.mark:]))
            time.sleep(0.05)
        return False

    def send(self, line):
        raise SystemExit('send: the simulator has no serial port')

    def camera(self, args):
        self._cmd('camera %s' % args)

    def launch(self, app_id):
        self._cmd('launch %s' % app_id)
        time.sleep(0.1)

    def reset(self):
        self.mark = len(self.serial())
        self.stop()
        self._start()

    def stop(self):
        if self.proc.poll() is None:
            try:
                self._cmd('quit')
                self.proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()
        self.log.close()


def screen_coord(m, value, axis):
    """'123' is pixels, '50%' a fraction of the screen size, which the
    kernel logs at boot ("Screen 640x480")."""
    if not value.endswith('%'):
        return int(value)
    found = re.search(r'Screen (\d+)x(\d+)', m.serial())
    if not found:
        raise SystemExit('moveto %s: screen size not logged yet' % value)
    return int(int(found.group(axis + 1)) * float(value[:-1]) / 100)


def picture_file(name, scenario, outdir):
    """A picture for "camera picture": relative to the scenario's folder;
    a PNG becomes a PPM (what the simulator reads) in outdir."""
    full = os.path.join(os.path.dirname(os.path.abspath(scenario)), name)
    if not full.lower().endswith('.png'):
        return full
    from PIL import Image
    os.makedirs(outdir, exist_ok=True)
    ppm = os.path.join(os.path.abspath(outdir), os.path.basename(full)[:-4] + '.ppm')
    Image.open(full).convert('RGB').save(ppm)
    return ppm


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
                    name, _, hold = k.partition('@')
                    if hold:
                        m.key(name, int(hold))
                    else:
                        m.key(name)
            elif cmd == 'mouse':
                dx, dy = (int(v) for v in rest.split())
                m.mouse(dx, dy)
            elif cmd == 'moveto':
                x, y = (screen_coord(m, v, axis) for axis, v in enumerate(rest.split()))
                m.moveto(x, y)
            elif cmd in ('tile', 'tilefocus'):
                app = rest.strip()
                ready = re.findall(r'launcher ready: ([^\r\n]*)', m.serial()[m.mark:])
                tiles = ready[-1].split(', ') if ready else []
                if app not in tiles:
                    raise SystemExit('%s: no tile %r in the launcher (%s)' % (where, app, ', '.join(tiles)))
                for _ in range(tiles.index(app)):
                    m.key('right')
                if cmd == 'tile':
                    m.key('ret')
            elif cmd == 'launch':
                if not hasattr(m, 'launch'):
                    raise SystemExit('%s: launch works on the simulator only' % where)
                m.launch(rest.strip())
            elif cmd == 'click':
                m.click(rest.strip() or 'left')
            elif cmd == 'mousedown':
                m.mousedown(rest.strip() or 'left')
            elif cmd == 'mouseup':
                m.mouseup()
            elif cmd == 'serialshot':
                p = m.serialshot(os.path.join(outdir, rest.strip() + '.png'))
                print('[%s] serial screenshot %s' % (where, p))
            elif cmd == 'serialraw':
                if not hasattr(m, 'serialraw'):
                    raise SystemExit('%s: serialraw works on the rig only (the real Pi Camera)' % where)
                p = m.serialraw(os.path.join(outdir, rest.strip() + '.raw'))
                print('[%s] raw camera frame %s' % (where, p))
            elif cmd == 'shot':
                p = m.shot(os.path.join(outdir, rest.strip() + '.png'))
                print('[%s] screenshot %s' % (where, p))
            elif cmd == 'send':
                m.send(rest)
            elif cmd == 'camera':
                # the simulator takes it on stdin, test builds on the serial
                # line; a picture is a file for the simulator, and one of the
                # test pictures built into test kernels by its name
                # (src/testpictures.h: tests/colorqr/<name>.png)
                if hasattr(m, 'camera'):
                    if rest.startswith('picture '):
                        rest = 'picture ' + picture_file(rest[8:].strip(), path, outdir)
                    m.camera(rest)
                else:
                    if rest.startswith('picture '):
                        rest = 'picture ' + os.path.splitext(os.path.basename(rest[8:].strip()))[0]
                    m.send('#camera ' + rest)
            elif cmd == 'reset':
                m.reset()
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
    ap.add_argument('--sd', help='SD card image (tools/make_sd_image.sh); default: no card')
    ap.add_argument('--sim', help='run on the simulator binary (sim/build/zgsim) instead of QEMU')
    ap.add_argument('--card', help='with --sim: folder that plays the SD card (apps in DIR/apps)')
    ap.add_argument('--size', help='with --sim: screen size, e.g. 1824x984 (default 640x480)')
    args = ap.parse_args()

    outdir = args.out or tempfile.mkdtemp(prefix='zerogap-qemu-')
    os.makedirs(outdir, exist_ok=True)
    extra = []
    if args.sd:
        # a private copy: QEMU may write to it, and runs can go in parallel
        img = os.path.join(outdir, 'sd.img')
        shutil.copyfile(args.sd, img)
        extra = ['-drive', 'file=%s,if=sd,format=raw' % os.path.abspath(img)]
    if args.sim:
        m = SimMachine(args.sim, outdir, args.card, args.size)
    else:
        m = Machine(args.kernel, outdir, extra)
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
            if args.keep and not args.sim:
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
