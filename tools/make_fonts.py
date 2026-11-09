#!/usr/bin/env python3
"""Regenerates GapKeep's fonts, src/runtime/fonts/gk_montserrat_*.c, gk_mono_*.c and gk_ttf_*.c.

The ten sizes gk:ui offers (src/runtime/js_ui.cpp, Fonts[]), each with
Montserrat Medium for text and Font Awesome Free for LVGL's icons
(lv_symbol_def.h), converted by lv_font_conv 1.5.3 the way LVGL converts
its own built-in fonts (4 bpp, uncompressed, kerning by classes).

    tools/make_fonts.py [--packages DIR]

DIR (default ~/.local/share/fonts-packages) holds the two zips as
downloaded; their SHA-256s, and those of the font files in them, must
match the ones below. The zips are read, never changed: the fonts are
extracted into a temporary folder, deleted afterwards.

Text: Basic Latin, Latin-1 (without U+00AD, the soft hyphen, which
Montserrat doesn't have), Latin Extended-A, and the punctuation and
currency signs in TEXT_EXTRA. Icons: every LV_SYMBOL_* of LVGL's
lv_symbol_def.h, from Font Awesome's Solid face, or Brands for the two
logos. LV_SYMBOL_NEW_LINE (U+F8A2) is a Font Awesome Pro icon: the free
level-down-alt (U+F3BE) stands in for it.

Line height: lv_font_conv makes it fit every glyph, which with Å above
and the comma-below letters of Latin Extended-A (Ģ, Ķ, ...) under would
make every line about a quarter taller than LVGL's ASCII fonts, and move
every layout. Instead, the line's top is the tallest of ASCII and the
icons, and its bottom the deepest of ASCII, Latin-1 and the icons (so ç
and Ç fit). Accents on capitals reach above the line, as in most fonts'
own metrics: LVGL doesn't clip a label's text at the top (it gives labels
extra draw area), but does at the bottom, so the bottom must fit the
common letters. The Latin Extended-A letters with a comma or cedilla
below (Ģ ķ Ļ ņ Ŗ Ţ ...) can lose up to 2 pixels at the bottom of a label's
last line.

Kerning: Montserrat 9.000 has its kerning in GPOS lookups wrapped as
Extension lookups (type 9), which lv_font_conv's opentype.js (1.3.4)
skips: the fonts would have no kerning at all (LVGL's had). So the TTF is
first subset to the characters above with fontTools (pip "fonttools",
FONTTOOLS_VERSION; Debian's python3-fonttools), which makes its tables
small enough for plain lookups, and the Extension lookups are unwrapped.
The outlines and hinting are kept: the glyphs are the same.

The monospaced font (gk:ui's "mono", for addresses, keys, hex and code):
JetBrains Mono 2.304 Medium, the weight whose stems match Montserrat
Medium's (1.57 px against 1.60 at 16 px; Regular's are 1.43), in
MONO_SIZES, with Basic Latin and Latin-1. It has the same line height and
baseline as Montserrat of the same size, so the two mix on a row, and
falls back to it (LVGL's font fallback) for everything else: the icons,
Latin Extended-A, € and ₿.

Bold, italic and bold italic (markup's <b> and <i>): Montserrat Bold,
Medium Italic and Bold Italic, from the same zip, as TrueType files for
LVGL's TinyTTF, which draws them at run time, at any size, when a label
first uses them (src/runtime/ttfstyles.cpp): gk_ttf_<style>.c, one C array
each. The same characters as the bitmap fonts, the kerning unwrapped as
above, and no hinting, which TinyTTF's rasterizer (stb_truetype) ignores.

The fonts' licences are copied next to them (LICENCE.montserrat, the
SIL OFL 1.1; LICENCE.fontawesome, Font Awesome Free's, whose fonts are
under the OFL too; LICENCE.jetbrainsmono, the OFL).

The output is the same on every run with the same inputs and the same
lv_font_conv: the command line is written at the top of every file.
"""
import argparse, hashlib, os, re, shutil, subprocess, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "runtime", "fonts")
SYMBOLS_H = os.path.join(ROOT, "circle", "addon", "lvgl", "lvgl", "src", "font", "lv_symbol_def.h")

LV_FONT_CONV_VERSION = "1.5.3"
FONTTOOLS_VERSION = "4.46.0"
SIZES = [12, 14, 16, 18, 20, 22, 24, 28, 32, 40]
MONO_SIZES = [12, 14, 16, 18, 20, 24, 28]

