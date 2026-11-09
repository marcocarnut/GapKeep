#!/usr/bin/env python3
"""
Turn an image (PNG, JPEG, ...) into a GapKeep picture icon: the value of
"icon" in an app's manifest.json (docs/APPS.md):

    { "width": 64, "height": 64, "rgba": "<base64 of width*height*4 bytes>" }

GapKeep does not decode PNG or any other compressed format on the device:
the manifest carries plain pixels, which the device only has to base64-decode
and check for length.

Usage: make_icon.py <image> [--size N] [--manifest apps/<id>/manifest.json]
    --size N      scale to fit N x N (default 64; at most 128), keeping the
                  aspect ratio; the icon is the scaled image's size
    --manifest M  write the icon into manifest M (other keys stay as they
                  are) instead of printing it

Needs Pillow (pip install pillow); runs on the development machine only.
"""
import base64
import json
import sys

MAX_SIDE = 128      # GK_ICON_MAX_SIDE in src/runtime/bundle.h


def main():
    args = sys.argv[1:]
    size, manifest = 64, None
    if not args or args[0].startswith('-'):
        sys.exit(__doc__)
    image_path = args.pop(0)
    while args:
        opt = args.pop(0)
        if opt == '--size' and args:
            size = int(args.pop(0))
        elif opt == '--manifest' and args:
            manifest = args.pop(0)
        else:
            sys.exit(__doc__)
    if not 1 <= size <= MAX_SIDE:
        sys.exit('make_icon.py: --size must be 1 to %d' % MAX_SIDE)

    from PIL import Image
    img = Image.open(image_path).convert('RGBA')
    if max(img.size) != size:
        scale = size / max(img.size)
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                         Image.LANCZOS)
    icon = {'width': img.width, 'height': img.height,
            'rgba': base64.b64encode(img.tobytes()).decode()}

    if manifest is None:
        print(json.dumps(icon))
        return
    with open(manifest, encoding='utf-8') as f:
        m = json.load(f)
    m['icon'] = icon
    with open(manifest, 'w', encoding='utf-8') as f:
        f.write(json.dumps(m, indent=2, ensure_ascii=False) + '\n')
    print('%s: icon %dx%d' % (manifest, img.width, img.height))


if __name__ == '__main__':
    main()
