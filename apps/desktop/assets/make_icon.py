"""Generate the Catalyst app icon (distinct from the Hermes/Nous mark).

Mark: an open catalytic ring broken at the top by an ascending bolt — the
catalyst that starts the reaction. Sand-on-navy, matching the CATALYST wordmark.

Usage: python assets/make_icon.py
Writes assets/icon.png at 1024x1024 (source of truth for .icns/.ico).
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
SS = 4  # supersample factor
N = S * SS

NAVY_TOP = (30, 48, 120)
NAVY_BOTTOM = (11, 18, 56)
SAND = (223, 203, 184)
SAND_HI = (247, 236, 224)

HERE = Path(__file__).resolve().parent


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    assert px is not None
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return grad.resize((size, size), Image.Resampling.BILINEAR)


def scaled(points: list[tuple[float, float]], factor: float) -> list[tuple[float, float]]:
    """Scale a polygon about its own centroid (used for the knockout halo)."""
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)

    return [(cx + (x - cx) * factor, cy + (y - cy) * factor) for x, y in points]


def build() -> Image.Image:
    base = vertical_gradient(N, NAVY_TOP, NAVY_BOTTOM).convert("RGBA")
    draw = ImageDraw.Draw(base, "RGBA")

    cx = cy = N / 2
    r = N * 0.305
    w = N * 0.095

    # Open catalytic ring — one continuous arc with a gap at the top where the
    # bolt breaks out. Angles are clockwise from 3 o'clock in PIL.
    start, end = 302.0, 598.0  # gap spans roughly 11 → 1 o'clock
    draw.arc((cx - r, cy - r, cx + r, cy + r), start, end, fill=SAND, width=round(w))

    for deg in (start, end):
        a = math.radians(deg)
        ex, ey = cx + r * math.cos(a), cy + r * math.sin(a)
        draw.ellipse((ex - w / 2, ey - w / 2, ex + w / 2, ey + w / 2), fill=SAND)

    # The catalyst: a bold bolt rising through the ring's gap. Unit coordinates
    # (x right, y down) for the classic six-point zigzag, mapped onto the canvas.
    bolt_unit = [
        (0.62, 0.00),
        (0.18, 0.55),
        (0.45, 0.55),
        (0.30, 1.00),
        (0.82, 0.42),
        (0.55, 0.42),
    ]
    bolt_w, bolt_h = N * 0.42, N * 0.60
    bolt_cy = cy - N * 0.045
    bolt = [(cx + (x - 0.5) * bolt_w, bolt_cy + (y - 0.5) * bolt_h) for x, y in bolt_unit]

    # Knock the bolt out of the ring so both shapes stay legible where they cross.
    draw.polygon(scaled(bolt, 1.13), fill=(*NAVY_BOTTOM, 255))
    draw.polygon(bolt, fill=SAND_HI)

    icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask(N, round(N * 0.225)))

    return icon.resize((S, S), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    build().save(HERE / "icon.png")
    print(f"wrote {HERE / 'icon.png'}")
