"""Per-platform metadata scaffolding for a clip-pack.

This writes the *fields and the limits*, not the copy. Hooks and titles come
from moments.json, and writing platform copy properly is a different skill's
job — cramming a hook-writer in here would duplicate `video-moments` and blur a
scope line both skills currently keep clean.

The limits below are a snapshot and platforms move them. They are data, in one
table, so correcting one is a one-line change — and `checked` records when each
was last confirmed so a stale number is visible rather than assumed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

LIMITS_CHECKED = "2026-08"


@dataclass(frozen=True)
class Platform:
    key: str
    name: str
    max_seconds: int
    caption_chars: int
    hashtags: int
    title_chars: int | None = None
    notes: str = ""


PLATFORMS: dict[str, Platform] = {
    "tiktok": Platform(
        "tiktok", "TikTok", max_seconds=600, caption_chars=2200, hashtags=5),
    "instagram-reels": Platform(
        "instagram-reels", "Instagram Reels", max_seconds=900,
        caption_chars=2200, hashtags=10,
        notes="Business account linked to a Facebook Page is required to "
              "publish via the API."),
    "youtube-shorts": Platform(
        "youtube-shorts", "YouTube Shorts", max_seconds=180,
        caption_chars=5000, hashtags=15, title_chars=100,
        notes="Vertical, and #Shorts in the title or description."),
    "linkedin": Platform(
        "linkedin", "LinkedIn", max_seconds=600, caption_chars=3000,
        hashtags=5),
    "x": Platform(
        "x", "X", max_seconds=140, caption_chars=280, hashtags=2),
}

# A Short over this length carrying a Content ID claim is blocked globally —
# it will not play at all, which is a harsher outcome than demonetisation.
CONTENT_ID_SAFE_SECONDS = 60


def truncate_words(text: str, limit: int) -> str:
    """Cut at a word boundary, never mid-word, and never mid-URL."""
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,;:—-")


def hashtags_for(moment: dict, platform: Platform) -> list[str]:
    """Derive tags from the chapter and title. Deliberately conservative —
    invented hashtags are the fastest way to look automated."""
    words: list[str] = []
    for field in ("chapter", "title"):
        value = moment.get(field)
        if isinstance(value, str):
            words += re.findall(r"[A-Za-z][A-Za-z0-9']{3,}", value)
    seen, tags = set(), []
    for w in words:
        tag = "#" + w.lower()
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags[: platform.hashtags]


def platform_metadata(moment: dict, source: dict, rights: str,
                      platform: Platform) -> dict:
    """One platform's fields for one moment. Pure."""
    duration = float(moment.get("end", 0)) - float(moment.get("start", 0))
    hook = (moment.get("hook") or "").strip()
    title = (moment.get("title") or hook or "").strip()
    channel = source.get("channel") or ""
    url = source.get("url") or ""

    body_parts = [hook]
    if channel:
        body_parts.append(f"From {channel}." if not url
                          else f"From {channel} — {url}")
    body = "\n\n".join(p for p in body_parts if p)
    tags = hashtags_for(moment, platform)
    caption_full = "\n\n".join(x for x in (body, " ".join(tags)) if x).strip()
    caption = truncate_words(caption_full, platform.caption_chars)

    fits = duration <= platform.max_seconds
    reasons = []
    if not fits:
        reasons.append(f"{duration:.0f}s exceeds {platform.name}'s "
                       f"{platform.max_seconds}s limit")

    publishable = rights in ("owned", "licensed")
    if not publishable:
        reasons.append(
            f"rights={rights!r}: this is not your content to republish. "
            f"Reused-content policy makes it ineligible for monetisation, and "
            f"the rights holder can issue a copyright strike.")
    elif rights == "licensed":
        reasons.append("licensed content — confirm the licence covers "
                       "short-form redistribution before posting")

    out = {
        "platform": platform.key,
        "limits_checked": LIMITS_CHECKED,
        "duration_seconds": round(duration, 2),
        "max_seconds": platform.max_seconds,
        "fits": fits,
        "publishable": publishable,
        "caption": caption,
        "caption_truncated": caption != caption_full,
        "caption_full": caption_full if caption != caption_full else None,
        "hashtags": tags,
        "notes": [r for r in reasons if r],
    }
    if platform.title_chars:
        out["title"] = truncate_words(title, platform.title_chars)
    if platform.notes:
        out["notes"].append(platform.notes)
    if rights == "third-party" and duration > CONTENT_ID_SAFE_SECONDS:
        out["notes"].append(
            f"over {CONTENT_ID_SAFE_SECONDS}s: a Short carrying a Content ID "
            f"claim at this length is blocked globally, not just demonetised")
    return out


def build_metadata(moment: dict, source: dict, rights: str,
                   keys: list[str] | None = None) -> dict[str, dict]:
    """Metadata for every requested platform."""
    chosen = keys or list(PLATFORMS)
    unknown = [k for k in chosen if k not in PLATFORMS]
    if unknown:
        raise ValueError(f"unknown platform(s): {', '.join(unknown)}. "
                         f"Known: {', '.join(sorted(PLATFORMS))}")
    return {k: platform_metadata(moment, source, rights, PLATFORMS[k])
            for k in chosen}


def slugify(text: str, limit: int = 48) -> str:
    """A filesystem-safe directory name for a clip."""
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    if len(slug) > limit:
        slug = slug[:limit].rsplit("-", 1)[0]
    return slug or "clip"
