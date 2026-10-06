"""Per-platform metadata, truncation, and the rights gate."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.platforms import (  # noqa: E402
    CONTENT_ID_SAFE_SECONDS, PLATFORMS, build_metadata, hashtags_for,
    platform_metadata, slugify, truncate_words,
)

SOURCE = {"url": "https://example.test/v", "channel": "Some Channel"}


def moment(start=0.0, end=40.0, **kw):
    return {"rank": 1, "start": start, "end": end,
            "hook": "The thing nobody says out loud", **kw}


class TestTruncation(unittest.TestCase):
    def test_short_text_is_untouched(self):
        self.assertEqual(truncate_words("hello there", 100), "hello there")

    def test_cuts_on_a_word_boundary(self):
        out = truncate_words("alpha beta gamma delta epsilon", 20)
        self.assertFalse(out.endswith("delt"))
        self.assertLessEqual(len(out), 20)

    def test_never_leaves_dangling_punctuation(self):
        self.assertFalse(truncate_words("alpha beta, gamma delta", 12)
                         .endswith(","))

    def test_a_single_long_word_still_gets_cut(self):
        self.assertLessEqual(len(truncate_words("w" * 500, 50)), 50)


class TestHashtags(unittest.TestCase):
    def test_derived_from_chapter_and_title(self):
        tags = hashtags_for(moment(chapter="Mechanistic Interpretability"),
                            PLATFORMS["tiktok"])
        self.assertIn("#mechanistic", tags)

    def test_respects_the_platform_cap(self):
        m = moment(chapter="one two three four five six seven eight nine ten")
        self.assertLessEqual(len(hashtags_for(m, PLATFORMS["x"])),
                             PLATFORMS["x"].hashtags)

    def test_deduplicates(self):
        m = moment(chapter="Same Same", title="Same")
        self.assertEqual(len(hashtags_for(m, PLATFORMS["tiktok"])), 1)

    def test_no_source_fields_gives_no_tags(self):
        self.assertEqual(hashtags_for({"hook": "x"}, PLATFORMS["tiktok"]), [])


class TestFit(unittest.TestCase):
    def test_a_short_clip_fits_everywhere(self):
        meta = build_metadata(moment(end=30.0), SOURCE, "owned")
        self.assertTrue(all(m["fits"] for m in meta.values()))

    def test_a_long_clip_fails_x_first(self):
        meta = build_metadata(moment(end=200.0), SOURCE, "owned")
        self.assertFalse(meta["x"]["fits"])
        self.assertTrue(meta["tiktok"]["fits"])

    def test_failure_says_which_limit(self):
        meta = build_metadata(moment(end=200.0), SOURCE, "owned")
        self.assertIn("140s limit", " ".join(meta["x"]["notes"]))

    def test_youtube_shorts_carries_a_title(self):
        meta = build_metadata(moment(), SOURCE, "owned", ["youtube-shorts"])
        self.assertIn("title", meta["youtube-shorts"])

    def test_tiktok_has_no_title_field(self):
        meta = build_metadata(moment(), SOURCE, "owned", ["tiktok"])
        self.assertNotIn("title", meta["tiktok"])


class TestRightsGate(unittest.TestCase):
    """Matches video-moments' stance: analyse third-party content freely, never
    present it as publishable."""

    def test_owned_content_is_publishable(self):
        meta = build_metadata(moment(), SOURCE, "owned")
        self.assertTrue(all(m["publishable"] for m in meta.values()))

    def test_third_party_is_not_publishable_on_any_platform(self):
        meta = build_metadata(moment(), SOURCE, "third-party")
        self.assertTrue(all(not m["publishable"] for m in meta.values()))

    def test_third_party_explains_why(self):
        meta = build_metadata(moment(), SOURCE, "third-party", ["tiktok"])
        joined = " ".join(meta["tiktok"]["notes"])
        self.assertIn("copyright strike", joined)

    def test_licensed_is_publishable_but_flagged(self):
        meta = build_metadata(moment(), SOURCE, "licensed", ["tiktok"])
        self.assertTrue(meta["tiktok"]["publishable"])
        self.assertIn("licence", " ".join(meta["tiktok"]["notes"]))

    def test_content_id_warning_only_over_the_threshold(self):
        short = build_metadata(moment(end=45.0), SOURCE, "third-party",
                               ["youtube-shorts"])["youtube-shorts"]
        long = build_metadata(moment(end=90.0), SOURCE, "third-party",
                              ["youtube-shorts"])["youtube-shorts"]
        self.assertNotIn("blocked globally", " ".join(short["notes"]))
        self.assertIn("blocked globally", " ".join(long["notes"]))

    def test_owned_content_gets_no_content_id_warning(self):
        meta = build_metadata(moment(end=90.0), SOURCE, "owned",
                              ["youtube-shorts"])
        self.assertNotIn("blocked globally",
                         " ".join(meta["youtube-shorts"]["notes"]))

    def test_threshold_matches_the_documented_value(self):
        self.assertEqual(CONTENT_ID_SAFE_SECONDS, 60)


class TestCaption(unittest.TestCase):
    def test_caption_carries_the_hook_and_attribution(self):
        meta = build_metadata(moment(), SOURCE, "owned", ["tiktok"])["tiktok"]
        self.assertIn("nobody says out loud", meta["caption"])
        self.assertIn("Some Channel", meta["caption"])

    def test_x_truncates_and_keeps_the_original(self):
        m = moment(hook="word " * 200)
        meta = build_metadata(m, SOURCE, "owned", ["x"])["x"]
        self.assertLessEqual(len(meta["caption"]), 280)
        self.assertTrue(meta["caption_truncated"])
        self.assertIsNotNone(meta["caption_full"])

    def test_untruncated_caption_has_no_full_copy(self):
        meta = build_metadata(moment(), SOURCE, "owned", ["tiktok"])["tiktok"]
        self.assertFalse(meta["caption_truncated"])
        self.assertIsNone(meta["caption_full"])

    def test_missing_channel_does_not_produce_a_dangling_line(self):
        meta = build_metadata(moment(), {"url": ""}, "owned",
                              ["tiktok"])["tiktok"]
        self.assertNotIn("From ", meta["caption"])


class TestSelection(unittest.TestCase):
    def test_unknown_platform_is_an_error(self):
        with self.assertRaises(ValueError) as cm:
            build_metadata(moment(), SOURCE, "owned", ["myspace"])
        self.assertIn("myspace", str(cm.exception))

    def test_default_is_every_platform(self):
        self.assertEqual(set(build_metadata(moment(), SOURCE, "owned")),
                         set(PLATFORMS))

    def test_limits_carry_a_checked_date(self):
        meta = build_metadata(moment(), SOURCE, "owned", ["tiktok"])["tiktok"]
        self.assertRegex(meta["limits_checked"], r"^\d{4}-\d{2}$")


class TestSlugify(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("The Thing Nobody Says!"),
                         "the-thing-nobody-says")

    def test_truncates_on_a_word_boundary(self):
        out = slugify("alpha beta gamma delta epsilon zeta eta theta", limit=20)
        self.assertLessEqual(len(out), 20)
        self.assertFalse(out.endswith("-"))

    def test_empty_falls_back(self):
        self.assertEqual(slugify(""), "clip")
        self.assertEqual(slugify("!!!"), "clip")


if __name__ == "__main__":
    unittest.main()
