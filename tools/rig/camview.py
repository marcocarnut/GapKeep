#!/usr/bin/env python3
"""
The rig's Pi Camera in a window, for aiming it. A frame each 3.5 s or so:
the 640x480 grey picture the scanner works on, over the serial line.

  tools/rig/camview.py                build a test kernel, send it to the rig,
                                      start the camera (about a minute), show
  tools/rig/camview.py --no-flash     the rig's kernel is running, with the
                                      scanner open: show at once

The lines mark the middle of the picture. s saves the frame as camview-N.pgm
here; q or Esc quits. The rig: $GK_RIG, default mac@five.local (docs/RIG.md).
"""
import argparse
import os
import subprocess
import sys
import threading
import tkinter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read_frames(proc, got):
    """Hands each PGM on proc's stdout to got(bytes); got(None) at the end."""
    f = proc.stdout
    while True:
        head = f.readline()
        if not head:
            break
        size = f.readline()
        depth = f.readline()
        width, height = (int(x) for x in size.split())
        pixels = f.read(width * height)
        if len(pixels) < width * height:
            break
        got(head + size + depth + pixels)
    got(None)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--no-flash', action='store_true', help='use the kernel running on the rig')
    args = ap.parse_args()
    rig = os.environ.get('GK_RIG', 'mac@five.local')

    if args.no_flash:
        hexfile = ''
    else:
        print('building the test kernel...')
        subprocess.run(['tools/build.sh', 'pi', 'TEST=1'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['make', '-C', 'src', '-s', 'kernel.hex', 'TEST=1'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        hexfile = 'kernel.hex'
    subprocess.run(['ssh', rig, 'mkdir -p zerogap-rig'], check=True)
    files = ['tools/rig/gkrig.py', 'tools/rig/peek.txt', 'tools/serialshot.py', 'tools/qemu_harness.py']
    if hexfile:
        files.insert(0, 'src/kernel.hex')
    subprocess.run(['scp', '-q'] + files + [rig + ':zerogap-rig/'], cwd=ROOT, check=True)
    print('starting the camera on the rig' + (' (about a minute)...' if hexfile else '...'))
    proc = subprocess.Popen(['ssh', rig, 'cd zerogap-rig && exec python3 gkrig.py peek ' + hexfile],
                            stdout=subprocess.PIPE)

    win = tkinter.Tk()
    win.title('Pi Camera: waiting for the first frame')
    canvas = tkinter.Canvas(win, width=640, height=480, background='black', highlightthickness=0)
    canvas.pack()
    picture = canvas.create_image(0, 0, anchor='nw')
    canvas.create_line(320, 0, 320, 480, fill='#ff4040')
    canvas.create_line(0, 240, 640, 240, fill='#ff4040')
    state = {'frame': None, 'image': None, 'count': 0, 'saved': 0}
    frames = []			# from the reader thread

    def show():
        while frames:
            data = frames.pop(0)
            if data is None:
                win.title('Pi Camera: the rig stopped sending')
                return
            state['frame'] = data
            state['count'] += 1
            state['image'] = tkinter.PhotoImage(data=data, format='PPM')
            canvas.itemconfigure(picture, image=state['image'])
            win.title('Pi Camera: frame %d' % state['count'])
        win.after(100, show)

    def save(_event):
        if state['frame']:
            state['saved'] += 1
            name = 'camview-%d.pgm' % state['saved']
            with open(name, 'wb') as f:
                f.write(state['frame'])
            print(name)

    win.bind('s', save)
    win.bind('q', lambda _e: win.destroy())
    win.bind('<Escape>', lambda _e: win.destroy())
    threading.Thread(target=read_frames, args=(proc, frames.append), daemon=True).start()
    show()
    win.mainloop()
    proc.terminate()


if __name__ == '__main__':
    sys.exit(main())
