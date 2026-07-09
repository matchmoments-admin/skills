#!/usr/bin/env python3
"""
audit_metrics.py — deterministic metric extractor for the blog skill's audit.

Replaces LLM-estimated values for: burstiness, sentence-length mean/std,
type-token ratio, AI-phrase density, paragraph-length distribution,
contraction frequency, Flesch-Kincaid reading grade, persona forbidden-phrase
hits.

Pure stdlib. Reads markdown / MDX / HTML.

Usage:
    python3 audit_metrics.py <article-path>
    python3 audit_metrics.py <article-path> --persona <name>
    python3 audit_metrics.py <article-path> --scrubber <path-to-json>

Output: JSON to stdout. Errors to stderr, exit code 2.
"""

import argparse
import json
import os
import re
import statistics
import sys
from typing import Optional


CODE_FENCE_RE = re.compile(r"^```[\w-]*\n.*?\n```", re.MULTILINE | re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
FRONT_MATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)
HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$", re.MULTILINE)
HTML_TAG_RE = re.compile(r"<[^>]+>")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
IMG_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
URL_RE = re.compile(r"https?://\S+")


def strip_markdown(text: str) -> str:
    text = FRONT_MATTER_RE.sub("", text, count=1)
    text = CODE_FENCE_RE.sub("", text)
    text = INLINE_CODE_RE.sub(" ", text)
    text = IMG_RE.sub(r"\1", text)
    text = LINK_RE.sub(r"\1", text)
    text = URL_RE.sub("", text)
    text = HTML_TAG_RE.sub("", text)
    text = HEADING_RE.sub(r"\1", text)
    return text


# Common abbreviations to skip when sentence-splitting. Not exhaustive but
# covers the cases that show up in technical / journalistic prose.
ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
    "etc", "vs", "vol", "no", "fig", "e.g", "i.e",
    "u.s", "u.k", "u.s.a", "ph.d", "m.d", "b.a", "m.a",
    "inc", "ltd", "corp", "co",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug",
    "sep", "sept", "oct", "nov", "dec",
}

SENTENCE_END_RE = re.compile(r"([.!?])\s+(?=[A-Z])")
WORD_RE = re.compile(r"\b[A-Za-z][A-Za-z'-]*\b")
PARAGRAPH_SEP_RE = re.compile(r"\n{2,}")


def split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    parts = SENTENCE_END_RE.split(text)
    sentences: list[str] = []
    buf = ""
    i = 0
    while i < len(parts):
        chunk = parts[i]
        if i + 1 < len(parts):
            terminator = parts[i + 1]
            buf += chunk + terminator
            last_word = re.search(r"\b([A-Za-z.]+)\.$", buf)
            if last_word and last_word.group(1).lower().rstrip(".") in ABBREVIATIONS:
                buf += " "
                i += 2
                continue
            sentences.append(buf.strip())
            buf = ""
            i += 2
        else:
            buf += chunk
            i += 1
    if buf.strip():
        sentences.append(buf.strip())
    return [s for s in sentences if s]


def words(text: str) -> list[str]:
    return WORD_RE.findall(text)


def paragraphs(text: str) -> list[str]:
    return [p.strip() for p in PARAGRAPH_SEP_RE.split(text) if p.strip()]


def sentence_length_stats(text: str) -> tuple[float, float]:
    sentences = split_sentences(text)
    lengths = [len(words(s)) for s in sentences if words(s)]
    if not lengths:
        return 0.0, 0.0
    mean = statistics.mean(lengths)
    std = statistics.stdev(lengths) if len(lengths) > 1 else 0.0
    return mean, std


def type_token_ratio(text: str) -> float:
    toks = [w.lower() for w in words(text)]
    if not toks:
        return 0.0
    return len(set(toks)) / len(toks)


def load_scrubber_phrases(scrubber_path: str) -> list[str]:
    if not os.path.exists(scrubber_path):
        return []
    with open(scrubber_path) as f:
        data = json.load(f)
    phrases: list[str] = []
    for key, val in data.items():
        if key.startswith("$") or not isinstance(val, list):
            continue
        for entry in val:
            phrase = entry.get("phrase", "")
            if phrase:
                phrases.append(phrase)
    return phrases


def ai_phrase_hits(text: str, scrubber_path: str) -> tuple[int, list[dict]]:
    phrases = load_scrubber_phrases(scrubber_path)
    if not phrases:
        return 0, []
    lower = text.lower()
    hits: list[dict] = []
    for phrase in phrases:
        if " " in phrase or "-" in phrase:
            pattern = re.escape(phrase.lower())
        else:
            pattern = r"\b" + re.escape(phrase.lower()) + r"\b"
        for m in re.finditer(pattern, lower):
            hits.append({"phrase": phrase, "position": m.start()})
    return len(hits), hits


def paragraph_length_distribution(text: str) -> tuple[list[int], int, int]:
    paras = paragraphs(text)
    lens = [len(words(p)) for p in paras]
    over_150 = sum(1 for length in lens if length > 150)
    return lens, max(lens) if lens else 0, over_150


