#!/usr/bin/env python3
"""
Compose an .excalidraw file from a spec describing illustrations, arrows, and text.

The skill agent generates a spec.json describing what to put on the canvas; this
helper does the boring base64 packaging and Excalidraw-JSON assembly so the agent
doesn't have to emit megabytes of base64 inline.

Spec format (see workflow.md for the full discussion):

    {
      "output": "/abs/path/output.excalidraw",
      "background": "#ffffff",                    # optional — defaults to white
      "title": "Optional diagram title",          # optional — rendered as large text at top
      "title_color": "#001f3f",                   # optional — defaults to #1e1e1e
      "elements": [
        {
          "kind": "image",
          "id": "seg-1",
          "image_path": "/path/to/png",
          "x": 100, "y": 100, "width": 320, "height": 320,
          "label": "User receives SMS",            # optional — auto-creates a centered text below
          "label_color": "#001f3f"                 # optional — defaults to #1e1e1e
        },
        {
          "kind": "arrow",
          "from": [420, 260], "to": [540, 260],
          "label": "submit",                        # optional — text near midpoint
          "color": "#008a98",                       # optional — defaults to #1e1e1e
          "stroke_width": 2,                        # optional — defaults to 2
          "stroke_style": "solid"                   # optional — solid|dashed|dotted
        },
        {
          "kind": "text",
          "x": 100, "y": 60,
          "text": "Step 1: Intake",
          "fontSize": 24,                           # optional — defaults to 20
          "fontFamily": 1,                          # optional — defaults to 1 (hand-drawn)
          "color": "#001f3f"                        # optional — defaults to #1e1e1e
        }
      ]
    }

Usage:
    python3 compose_excalidraw.py path/to/spec.json

Exit codes:
    0  wrote output successfully
    1  bad spec, missing image, IO error
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import sys
import time
from typing import Any


# ---------- helpers -----------------------------------------------------------


def _file_id_for(content: bytes) -> str:
    """Excalidraw image fileIds are 40-char hex strings (SHA-1 of content works,
    and gives us natural deduplication when the same illustration appears twice)."""
    return hashlib.sha1(content).hexdigest()


def _data_url(path: str, content: bytes) -> tuple[str, str]:
    mime, _ = mimetypes.guess_type(path)
    if mime is None or not mime.startswith("image/"):
        mime = "image/png"
    encoded = base64.b64encode(content).decode("ascii")
    return mime, f"data:{mime};base64,{encoded}"


def _next_seed() -> int:
    """Excalidraw uses a per-element seed to drive deterministic rough rendering.
    We don't need stability across runs, so a monotonically increasing counter is fine."""
    _next_seed.counter = getattr(_next_seed, "counter", 100) + 1
    return _next_seed.counter


def _now_ms() -> int:
    return int(time.time() * 1000)


def _common_fields(el_id: str, el_type: str, x: float, y: float, width: float, height: float) -> dict[str, Any]:
    """Boilerplate every Excalidraw element needs."""
    return {
        "id": el_id,
        "type": el_type,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "seed": _next_seed(),
        "version": 1,
        "versionNonce": _next_seed() * 13,
        "isDeleted": False,
        "boundElements": None,
        "updated": _now_ms(),
        "link": None,
        "locked": False,
    }


# ---------- builders for each spec kind ---------------------------------------


def build_image_element(
    spec_el: dict[str, Any],
    files_map: dict[str, dict[str, Any]],
    extra_elements: list[dict[str, Any]],
) -> dict[str, Any]:
    """Return the image element. Side effects: populate files_map, append a label
    text element to extra_elements if `label` is set."""
    img_path = spec_el["image_path"]
    if not os.path.exists(img_path):
        raise FileNotFoundError(f"image not found: {img_path}")
    with open(img_path, "rb") as f:
        content = f.read()

    file_id = _file_id_for(content)
    mime, data_url = _data_url(img_path, content)
    if file_id not in files_map:
        files_map[file_id] = {
            "mimeType": mime,
            "id": file_id,
            "dataURL": data_url,
            "created": _now_ms(),
            "lastRetrieved": _now_ms(),
        }

    el_id = spec_el.get("id") or f"img-{file_id[:8]}"
    x = float(spec_el["x"])
    y = float(spec_el["y"])
    w = float(spec_el["width"])
    h = float(spec_el["height"])

    image_el = _common_fields(el_id, "image", x, y, w, h)
    image_el.update({
        "fileId": file_id,
        "scale": [1, 1],
        "status": "saved",
        "crop": None,
    })

    label = spec_el.get("label")
    if label:
        # Auto-place a centered text element ~16px below the image.
        font_size = int(spec_el.get("label_font_size", 18))
        label_color = spec_el.get("label_color", "#1e1e1e")
        text_el = _common_fields(f"{el_id}-label", "text", x, y + h + 16, w, font_size * 1.4)
        text_el.update({
            "strokeColor": label_color,
            "fillStyle": "solid",
            "text": label,
            "originalText": label,
            "fontSize": font_size,
            "fontFamily": 1,
            "textAlign": "center",
            "verticalAlign": "top",
            "containerId": None,
            "lineHeight": 1.25,
            "baseline": int(font_size * 0.85),
        })
        extra_elements.append(text_el)

    return image_el


