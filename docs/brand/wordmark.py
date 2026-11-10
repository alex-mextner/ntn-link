# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Draws the "Fast Page" wordmark and the icon + wordmark lockup (no dependencies, deterministic):

    uv run docs/brand/wordmark.py                  # writes fastp-wordmark.svg and fastp-lockup.svg
    uv run docs/brand/wordmark.py --previews DIR   # also renders light/dark 1x/2x PNGs with headless Chrome

The letters are authored here as centre lines (a handful of points per stroke, y up, baseline at 0),
smoothed with Catmull-Rom splines, then given the hand of the owner's logo: a slight forward lean,
a wobbling baseline, and per-letter drift, all from a fixed seed. They are stroked with the logo's
own line weight (STROKE units on the logo's 1254 px canvas, measured on the original PNG as the
median skeleton distance: about 39.5 px), round caps and joins, no fill. The result is plain SVG
paths in `currentColor`; no font is involved, and the glyph data is original work (see README.md).

Nothing here runs in the product: the generated files are committed.
"""
import argparse
import math
import random
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BRAND = Path(__file__).resolve().parent

# Line weight of the logo on its 1254 px canvas, from the original PNG (median skeleton distance * 2 + 1).
STROKE = 40
# The logo's ink box on that canvas (build.py: x 74..1130, y 158..1066, ends exclusive).
ICON_INK = (74, 158, 1131, 1067)
# Wordmark size: centre-line x-height / cap height / descender depth in canvas units, before the lean.
SCALE = 1.3
SLANT = math.radians(9)  # forward lean of the letters
TILT = math.radians(-1.2)  # the whole word rises a little towards the right, like the page's top edge
SEED = 139
# Gap between letters measured between outer edges, and the width of the word space (centre-line units).
LETTER_GAP = 62
WORD_GAP = 330
# Pair adjustments (centre-line units): F's arms leave room to tuck the next letter under.
KERN = {"Fa": -70}

Point = tuple[float, float]
# A stroke is a run of points; a point written (x, y, "c") is a sharp corner, everything else is smooth.
Stroke = list[tuple]

XH, CAP, DESC = 400, 620, -230

BOWL_A: Stroke = [(245, 200), (228, 322), (150, 396), (70, 368), (30, 200), (68, 48), (150, 4), (226, 58), (250, 200)]

# Centre lines per glyph (x from the left-most stroke at ~0, y up from the baseline).
GLYPHS: dict[str, list[Stroke]] = {
    "F": [
        [(62, 610), (56, 400), (48, 200), (42, 0)],
        [(50, 600), (160, 620), (270, 614), (352, 598)],
        [(56, 330), (130, 340), (220, 334), (280, 326)],
    ],
    "a": [
        BOWL_A,
        [(250, 398), (251, 200), (255, 56), (304, 6)],
    ],
    "s": [
        [(252, 336), (192, 398), (112, 396), (56, 346), (80, 270), (158, 218), (226, 168), (238, 92), (182, 22), (100, 6), (38, 52)],
    ],
    "t": [
        [(104, 560), (100, 400), (98, 180), (120, 50), (172, 6), (238, 28)],
        [(14, 390), (100, 400), (210, 394)],
    ],
    "P": [
        [(62, 610), (54, 300), (44, 0)],
        [(54, 606), (170, 624), (270, 592), (302, 492), (262, 402), (172, 362), (56, 350)],
    ],
    "g": [
        BOWL_A,
        [(250, 398), (252, 150), (246, -96), (192, -196), (112, -226), (38, -186)],
    ],
    "e": [
        [(44, 204), (150, 216), (256, 236), (240, 342), (160, 398), (80, 370), (40, 250), (56, 110), (130, 12), (210, 10), (266, 72)],
    ],
}
TEXT = "Fast Page"


Segment = tuple[Point, Point, Point]
Run = tuple[Point, list[Segment]]


def catmull_rom(points: list[Point]) -> list[Segment]:
    """Cubic segments (c1, c2, end) through the points, the tangent at each from its two neighbours."""
    padded = [points[0], *points, points[-1]]
    out = []
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append((c1, c2, p2))
    return out


def split_at_corners(stroke: Stroke) -> list[list[Point]]:
    """A corner point ends one smooth run and starts the next; the runs share it."""
    runs: list[list[Point]] = [[]]
    for i, point in enumerate(stroke):
        runs[-1].append((point[0], point[1]))
        if len(point) == 3 and 0 < i < len(stroke) - 1:
            runs.append([(point[0], point[1])])
    return runs


def place_glyph(glyph: list[Stroke], cursor: float, rng: random.Random) -> tuple[list[Run], float]:
    """One letter with its own hand (a little rotation, baseline drift, size breathing); returns its runs and width."""
    xs = [p[0] for stroke in glyph for p in stroke]
    left = min(xs)
    rot = math.radians(rng.uniform(-2.4, 2.4))
    drift = rng.uniform(-9, 9)
    breathe = rng.uniform(0.97, 1.03)
    runs: list[Run] = []
    for stroke in glyph:
        moved = []
        for point in stroke:
            x, y = (point[0] - left) * breathe + rng.uniform(-5, 5), point[1] * breathe + rng.uniform(-5, 5)
            x, y = x * math.cos(rot) - y * math.sin(rot), x * math.sin(rot) + y * math.cos(rot) + drift
            moved.append((x * SCALE + cursor, y * SCALE, *point[2:]))
        runs += [(run[0], catmull_rom(run)) for run in split_at_corners(moved)]
    return runs, (max(xs) - left) * breathe * SCALE


def draw_word() -> list[Run]:
    """Every smooth run of the word in canvas units, y up, baseline at 0, left outer edge at x = 0."""
    rng = random.Random(SEED)
    runs: list[Run] = []
    cursor = STROKE / 2  # centre line of the first letter sits half a stroke inside the edge
    prev = ""
    for char in TEXT:
        if char == " ":
            cursor += WORD_GAP * SCALE
            prev = ""
            continue
        if prev:
            cursor += (LETTER_GAP + KERN.get(prev + char, 0)) * SCALE + STROKE
        placed, width = place_glyph(GLYPHS[char], cursor, rng)
        runs += placed
        cursor += width
        prev = char
    return runs


def lean(point: Point) -> Point:
    """Forward lean, then the whole word rises a little to the right; y is flipped to SVG's y down."""
    x, y = point[0] + point[1] * math.tan(SLANT), point[1]
    x, y = x * math.cos(TILT) - y * math.sin(TILT), x * math.sin(TILT) + y * math.cos(TILT)
    return x, -y