# The sources: (zip or member, sha256).
MONTSERRAT_ZIP = ("Montserrat.zip",
                  "629117378f5c0206444747493be4ac1da33f39eff8f0144bdc5640e5ffeed1d3")
MONTSERRAT_TTF = ("static/Montserrat-Medium.ttf",          # version 9.000
                  "cd161cba3a3cdcf68ad721920fcd164c87e7b7cc9e6bad510278c3fa378d91d2")
MONTSERRAT_LICENCE = ("OFL.txt",
                      "77669d97bc1fcef80d834ac2c1432943d48ed9ae4cdfc80f26e49d1da84830ac")
FA_ZIP = ("fontawesome-free-5.15.4-desktop.zip",
          "8edb14e55165a5936e5294ee5420a9a96a2778456b20423f1bad6079f1f95bac")
FA_DIR = "fontawesome-free-5.15.4-desktop/"
FA_SOLID = (                                    # 5.15.4
            FA_DIR + "otfs/Font Awesome 5 Free-Solid-900.otf",
            "7bdee169eb7f04b3e08de629fb530ec7fed8f1d1b4a9827d702331d227e24240")
FA_BRANDS = (FA_DIR + "otfs/Font Awesome 5 Brands-Regular-400.otf",
             "70da961ebca3c012db6c9bf3788153d690357d94226a4009103f7073414706ba")
FA_LICENCE = (FA_DIR + "LICENSE.txt",
              "e779748dfe75e84f974df3c7bc07f842011a100159158b0f1f49b2f2a5a515cb")

MONO_ZIP = ("JetBrainsMono-2.304.zip",
            "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf")
MONO_TTF = ("fonts/ttf/JetBrainsMono-Medium.ttf",        # version 2.304
            "31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d")
MONO_LICENCE = ("OFL.txt",
                "30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad")
MONO_RANGES = ["0x20-0x7E", "0xA0-0xFF"]

# markup's bold and italic, for TinyTTF (see above): (style, member, sha256)
STYLE_TTFS = [
    ("bold", "static/Montserrat-Bold.ttf",
     "7fa93d7daa5c2f881a6727229c211782de6b76008fbd6346b3d7664e8fc83f43"),
    ("italic", "static/Montserrat-MediumItalic.ttf",
     "6fff5b96f46799dd903d5cbf99f0901d3077e5b99843e5a92b6a3a324b6dd99f"),
    ("bolditalic", "static/Montserrat-BoldItalic.ttf",
     "001a59b0f2c541080033b83ca6dfacce03095d99caa3594835f51b7c6d9ce758"),
]

TEXT_RANGES = ["0x20-0x7E", "0xA0-0xAC", "0xAE-0xFF", "0x100-0x17F"]
TEXT_EXTRA = [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D,  # – — ‘ ’ “ ”
              0x2022, 0x2026, 0x20AC, 0x20BF]                  # • … € ₿
BRANDS = {0xF287, 0xF293}                       # usb, bluetooth
REMAP = {0xF8A2: 0xF3BE}                        # new-line <= level-down-alt


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()


def check(path, want):
    got = sha256(path)
    if want is not None and got != want:
        sys.exit(f"make_fonts: {path}: sha256 {got}, expected {want}")


def symbols():
    """The icon codepoints LVGL defines, sorted."""
    cps = set()
    for m in re.finditer(r'#define LV_SYMBOL_(\w+)\s+"((?:\\x[0-9A-Fa-f]{2})+)"', open(SYMBOLS_H).read()):
        if m.group(1) == "DUMMY":
            continue
        cp = ord(bytes(int(x, 16) for x in m.group(2).split("\\x")[1:]).decode())
        if cp >= 0xF000:
            cps.add(cp)
    return sorted(cps)


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0 or r.stderr.strip():
        sys.exit(f"make_fonts: {' '.join(cmd)}: {r.stderr or r.stdout}")


def metrics(path):
    src = open(path).read()
    return (int(re.search(r"\.line_height = (\d+),", src).group(1)),
            int(re.search(r"\.base_line = (\d+),", src).group(1)))


