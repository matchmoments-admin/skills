#!/usr/bin/env python3
"""
Render an Excalidraw .excalidraw JSON file to a PNG using Pillow.

Why Pillow and not Playwright/Excalidraw's own exporter?
  - No browser install, no node_modules, runs anywhere Python + Pillow does.
  - The deliverable is the .excalidraw file. The PNG is a *layout sanity check*
    used by the validation loop in excalidraw-diagram.md, so pixel-faithful
    hand-drawn rendering is unnecessary. We render clean shapes good enough to
    spot overlapping elements, off-canvas labels, missed arrow endpoints, and
    grid misalignment.

Supported element types: rectangle, ellipse, diamond, line, arrow, text, freedraw.
Stroke styles supported: solid, dashed, dotted. Roughness is ignored (we render clean).
Arrowheads supported: "arrow", "triangle", null/none.

Usage:
    python3 render_diagram.py path/to/file.excalidraw [--out path/to/out.png] [--scale 2]

Exit codes:
    0  rendered successfully
    1  bad JSON, no elements, or unrecoverable error
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write(
        "render_diagram.py requires Pillow. Install with: pip install Pillow\n"
    )
    sys.exit(1)


# ---------- font discovery ----------------------------------------------------

# Pillow's default bitmap font is unreadable at typical Excalidraw sizes (16+).
# Try a series of system fonts; fall back to default if none are present.
FONT_CANDIDATES_BY_FAMILY: dict[int, list[str]] = {
    # Excalidraw fontFamily codes:
    #   1 = Virgil (hand-drawn) — we approximate with a clean sans
    #   2 = Helvetica
    #   3 = Cascadia (mono)
    1: [
        "/System/Library/Fonts/Supplemental/Comic Sans MS.ttf",
        "/System/Library/Fonts/Supplemental/Bradley Hand.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ],
    2: [
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
    3: [
        "/System/Library/Fonts/Menlo.ttc",
        "/Library/Fonts/Courier New.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ],
}


def load_font(family: int, size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES_BY_FAMILY.get(family, FONT_CANDIDATES_BY_FAMILY[2]):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


# ---------- bounding-box pass --------------------------------------------------


def element_bbox(el: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """Return (xmin, ymin, xmax, ymax) in scene coords, or None to skip."""
    if el.get("isDeleted"):
        return None
    t = el.get("type")
    x = el.get("x", 0)
    y = el.get("y", 0)
    w = el.get("width", 0)
    h = el.get("height", 0)

    if t in ("rectangle", "ellipse", "diamond", "image", "frame", "magicframe", "iframe"):
        return (x, y, x + w, y + h)

    if t in ("arrow", "line", "freedraw"):
        pts = el.get("points") or [[0, 0]]
        xs = [x + p[0] for p in pts]
        ys = [y + p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))

    if t == "text":
        return (x, y, x + w, y + h)

    # Unknown — fall back to declared bbox if present.
    if w or h:
        return (x, y, x + w, y + h)
    return None


# ---------- rendering primitives ----------------------------------------------


def _resolve_color(value: str | None, fallback: str = "#000000") -> str:
    if not value or value == "transparent":
        return fallback
    return value


def _stroke_dash(style: str | None, width: float) -> list[int] | None:
    """Pillow has no native dash, so we synthesise dash patterns by drawing
    short segments along the line. Returned tuple is (dash_on, dash_off) px."""
    if style == "dashed":
        return [int(max(8, width * 4)), int(max(6, width * 3))]
    if style == "dotted":
        return [int(max(2, width)), int(max(4, width * 2))]
    return None


def _draw_dashed_line(
    draw: ImageDraw.ImageDraw,
    p0: tuple[float, float],
    p1: tuple[float, float],
    dash: list[int],
    color: str,
    width: int,
) -> None:
    x0, y0 = p0
    x1, y1 = p1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length == 0:
        return
    ux, uy = dx / length, dy / length
    on, off = dash
    drawn = 0.0
    pen_down = True
    while drawn < length:
        seg_len = on if pen_down else off
        end = min(drawn + seg_len, length)
        if pen_down:
            draw.line(
                [
                    (x0 + ux * drawn, y0 + uy * drawn),
                    (x0 + ux * end, y0 + uy * end),
                ],
                fill=color,
                width=width,
            )
        drawn = end
        pen_down = not pen_down


def draw_line_or_dash(
    draw: ImageDraw.ImageDraw,
    p0: tuple[float, float],
    p1: tuple[float, float],
    color: str,
    width: int,
    dash: list[int] | None,
) -> None:
    if dash:
        _draw_dashed_line(draw, p0, p1, dash, color, width)
    else:
        draw.line([p0, p1], fill=color, width=width)


def draw_rect(draw: ImageDraw.ImageDraw, el: dict[str, Any], scale: float, off: tuple[float, float]) -> None:
    x = (el["x"] + off[0]) * scale
    y = (el["y"] + off[1]) * scale
    w = el["width"] * scale
    h = el["height"] * scale
    stroke = _resolve_color(el.get("strokeColor"), "#1e1e1e")
    fill = el.get("backgroundColor") or "transparent"
    fill_color: str | None = None if fill == "transparent" else fill
    sw = max(1, int(round(el.get("strokeWidth", 1) * scale)))
    radius = el.get("roundness", {}).get("type") if isinstance(el.get("roundness"), dict) else None
    box = (x, y, x + w, y + h)
    if radius is not None:
        # Excalidraw uses ~12% corner radius with type=3 (the modern default).
        r = min(w, h) * 0.10
        if fill_color:
            draw.rounded_rectangle(box, radius=r, fill=fill_color, outline=stroke, width=sw)
        else:
            draw.rounded_rectangle(box, radius=r, outline=stroke, width=sw)
    else:
        if fill_color:
            draw.rectangle(box, fill=fill_color, outline=stroke, width=sw)
        else:
            draw.rectangle(box, outline=stroke, width=sw)


def draw_ellipse(draw: ImageDraw.ImageDraw, el: dict[str, Any], scale: float, off: tuple[float, float]) -> None:
    x = (el["x"] + off[0]) * scale
    y = (el["y"] + off[1]) * scale
    w = el["width"] * scale
    h = el["height"] * scale
    stroke = _resolve_color(el.get("strokeColor"), "#1e1e1e")
    fill = el.get("backgroundColor") or "transparent"
    fill_color: str | None = None if fill == "transparent" else fill
    sw = max(1, int(round(el.get("strokeWidth", 1) * scale)))
    box = (x, y, x + w, y + h)
    if fill_color:
        draw.ellipse(box, fill=fill_color, outline=stroke, width=sw)
    else:
        draw.ellipse(box, outline=stroke, width=sw)


def draw_diamond(draw: ImageDraw.ImageDraw, el: dict[str, Any], scale: float, off: tuple[float, float]) -> None:
    x = (el["x"] + off[0]) * scale
    y = (el["y"] + off[1]) * scale
    w = el["width"] * scale
    h = el["height"] * scale
    stroke = _resolve_color(el.get("strokeColor"), "#1e1e1e")
    fill = el.get("backgroundColor") or "transparent"
    fill_color: str | None = None if fill == "transparent" else fill
    sw = max(1, int(round(el.get("strokeWidth", 1) * scale)))
    cx, cy = x + w / 2, y + h / 2
    pts = [(cx, y), (x + w, cy), (cx, y + h), (x, cy)]
    if fill_color:
        draw.polygon(pts, fill=fill_color, outline=stroke)
        # Pillow polygon outline ignores width; redraw outline as lines.
        for i in range(4):
            draw.line([pts[i], pts[(i + 1) % 4]], fill=stroke, width=sw)
    else:
        for i in range(4):
            draw.line([pts[i], pts[(i + 1) % 4]], fill=stroke, width=sw)


def _arrowhead(
    draw: ImageDraw.ImageDraw,
    tip: tuple[float, float],
    direction_from: tuple[float, float],
    color: str,
    width: int,
    style: str,
) -> None:
    """Draw an arrowhead at `tip`, pointing away from `direction_from`."""
    dx = tip[0] - direction_from[0]
    dy = tip[1] - direction_from[1]
    length = math.hypot(dx, dy)
    if length < 1e-3:
        return
    ux, uy = dx / length, dy / length
    head_len = max(10.0, width * 4.0)
    angle = math.radians(28)
    # Two flank points.
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    bx = tip[0] - head_len * (ux * cos_a + uy * sin_a)
    by = tip[1] - head_len * (uy * cos_a - ux * sin_a)
    cx = tip[0] - head_len * (ux * cos_a - uy * sin_a)
    cy = tip[1] - head_len * (uy * cos_a + ux * sin_a)
    if style == "triangle":
        draw.polygon([tip, (bx, by), (cx, cy)], fill=color, outline=color)
    else:
        # Default "arrow": two flank lines.
        draw.line([(bx, by), tip], fill=color, width=width)
        draw.line([(cx, cy), tip], fill=color, width=width)


def draw_arrow_or_line(
    draw: ImageDraw.ImageDraw,
    el: dict[str, Any],
    scale: float,
    off: tuple[float, float],
) -> None:
    pts_rel = el.get("points") or []
    if len(pts_rel) < 2:
        return
    bx = el.get("x", 0) + off[0]
    by = el.get("y", 0) + off[1]
    pts = [((bx + p[0]) * scale, (by + p[1]) * scale) for p in pts_rel]
    color = _resolve_color(el.get("strokeColor"), "#1e1e1e")
    sw = max(1, int(round(el.get("strokeWidth", 1) * scale)))
    dash = _stroke_dash(el.get("strokeStyle"), el.get("strokeWidth", 1) * scale)
    for i in range(len(pts) - 1):
        draw_line_or_dash(draw, pts[i], pts[i + 1], color, sw, dash)
    if el.get("type") == "arrow":
        end_head = el.get("endArrowhead")
        start_head = el.get("startArrowhead")
        if end_head:
            _arrowhead(draw, pts[-1], pts[-2], color, sw, end_head)
        if start_head:
            _arrowhead(draw, pts[0], pts[1], color, sw, start_head)


def draw_freedraw(
    draw: ImageDraw.ImageDraw,
    el: dict[str, Any],
    scale: float,
    off: tuple[float, float],
) -> None:
    pts_rel = el.get("points") or []
    if len(pts_rel) < 2:
        return
    bx = el.get("x", 0) + off[0]
    by = el.get("y", 0) + off[1]
    pts = [((bx + p[0]) * scale, (by + p[1]) * scale) for p in pts_rel]
    color = _resolve_color(el.get("strokeColor"), "#1e1e1e")
    sw = max(1, int(round(el.get("strokeWidth", 1) * scale)))
    draw.line(pts, fill=color, width=sw, joint="curve")


def draw_text(
    draw: ImageDraw.ImageDraw,
    el: dict[str, Any],
    scale: float,
    off: tuple[float, float],
) -> None:
    text = el.get("text") or el.get("originalText") or ""
    if not text:
        return
    family = int(el.get("fontFamily", 2))
    size = int(round(el.get("fontSize", 20) * scale))
    font = load_font(family, size)
    color = _resolve_color(el.get("strokeColor"), "#1e1e1e")
    align = el.get("textAlign", "left")
    valign = el.get("verticalAlign", "top")

    box_x = (el["x"] + off[0]) * scale
    box_y = (el["y"] + off[1]) * scale
    box_w = el.get("width", 0) * scale
    box_h = el.get("height", 0) * scale

    lines = text.split("\n")

    # Use textbbox to measure and align line-by-line.
    line_heights = []
    line_widths = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        line_widths.append(bbox[2] - bbox[0])
        line_heights.append(bbox[3] - bbox[1])
    total_h = sum(line_heights) + (len(lines) - 1) * max(2, size // 6)

    # Vertical anchor.
    if valign == "middle":
        cur_y = box_y + (box_h - total_h) / 2
    elif valign == "bottom":
        cur_y = box_y + box_h - total_h
    else:
        cur_y = box_y

    for line, lw, lh in zip(lines, line_widths, line_heights):
        if align == "center":
            cur_x = box_x + (box_w - lw) / 2
        elif align == "right":
            cur_x = box_x + box_w - lw
        else:
            cur_x = box_x
        draw.text((cur_x, cur_y), line, font=font, fill=color)
        cur_y += lh + max(2, size // 6)


# ---------- top-level render --------------------------------------------------


def draw_image_placeholder(
    draw: ImageDraw.ImageDraw,
    el: dict[str, Any],
    scale: float,
    off: tuple[float, float],
) -> None:
    """Image elements carry base64-embedded data we don't decode (it'd be slow
    and unnecessary for layout validation). Draw a dashed placeholder rectangle
    with the file id so layout problems are visible."""
    x = (el["x"] + off[0]) * scale
    y = (el["y"] + off[1]) * scale
    w = el["width"] * scale
    h = el["height"] * scale
    box = (x, y, x + w, y + h)
    sw = max(1, int(round(2 * scale)))
    dash = [int(max(8, sw * 4)), int(max(6, sw * 3))]
    color = "#94a3b8"
    # Four dashed sides (Pillow has no native dashed rectangle).
    _draw_dashed_line(draw, (x, y), (x + w, y), dash, color, sw)
    _draw_dashed_line(draw, (x + w, y), (x + w, y + h), dash, color, sw)
    _draw_dashed_line(draw, (x + w, y + h), (x, y + h), dash, color, sw)
    _draw_dashed_line(draw, (x, y + h), (x, y), dash, color, sw)
    # Caption: type + truncated fileId.
    fid = (el.get("fileId") or "")[:8]
    caption = f"image · {fid}…" if fid else "image"
    font = load_font(2, max(12, int(14 * scale)))
    bbox = draw.textbbox((0, 0), caption, font=font)
    cw = bbox[2] - bbox[0]
    ch = bbox[3] - bbox[1]
    draw.text((x + (w - cw) / 2, y + (h - ch) / 2), caption, font=font, fill=color)


DRAW_DISPATCH = {
    "rectangle": draw_rect,
    "ellipse": draw_ellipse,
    "diamond": draw_diamond,
    "arrow": draw_arrow_or_line,
    "line": draw_arrow_or_line,
    "freedraw": draw_freedraw,
    "text": draw_text,
    "image": draw_image_placeholder,
}


def render(doc: dict[str, Any], scale: float = 2.0, margin: int = 60) -> Image.Image:
    elements = [e for e in doc.get("elements", []) if not e.get("isDeleted")]
    if not elements:
        raise ValueError("Excalidraw file has no elements to render.")

    # Compute scene bounding box.
    boxes = [b for b in (element_bbox(e) for e in elements) if b is not None]
    if not boxes:
        raise ValueError("No renderable elements with a bounding box.")
    xmin = min(b[0] for b in boxes)
    ymin = min(b[1] for b in boxes)
    xmax = max(b[2] for b in boxes)
    ymax = max(b[3] for b in boxes)

    # Translate scene so (xmin, ymin) → (margin, margin) in screen coords.
    off = (margin / scale - xmin, margin / scale - ymin)
    width_px = int(math.ceil((xmax - xmin) * scale + 2 * margin))
    height_px = int(math.ceil((ymax - ymin) * scale + 2 * margin))
    width_px = max(width_px, 200)
    height_px = max(height_px, 200)

    bg = doc.get("appState", {}).get("viewBackgroundColor") or "#ffffff"
    img = Image.new("RGB", (width_px, height_px), bg)
    draw = ImageDraw.Draw(img)

    # Render shapes first, then overlay text and arrows so labels and edges
    # always sit on top of fills (matches Excalidraw's z-order convention for
    # most diagrams without explicit z manipulation).
    z_order = {"rectangle": 0, "ellipse": 0, "diamond": 0, "image": 1, "freedraw": 1, "line": 2, "arrow": 2, "text": 3}
    elements_sorted = sorted(elements, key=lambda e: z_order.get(e.get("type", ""), 4))

    for el in elements_sorted:
        t = el.get("type")
        fn = DRAW_DISPATCH.get(t)
        if not fn:
            continue
        try:
            fn(draw, el, scale, off)
        except Exception as exc:  # render one bad element shouldn't kill the whole image
            sys.stderr.write(f"warn: failed to render element id={el.get('id')} type={t}: {exc}\n")

    return img


def main() -> int:
    parser = argparse.ArgumentParser(description="Render an Excalidraw JSON file to PNG (Pillow-based).")
    parser.add_argument("input", help="path to .excalidraw file")
    parser.add_argument("--out", help="output PNG path (default: <input>.png)")
    parser.add_argument("--scale", type=float, default=2.0, help="render scale (default 2.0 for retina-ish)")
    parser.add_argument("--margin", type=int, default=60, help="margin in screen px (default 60)")
    args = parser.parse_args()

    try:
        with open(args.input, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"error: could not read {args.input}: {exc}\n")
        return 1

    try:
        img = render(doc, scale=args.scale, margin=args.margin)
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1

    out = args.out or os.path.splitext(args.input)[0] + ".png"
    img.save(out, "PNG", optimize=True)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