def cubic_at(p0: Point, c1: Point, c2: Point, p1: Point, t: float) -> Point:
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * p1[0],
        u**3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * p1[1],
    )


def leaned_word() -> list[Run]:
    return [(lean(start), [(lean(a), lean(b), lean(c)) for a, b, c in segs]) for start, segs in draw_word()]


def centre_box(runs: list[Run]) -> tuple[float, float, float, float]:
    xs, ys = [], []
    for start, segs in runs:
        cur = start
        xs.append(cur[0])
        ys.append(cur[1])
        for c1, c2, end in segs:
            for k in range(1, 25):
                x, y = cubic_at(cur, c1, c2, end, k / 24)
                xs.append(x)
                ys.append(y)
            cur = end
    return min(xs), min(ys), max(xs), max(ys)


def num(value: float) -> str:
    return str(round(value))


def path_data(runs: list[Run], dx: float, dy: float) -> str:
    out = []
    for start, segs in runs:
        out.append(f"M{num(start[0] + dx)} {num(start[1] + dy)}")
        for seg in segs:
            out.append("C" + " ".join(f"{num(p[0] + dx)} {num(p[1] + dy)}" for p in seg))
    return "".join(out)


def svg(view: tuple[int, int, int, int], body: str) -> str:
    x, y, w, h = view
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {w} {h}">{body}</svg>\n'