def build_arrow_element(spec_el: dict[str, Any], extra_elements: list[dict[str, Any]]) -> dict[str, Any]:
    fx, fy = spec_el["from"]
    tx, ty = spec_el["to"]
    fx, fy, tx, ty = float(fx), float(fy), float(tx), float(ty)

    el_id = spec_el.get("id") or f"arrow-{_next_seed()}"
    width = abs(tx - fx)
    height = abs(ty - fy)

    arrow_el = _common_fields(el_id, "arrow", fx, fy, width, height)
    arrow_el.update({
        "strokeColor": spec_el.get("color", "#1e1e1e"),
        "strokeWidth": int(spec_el.get("stroke_width", 2)),
        "strokeStyle": spec_el.get("stroke_style", "solid"),
        "points": [[0, 0], [tx - fx, ty - fy]],
        "lastCommittedPoint": None,
        "startBinding": None,
        "endBinding": None,
        "startArrowhead": spec_el.get("start_arrowhead"),  # None unless caller asks
        "endArrowhead": spec_el.get("end_arrowhead", "arrow"),
        "elbowed": False,
    })

    label = spec_el.get("label")
    if label:
        # Place label at midpoint, slightly above the line.
        mx = (fx + tx) / 2
        my = (fy + ty) / 2
        font_size = int(spec_el.get("label_font_size", 14))
        # Estimate text width crudely.
        text_w = max(40, len(label) * font_size * 0.55)
        text_h = int(font_size * 1.4)
        text_el = _common_fields(
            f"{el_id}-label",
            "text",
            mx - text_w / 2,
            my - text_h - 6,
            text_w,
            text_h,
        )
        text_el.update({
            "strokeColor": spec_el.get("label_color", spec_el.get("color", "#1e1e1e")),
            "fillStyle": "solid",
            "text": label,
            "originalText": label,
            "fontSize": font_size,
            "fontFamily": 1,
            "textAlign": "center",
            "verticalAlign": "middle",
            "containerId": None,
            "lineHeight": 1.25,
            "baseline": int(font_size * 0.85),
        })
        extra_elements.append(text_el)

    return arrow_el


def build_text_element(spec_el: dict[str, Any]) -> dict[str, Any]:
    text = spec_el["text"]
    font_size = int(spec_el.get("fontSize", 20))
    font_family = int(spec_el.get("fontFamily", 1))
    color = spec_el.get("color", "#1e1e1e")
    align = spec_el.get("textAlign", "left")

    # Estimate width/height if not given.
    lines = text.split("\n")
    longest = max((len(line) for line in lines), default=0)
    est_w = float(spec_el.get("width", max(20, longest * font_size * 0.55)))
    est_h = float(spec_el.get("height", len(lines) * font_size * 1.4))

    el_id = spec_el.get("id") or f"text-{_next_seed()}"
    x = float(spec_el["x"])
    y = float(spec_el["y"])

    text_el = _common_fields(el_id, "text", x, y, est_w, est_h)
    text_el.update({
        "strokeColor": color,
        "fillStyle": "solid",
        "text": text,
        "originalText": text,
        "fontSize": font_size,
        "fontFamily": font_family,
        "textAlign": align,
        "verticalAlign": spec_el.get("verticalAlign", "top"),
        "containerId": None,
        "lineHeight": 1.25,
        "baseline": int(font_size * 0.85),
    })
    return text_el


# ---------- top-level ---------------------------------------------------------


def compose(spec: dict[str, Any]) -> dict[str, Any]:
    files_map: dict[str, dict[str, Any]] = {}
    elements: list[dict[str, Any]] = []
    extras: list[dict[str, Any]] = []  # auto-generated labels go here so they sit on top

    # Optional title at the top.
    title = spec.get("title")
    if title:
        elements.append(build_text_element({
            "x": float(spec.get("title_x", 100)),
            "y": float(spec.get("title_y", 40)),
            "text": title,
            "fontSize": int(spec.get("title_font_size", 32)),
            "fontFamily": int(spec.get("title_font_family", 1)),
            "color": spec.get("title_color", "#1e1e1e"),
            "id": "title",
        }))

    for el in spec.get("elements", []):
        kind = el.get("kind")
        try:
            if kind == "image":
                elements.append(build_image_element(el, files_map, extras))
            elif kind == "arrow":
                elements.append(build_arrow_element(el, extras))
            elif kind == "text":
                elements.append(build_text_element(el))
            else:
                sys.stderr.write(f"warn: unknown spec kind '{kind}', skipping\n")
        except (KeyError, FileNotFoundError, ValueError) as exc:
            sys.stderr.write(f"warn: failed to build element {el.get('id', '?')}: {exc}\n")

    # Append auto-generated labels last so they render on top of fills/arrows.
    elements.extend(extras)

    return {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": elements,
        "appState": {
            "viewBackgroundColor": spec.get("background", "#ffffff"),
            "gridSize": None,
        },
        "files": files_map,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compose .excalidraw from a spec JSON.")
    parser.add_argument("spec", help="path to spec.json")
    args = parser.parse_args()

    try:
        with open(args.spec, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"error: could not read spec {args.spec}: {exc}\n")
        return 1

    output = spec.get("output")
    if not output:
        sys.stderr.write("error: spec is missing required 'output' field\n")
        return 1

    output = os.path.abspath(os.path.expanduser(output))
    os.makedirs(os.path.dirname(output), exist_ok=True)

    try:
        doc = compose(spec)
    except Exception as exc:
        sys.stderr.write(f"error: compose failed: {exc}\n")
        return 1

    with open(output, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)

    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