# Pairs of (expanded-form regex, contracted-form regex). Used to compute the
# contraction frequency = contracted / (contracted + expanded).
EXPANDED_PAIRS = [
    (r"\bdo not\b", r"\bdon'?t\b"),
    (r"\bdoes not\b", r"\bdoesn'?t\b"),
    (r"\bdid not\b", r"\bdidn'?t\b"),
    (r"\bcan not\b|\bcannot\b", r"\bcan'?t\b"),
    (r"\bwill not\b", r"\bwon'?t\b"),
    (r"\bis not\b", r"\bisn'?t\b"),
    (r"\bare not\b", r"\baren'?t\b"),
    (r"\bwas not\b", r"\bwasn'?t\b"),
    (r"\bwere not\b", r"\bweren'?t\b"),
    (r"\bhave not\b", r"\bhaven'?t\b"),
    (r"\bhas not\b", r"\bhasn'?t\b"),
    (r"\bhad not\b", r"\bhadn'?t\b"),
    (r"\bwould not\b", r"\bwouldn'?t\b"),
    (r"\bshould not\b", r"\bshouldn'?t\b"),
    (r"\bcould not\b", r"\bcouldn'?t\b"),
    (r"\bI am\b", r"\bI'?m\b"),
    (r"\byou are\b", r"\byou'?re\b"),
    (r"\bwe are\b", r"\bwe'?re\b"),
    (r"\bthey are\b", r"\bthey'?re\b"),
    (r"\bI will\b", r"\bI'?ll\b"),
    (r"\byou will\b", r"\byou'?ll\b"),
    (r"\bI have\b", r"\bI'?ve\b"),
    (r"\byou have\b", r"\byou'?ve\b"),
    (r"\bwe have\b", r"\bwe'?ve\b"),
    (r"\bthey have\b", r"\bthey'?ve\b"),
    (r"\bit is\b", r"\bit'?s\b"),
    (r"\bthat is\b", r"\bthat'?s\b"),
    (r"\bthere is\b", r"\bthere'?s\b"),
    (r"\bwhat is\b", r"\bwhat'?s\b"),
    (r"\blet us\b", r"\blet'?s\b"),
]


def contraction_frequency(text: str) -> float:
    expanded = 0
    contracted = 0
    for exp_pat, con_pat in EXPANDED_PAIRS:
        expanded += len(re.findall(exp_pat, text, re.IGNORECASE))
        contracted += len(re.findall(con_pat, text, re.IGNORECASE))
    total = expanded + contracted
    return contracted / total if total else 0.0


def count_syllables(word: str) -> int:
    word = word.lower()
    if len(word) <= 3:
        return 1
    word = re.sub(r"e\b", "", word)
    word = re.sub(r"ed\b", "d", word)
    vowel_groups = re.findall(r"[aeiouy]+", word)
    return max(1, len(vowel_groups))


def reading_grade(text: str) -> float:
    sentences = split_sentences(text)
    word_list = words(text)
    if not sentences or not word_list:
        return 0.0
    syllables = sum(count_syllables(w) for w in word_list)
    asl = len(word_list) / len(sentences)
    asw = syllables / len(word_list)
    grade = 0.39 * asl + 11.8 * asw - 15.59
    return round(grade, 2)


def forbidden_phrase_hits(
    text: str, persona_path: Optional[str]
) -> tuple[int, list[str]]:
    if not persona_path or not os.path.exists(persona_path):
        return 0, []
    with open(persona_path) as f:
        content = f.read()
    m = re.search(
        r"^forbidden_phrases:\s*\n((?:\s*-\s*.+\n)+)", content, re.MULTILINE
    )
    if not m:
        return 0, []
    block = m.group(1)
    phrases = [
        line.strip().lstrip("-").strip().strip('"').strip("'")
        for line in block.splitlines()
        if line.strip().startswith("-")
    ]
    lower = text.lower()
    hits = [p for p in phrases if p.lower() in lower]
    return len(hits), hits


DEFAULT_SCRUBBER = os.path.expanduser(
    "~/.claude/skills/blog/references/ai-phrase-scrubber.json"
)
PERSONAS_DIR = os.path.expanduser("~/.claude/skills/blog/personas")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("article")
    parser.add_argument(
        "--persona", help="persona name (looks up forbidden_phrases from frontmatter)"
    )
    parser.add_argument(
        "--scrubber",
        default=DEFAULT_SCRUBBER,
        help="path to ai-phrase-scrubber.json",
    )
    args = parser.parse_args()

    if not os.path.exists(args.article):
        print(json.dumps({"error": f"file not found: {args.article}"}), file=sys.stderr)
        return 2

    with open(args.article) as f:
        raw = f.read()
    text = strip_markdown(raw)

    mean, std = sentence_length_stats(text)
    ttr = type_token_ratio(text)
    n_ai_hits, ai_hits = ai_phrase_hits(text, args.scrubber)
    para_lens, para_max, para_violations = paragraph_length_distribution(text)
    contr_freq = contraction_frequency(text)
    grade = reading_grade(text)

    persona_path = None
    if args.persona:
        candidate = os.path.join(PERSONAS_DIR, f"{args.persona}.md")
        if os.path.exists(candidate):
            persona_path = candidate
    n_forbidden, forbidden_list = forbidden_phrase_hits(text, persona_path)

    out = {
        "word_count": len(words(text)),
        "sentence_length_mean": round(mean, 2),
        "sentence_length_std": round(std, 2),
        "burstiness": round(std, 2),
        "type_token_ratio": round(ttr, 3),
        "ai_phrase_hits": n_ai_hits,
        "ai_phrase_detail": ai_hits[:50],
        "paragraph_lengths": para_lens,
        "paragraph_max_words": para_max,
        "paragraph_violations": para_violations,
        "contraction_freq": round(contr_freq, 3),
        "reading_grade": grade,
        "forbidden_phrase_hits": n_forbidden,
        "forbidden_phrase_detail": forbidden_list,
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
