#!/usr/bin/env python3
"""
Validate the skills repo:
- Each persona has YAML frontmatter matching the schema (4D tone, writing stats, do/dont/etc.)
- All JSON files parse
- No project-specific strings leaked into anything (Ask Arthur, safeverify, /Users/ paths, etc.)
- Internal markdown links to files in the skills tree resolve

Usage:
    python3 scripts/validate_skills.py
    python3 scripts/validate_skills.py --strict   # warnings become errors
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
SKILLS = REPO / "skills"

# Strings that should never appear in a project-agnostic public skills repo.
LEAKED_STRINGS = [
    "/Users/brendanmilton",
    "safeverify",
    "askarthur.au",
    "rquomhcgnodxzkhokwni",  # project-specific Supabase ID
]
# We'll exempt this README's own attribution, plus the LICENSE.
EXEMPT_FROM_LEAK_CHECK = {
    REPO / "README.md",
    REPO / "LICENSE",
}

# Persona schema — required keys at the top level of YAML frontmatter.
PERSONA_REQUIRED_KEYS = {
    "name",
    "description",
    "tone",
    "writing",
    "do",
    "dont",
    "signature_moves",
    "forbidden_phrases",
}
PERSONA_TONE_DIMS = {
    "funny_serious",
    "formal_casual",
    "respectful_irreverent",
    "enthusiastic_matter_of_fact",
}
PERSONA_WRITING_KEYS = {
    "vocabulary_tier",
    "sentence_length_mean",
    "sentence_length_std",
    "contraction_frequency",
    "max_passive_voice_pct",
    "reading_grade_target",
}


def parse_yaml_frontmatter(text: str) -> dict[str, Any] | None:
    """Hand-roll a tiny YAML parser sufficient for our persona schema.
    Avoids requiring PyYAML at install time — keeps validation runnable in CI
    with a stock python image."""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    body = text[3:end].strip()
    return _parse_yaml_block(body)


def _parse_yaml_block(text: str) -> dict[str, Any]:
    """Minimal YAML parser: scalars, nested maps (single level), lists of strings,
    floats, ints. Sufficient for persona frontmatter. NOT a general YAML parser."""
    result: dict[str, Any] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        # Top-level key: value
        if not line.startswith(" ") and ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if not val:
                # Either nested map or list follows.
                # Look ahead.
                nested_lines: list[str] = []
                j = i + 1
                while j < len(lines):
                    nl = lines[j]
                    if nl.startswith(" ") or not nl.strip():
                        nested_lines.append(nl)
                        j += 1
                    else:
                        break
                # List of dashed items?
                stripped = [ln.lstrip() for ln in nested_lines if ln.strip()]
                if stripped and stripped[0].startswith("- "):
                    # List of strings.
                    items = []
                    for ln in stripped:
                        if ln.startswith("- "):
                            v = ln[2:].strip()
                            # Strip surrounding quotes.
                            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                                v = v[1:-1]
                            items.append(v)
                    result[key] = items
                else:
                    # Nested map.
                    nested_text = "\n".join(ln[2:] if ln.startswith("  ") else ln.lstrip()
                                              for ln in nested_lines if ln.strip())
                    result[key] = _parse_yaml_block(nested_text)
                i = j
                continue
            else:
                result[key] = _coerce_scalar(val)
                i += 1
                continue
        i += 1
    return result


def _coerce_scalar(s: str) -> Any:
    s = s.strip()
    if not s:
        return ""
    # List inline: [a, b, c]
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        items = [x.strip() for x in inner.split(",")]
        return [_coerce_scalar(x) for x in items]
    # Quoted string
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    # Numeric
    try:
        if "." in s:
            return float(s)
        return int(s)
    except ValueError:
        pass
    return s


# ---------- checks ------------------------------------------------------------


def check_persona(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    fm = parse_yaml_frontmatter(text)
    if fm is None:
        return [f"{path}: missing YAML frontmatter"]

    missing = PERSONA_REQUIRED_KEYS - fm.keys()
    if missing:
        errors.append(f"{path}: missing top-level keys: {sorted(missing)}")

    tone = fm.get("tone")
    if not isinstance(tone, dict):
        errors.append(f"{path}: 'tone' must be a map, got {type(tone).__name__}")
    else:
        missing_dims = PERSONA_TONE_DIMS - tone.keys()
        if missing_dims:
            errors.append(f"{path}: tone missing dimensions: {sorted(missing_dims)}")
        for dim in PERSONA_TONE_DIMS & tone.keys():
            v = tone[dim]
            if not isinstance(v, (int, float)) or not (0.0 <= v <= 1.0):
                errors.append(f"{path}: tone.{dim} must be number 0.0–1.0, got {v!r}")

    writing = fm.get("writing")
    if not isinstance(writing, dict):
        errors.append(f"{path}: 'writing' must be a map, got {type(writing).__name__}")
    else:
        missing_w = PERSONA_WRITING_KEYS - writing.keys()
        if missing_w:
            errors.append(f"{path}: writing missing keys: {sorted(missing_w)}")

    for list_key in ("do", "dont", "signature_moves", "forbidden_phrases"):
        v = fm.get(list_key)
        if v is not None and not isinstance(v, list):
            errors.append(f"{path}: '{list_key}' must be a list, got {type(v).__name__}")

    return errors


def check_json(path: Path) -> list[str]:
    try:
        with path.open(encoding="utf-8") as f:
            json.load(f)
    except json.JSONDecodeError as e:
        return [f"{path}: invalid JSON: {e}"]
    return []


def check_no_leaks(path: Path) -> list[str]:
    if path in EXEMPT_FROM_LEAK_CHECK:
        return []
    text = path.read_text(encoding="utf-8")
    found = []
    for needle in LEAKED_STRINGS:
        if needle in text:
            # Find the line.
            for lineno, line in enumerate(text.splitlines(), 1):
                if needle in line:
                    found.append(f"{path}:{lineno}: contains '{needle}': {line.strip()[:80]}")
                    break
    return found


PLACEHOLDER_TARGETS = {"url", "src", "path", "link", "anchor", "href"}


def check_internal_links(path: Path) -> list[str]:
    """Check that <relative path> markdown links resolve. Skips http(s) links
    and obvious placeholders that appear in instructional examples (e.g.
    `[anchor text](url)` is showing the pattern, not pointing to a real file)."""
    text = path.read_text(encoding="utf-8")
    errors = []
    for match in re.finditer(r"\]\(([^)]+)\)", text):
        target = match.group(1).split("#")[0].strip()
        if not target or target.startswith(("http://", "https://", "mailto:", "/", "#")):
            continue
        # ~/ paths point outside the repo by design.
        if target.startswith("~"):
            continue
        # Placeholders in instructional examples — bare words with no path char.
        if target.lower() in PLACEHOLDER_TARGETS:
            continue
        # Anything that doesn't look like a path at all (no slash, no dot) is
        # almost certainly a placeholder. Real links have at least one of those.
        if "/" not in target and "." not in target:
            continue
        resolved = (path.parent / target).resolve()
        if not resolved.exists():
            errors.append(f"{path}: broken link → {target}")
    return errors


# ---------- main --------------------------------------------------------------


def main() -> int:
    strict = "--strict" in sys.argv

    all_errors: list[str] = []

    md_files = sorted(SKILLS.rglob("*.md"))
    json_files = sorted(SKILLS.rglob("*.json"))
    persona_files = sorted((SKILLS / "blog" / "personas").glob("*.md")) if (SKILLS / "blog" / "personas").exists() else []

    print(f"Validating skills under {SKILLS}")
    print(f"  {len(md_files)} markdown files")
    print(f"  {len(json_files)} JSON files")
    print(f"  {len(persona_files)} persona files")
    print()

    print("→ JSON parse check")
    for f in json_files:
        all_errors += check_json(f)

    print("→ persona schema check")
    for f in persona_files:
        all_errors += check_persona(f)

    print("→ no-leaks check (project-specific strings)")
    for f in md_files + json_files:
        all_errors += check_no_leaks(f)
    # Also check the orchestrator-level files at REPO root.
    for f in [REPO / "README.md", REPO / "LICENSE"]:
        # README + LICENSE are exempt.
        pass

    print("→ internal-link check (vendored upstream skills exempt: their docs carry example links)")
    upstream_list = SKILLS / ".upstream-skills"
    vendored = set(upstream_list.read_text().split()) if upstream_list.exists() else set()
    for f in md_files:
        if f.relative_to(SKILLS).parts[0] in vendored:
            continue
        all_errors += check_internal_links(f)

    if all_errors:
        print()
        print(f"✗ {len(all_errors)} issue(s):")
        for e in all_errors:
            print(f"  {e}")
        return 1

    print()
    print("✓ all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