def stroked(d: str) -> str:
    return f'<path fill="none" stroke="currentColor" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round" d="{d}"/>'


def build() -> dict[str, str]:
    runs = leaned_word()
    x0, y0, x1, y1 = centre_box(runs)
    half = STROKE / 2
    # Outer edges of the lettering (centre lines grown by half a stroke) and one stroke of padding.
    outer_w, outer_h = x1 - x0 + STROKE, y1 - y0 + STROKE
    pad = STROKE
    w = math.ceil(outer_w + 2 * pad)
    h = math.ceil(outer_h + 2 * pad)
    word_only = svg((0, 0, w, h), stroked(path_data(runs, pad + half - x0, pad + half - y0)))

    # Lockup: the icon keeps its own coordinates; the word's lowest baseline-level edge lines up with the icon's bottom.
    ix0, iy0, ix1, iy1 = ICON_INK
    base_y = iy1 - half  # centre line of the baseline
    word_left = ix1 + LOCKUP_GAP
    dx, dy = word_left + half - x0, base_y  # the baseline is y = 0 before the flip, so only the shift remains
    word_top, word_bottom = y0 + dy - half, y1 + dy + half
    lx0, ly0 = ix0 - pad, min(iy0, word_top) - pad
    lx1 = word_left + outer_w + pad
    ly1 = max(iy1, word_bottom) + pad
    icon_d = re.search(r' d="([^"]+)"', (BRAND / "fastp-logo.svg").read_text()).group(1)
    icon = f'<path fill="currentColor" fill-rule="evenodd" d="{icon_d}"/>'
    lockup = svg((lx0, ly0, math.ceil(lx1 - lx0), math.ceil(ly1 - ly0)), icon + stroked(path_data(runs, dx, dy)))
    return {"fastp-wordmark.svg": word_only, "fastp-lockup.svg": lockup}


# Gap between the icon's right-most ink and the first letter, three strokes.
LOCKUP_GAP = 3 * STROKE

INK = "#0b0b14"
PAPER = "#ffffff"
INK_ON_DARK = "#f3f3f8"
PAPER_DARK = "#0b0b14"


def previews(files: dict[str, str], out: Path) -> None:
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    assert chrome, "headless Chrome is needed for previews"
    out.mkdir(parents=True, exist_ok=True)
    jobs = [("wordmark", "fastp-wordmark.svg", h) for h in (24, 48, 96)] + [("wordmark", "fastp-wordmark.svg", 0)]
    jobs += [("lockup", "fastp-lockup.svg", h) for h in (24, 48, 96)]
    for theme, ink, paper in (("light", INK, PAPER), ("dark", INK_ON_DARK, PAPER_DARK)):
        for name, file, height in jobs:
            m = re.search(r'viewBox="(\S+) (\S+) (\S+) (\S+)"', files[file])
            vw, vh = float(m.group(3)), float(m.group(4))
            if height == 0:  # the 360 px wide case
                width, height = 360, round(360 * vh / vw)
            else:
                width = round(height * vw / vh)
            for scale in (1, 2):
                page = out / f"{name}-{height}-{theme}.html"
                page.write_text(
                    f'<body style="margin:0;background:{paper};color:{ink}">'
                    f'<div style="width:{width}px;height:{height}px">{files[file].replace("<svg ", f"<svg width={width} height={height} ", 1)}</div></body>'
                )
                png = out / f"{name}-{height}-{theme}@{scale}x.png"
                subprocess.run(
                    [chrome, "--headless=new", "--no-sandbox", "--hide-scrollbars", f"--force-device-scale-factor={scale}",
                     f"--screenshot={png}", f"--window-size={width},{height}", page.as_uri()],
                    check=True, capture_output=True,
                )
                page.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--previews", type=Path, help="also render light/dark PNG previews into this directory")
    args = parser.parse_args()
    files = build()
    for name, text in files.items():
        (BRAND / name).write_text(text)
        print(f"{name}: {len(text)} bytes")
    if args.previews:
        previews(files, args.previews)


if __name__ == "__main__":
    main()