def unwrap_kerning(ttf, out, codepoints, hinting=True):
    """ttf subset to codepoints, GPOS Extension lookups unwrapped (see above).
    Without hinting: only what TinyTTF reads (outlines, metrics, cmap, GPOS),
    and the same bytes every run (the file's dates kept)."""
    try:
        import fontTools
        from fontTools.ttLib import TTFont
        from fontTools import subset
    except ImportError:
        sys.exit("make_fonts: needs fontTools (pip install fonttools==%s)" % FONTTOOLS_VERSION)
    if fontTools.version != FONTTOOLS_VERSION:
        sys.exit(f"make_fonts: fontTools {fontTools.version}, expected {FONTTOOLS_VERSION}")
    font = TTFont(ttf, recalcTimestamp=False)
    opts = subset.Options()
    opts.layout_features = ["kern"]
    opts.name_IDs = ["*"] if hinting else [0, 1, 2, 3, 4, 5, 6]	# 0: the copyright notice
    opts.notdef_outline = True
    opts.hinting = hinting
    if not hinting:
        opts.drop_tables += ["GSUB", "GDEF", "STAT", "DSIG"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=codepoints)
    sub.subset(font)
    for lookup in font["GPOS"].table.LookupList.Lookup:
        if lookup.LookupType == 9:
            lookup.SubTable = [ext.ExtSubTable for ext in lookup.SubTable]
            lookup.LookupType = lookup.SubTable[0].LookupType
            lookup.SubTableCount = len(lookup.SubTable)
    font.save(out)
    check = TTFont(out)
    if any(l.LookupType == 9 for l in check["GPOS"].table.LookupList.Lookup):
        sys.exit("make_fonts: GPOS still has Extension lookups after subsetting")


def codepoints(ranges):
    out = []
    for r in ranges:
        a, _, b = r.partition("-")
        out.extend(range(int(a, 16), int(b or a, 16) + 1))
    return out


def extract(zpath, member, dest, name=None):
    with zipfile.ZipFile(zpath) as z:
        out = os.path.join(dest, name or os.path.basename(member))
        with z.open(member) as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--packages", default=os.path.expanduser("~/.local/share/fonts-packages"))
    args = ap.parse_args()

    mzip = os.path.join(args.packages, MONTSERRAT_ZIP[0])
    fzip = os.path.join(args.packages, FA_ZIP[0])
    jzip = os.path.join(args.packages, MONO_ZIP[0])
    check(mzip, MONTSERRAT_ZIP[1])
    check(fzip, FA_ZIP[1])
    check(jzip, MONO_ZIP[1])

    tmp = tempfile.mkdtemp(prefix="gk-fonts-")
    try:
        ttf = extract(mzip, MONTSERRAT_TTF[0], tmp)
        solid = extract(fzip, FA_SOLID[0], tmp)
        brands = extract(fzip, FA_BRANDS[0], tmp)
        check(ttf, MONTSERRAT_TTF[1])
        check(solid, FA_SOLID[1])
        check(brands, FA_BRANDS[1])
        licences = []
        mono = extract(jzip, MONO_TTF[0], tmp)
        check(mono, MONO_TTF[1])
        for zp, (member, want), name in ((mzip, MONTSERRAT_LICENCE, "LICENCE.montserrat"),
                                         (fzip, FA_LICENCE, "LICENCE.fontawesome"),
                                         (jzip, MONO_LICENCE, "LICENCE.jetbrainsmono")):
            path = extract(zp, member, tmp, name)	# two are OFL.txt
            check(path, want)
            licences.append((path, name))

        ver = subprocess.run(["lv_font_conv", "--version"], capture_output=True, text=True).stdout.strip()
        if ver != LV_FONT_CONV_VERSION:
            sys.exit(f"make_fonts: lv_font_conv {ver}, expected {LV_FONT_CONV_VERSION}")

        icons = symbols()
        solid_r = [f"0x{REMAP[c]:X}=>0x{c:X}" if c in REMAP else f"0x{c:X}"
                   for c in icons if c not in BRANDS]
        brands_r = [f"0x{c:X}" for c in icons if c in BRANDS]
        text_r = TEXT_RANGES + [f"0x{c:X}" for c in TEXT_EXTRA]
        kerned = os.path.join(tmp, "Montserrat-Medium.kern.ttf")
        unwrap_kerning(ttf, kerned, codepoints(text_r))
        ttf = kerned

        os.makedirs(OUT, exist_ok=True)
        lines = {}			# size: (line_height, base_line), for the mono font
        for size in SIZES:
            name = f"gk_montserrat_{size}"
            # Relative paths, run from tmp: the command line lands in the
            # file, and must not depend on where the fonts were extracted.
            def conv(text, out):
                cmd = ["lv_font_conv", "--no-compress", "--no-prefilter", "--bpp", "4",
                       "--size", str(size), "--format", "lvgl", "--force-fast-kern-format",
                       "--lv-include", "lvgl/lvgl/lvgl.h", "--lv-font-name", name,
                       "--font", os.path.basename(ttf), "-r", ",".join(text),
                       "--font", os.path.basename(solid), "-r", ",".join(solid_r),
                       "--font", os.path.basename(brands), "-r", ",".join(brands_r),
                       "-o", out]
                run(cmd, tmp)
                return metrics(os.path.join(tmp, out))
            # the line's top from ASCII and the icons, its bottom from
            # Latin-1 too (see above)
            lh, base = conv(TEXT_RANGES[:1], "top.c")
            top = lh - base
            _, base = conv(TEXT_RANGES[:3], "bottom.c")
            conv(text_r, name + ".c")
            path = os.path.join(tmp, name + ".c")
            src = open(path).read()
            src, n1 = re.subn(r"\.line_height = \d+,.*", f".line_height = {top + base},          "
                              "/*ASCII and icons' top, Latin-1's bottom: tools/make_fonts.py*/", src)
            src, n2 = re.subn(r"\.base_line = \d+,.*", f".base_line = {base},             "
                              "/*Baseline measured from the bottom of the line*/", src)
            if n1 != 1 or n2 != 1:
                sys.exit(f"make_fonts: {name}: line_height or base_line not found")
            open(path, "w").write(src)
            shutil.copy(os.path.join(tmp, name + ".c"), os.path.join(OUT, name + ".c"))
            print(f"make_fonts: {name}.c")
            lines[size] = (top + base, base)

        for size in MONO_SIZES:
            name = f"gk_mono_{size}"
            cmd = ["lv_font_conv", "--no-compress", "--no-prefilter", "--bpp", "4",
                   "--size", str(size), "--format", "lvgl",
                   "--lv-include", "lvgl/lvgl/lvgl.h", "--lv-font-name", name,
                   "--lv-fallback", f"gk_montserrat_{size}",
                   "--font", os.path.basename(mono), "-r", ",".join(MONO_RANGES),
                   "-o", name + ".c"]
            run(cmd, tmp)
            path = os.path.join(tmp, name + ".c")
            src = open(path).read()
            # Montserrat's line, so they mix on a row (see above)
            lh, base = lines[size]
            src, n1 = re.subn(r"\.line_height = \d+,.*", f".line_height = {lh},          "
                              f"/*gk_montserrat_{size}'s: tools/make_fonts.py*/", src)
            src, n2 = re.subn(r"\.base_line = \d+,.*", f".base_line = {base},             "
                              "/*Baseline measured from the bottom of the line*/", src)
            if n1 != 1 or n2 != 1:
                sys.exit(f"make_fonts: {name}: line_height or base_line not found")
            open(os.path.join(OUT, name + ".c"), "w").write(src)
            print(f"make_fonts: {name}.c")
        # markup's bold and italic: subset TTFs as C arrays
        for style, member, want in STYLE_TTFS:
            path = extract(mzip, member, tmp)
            check(path, want)
            out = os.path.join(tmp, f"{style}.ttf")
            unwrap_kerning(path, out, codepoints(text_r), hinting=False)
            data = open(out, "rb").read()
            name = f"gk_ttf_{style}"
            lines_c = [", ".join(f"0x{b:02x}" for b in data[i:i + 16]) + "," for i in range(0, len(data), 16)]
            with open(os.path.join(OUT, name + ".c"), "w") as f:
                f.write(f"/* {os.path.basename(member)}, subset by tools/make_fonts.py (sha256 of the\n"
                        f" * original {want[:16]}...), for TinyTTF: {len(data)} bytes. */\n"
                        f"#include <stddef.h>\n\n"
                        f"const unsigned char {name}[] __attribute__ ((aligned (4))) =\n{{\n")
                f.write("\n".join("\t" + l for l in lines_c))
                f.write(f"\n}};\nconst size_t {name}_size = sizeof {name};\n")
            print(f"make_fonts: {name}.c ({len(data)} bytes)")

        # tools/make_sdcard.sh puts these on the cards, with kernel.img
        for path, name in licences:
            shutil.copy(path, os.path.join(OUT, name))
    finally:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
