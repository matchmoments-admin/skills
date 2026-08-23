"""Caption parsing and clause-boundary detection.

These lock behaviour that took more than one attempt to get right against real
videos — the notes on each test say which failure it prevents.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.transcript import (  # noqa: E402
    build_transcript, looks_word_level, parse_json3, parse_vtt, pause_breaks,
    spoken_estimate,
)  # noqa: F401


class TestParseJson3(unittest.TestCase):
    def test_skips_rolling_caption_repaints(self):
        """Auto-captions repaint the previous line with aAppend set. Counting
        those doubles every word and shifts all the timings."""
        data = {"events": [
            {"tStartMs": 1000, "segs": [{"utf8": "hello"},
                                        {"utf8": " world", "tOffsetMs": 300}]},
            {"tStartMs": 1300, "aAppend": 1, "segs": [{"utf8": "\n"}]},
            {"tStartMs": 2000, "segs": [{"utf8": "again"}]},
        ]}
        words = parse_json3(data)
        self.assertEqual([w["w"] for w in words], ["hello", "world", "again"])
        self.assertEqual([w["t"] for w in words], [1.0, 1.3, 2.0])

    def test_word_level_offsets_are_applied(self):
        data = {"events": [{"tStartMs": 5000, "segs": [
            {"utf8": "a"}, {"utf8": " b", "tOffsetMs": 250},
            {"utf8": " c", "tOffsetMs": 700}]}]}
        self.assertEqual([w["t"] for w in parse_json3(data)], [5.0, 5.25, 5.7])

    def test_ignores_empty_and_whitespace_segments(self):
        data = {"events": [{"tStartMs": 0, "segs": [
            {"utf8": " "}, {"utf8": "\n"}, {"utf8": "real", "tOffsetMs": 10}]}]}
        self.assertEqual([w["w"] for w in parse_json3(data)], ["real"])

    def test_empty_input(self):
        self.assertEqual(parse_json3({}), [])
        self.assertEqual(parse_json3({"events": []}), [])


class TestParseVtt(unittest.TestCase):
    def test_cues_and_dedup(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:03.000\n<c>Hello</c> there\n\n"
            "00:00:03.000 --> 00:00:05.000\nHello there\n\n"
            "00:00:05.500 --> 00:00:07.000\nSomething else\n"
        )
        out = parse_vtt(vtt)
        self.assertEqual([w["w"] for w in out], ["Hello there", "Something else"])
        self.assertEqual([w["t"] for w in out], [1.0, 5.5])


class TestGranularity(unittest.TestCase):
    def test_single_words_are_word_level(self):
        self.assertTrue(looks_word_level([{"w": "a"}, {"w": "b"}, {"w": "c"}]))

    def test_cues_are_segment_level(self):
        self.assertFalse(looks_word_level(
            [{"w": "a whole caption cue"}, {"w": "another cue here"}]))

    def test_empty(self):
        self.assertFalse(looks_word_level([]))


class TestDurationCapping(unittest.TestCase):
    """The bug: capping cue durations at 1.2s invents a gap after every cue,
    which made every caption cue a false clause break (286 cues -> 286 breaks)."""

    def test_word_durations_are_capped(self):
        words = [{"t": 0.0, "w": "one"}, {"t": 5.0, "w": "two"}]
        build_transcript(words, 10.0)
        self.assertEqual(words[0]["d"], 1.2)

    def test_segment_durations_are_not_capped(self):
        words = [{"t": 0.0, "w": "a whole caption cue here"},
                 {"t": 5.0, "w": "another caption cue entirely"}]
        build_transcript(words, 10.0)
        self.assertEqual(words[0]["d"], 5.0)

    def test_existing_durations_are_left_alone(self):
        words = [{"t": 0.0, "w": "x", "d": 9.9}, {"t": 5.0, "w": "y"}]
        build_transcript(words, 10.0)
        self.assertEqual(words[0]["d"], 9.9)


class TestBreakDensity(unittest.TestCase):
    """A fixed gap threshold fails in both directions: contiguous auto-caption
    timings yield almost no breaks, sparse cue timings yield one per cue. The
    threshold is adaptive and should land near one break per ~8s either way."""

    @staticmethod
    def dense_words(duration=600.0, silence_every=8):
        """Contiguous word timings, as json3 actually produces them — each
        word's start is the previous word's end, so raw gaps are all zero."""
        words, t, i = [], 0.0, 0
        while t < duration:
            w = "word"
            words.append({"t": round(t, 3), "w": w})
            t += spoken_estimate(w)
            i += 1
            if i % silence_every == 0:
                t += 0.6  # a real pause
        return words

    @staticmethod
    def cue_words(duration=600.0, cue_len=4.0):
        return [{"t": round(t, 3), "w": "a caption cue of several words"}
                for t in [i * cue_len for i in range(int(duration / cue_len))]]

    def test_dense_contiguous_timings_still_yield_breaks(self):
        words = self.dense_words()
        t = build_transcript(words, 600.0)
        self.assertEqual(t["granularity"], "word")
        self.assertGreater(len(t["breaks"]), 20,
                           "contiguous timings must not collapse to ~0 breaks")
        self.assertLess(t["break_density_seconds"], 16)

    def test_sparse_cue_timings_do_not_break_on_every_cue(self):
        words = self.cue_words()
        t = build_transcript(words, 600.0)
        self.assertEqual(t["granularity"], "segment")
        self.assertLess(len(t["breaks"]), len(words),
                        "a break after every cue means the threshold collapsed")

    def test_threshold_is_floored_at_a_real_pause(self):
        _, thr = pause_breaks(self.dense_words(), 600.0)
        self.assertGreaterEqual(thr, 0.18)

    def test_no_words(self):
        self.assertEqual(pause_breaks([], 0.0), ([], 0.0))


class TestPunctuationDetection(unittest.TestCase):
    def test_auto_captions_report_unpunctuated(self):
        words = [{"t": i * 0.3, "w": w} for i, w in
                 enumerate("so the thing is that we were talking about it".split())]
        self.assertFalse(build_transcript(words, 5.0)["punctuated"])

    def test_manual_captions_report_punctuated(self):
        words = [{"t": i * 1.0, "w": w} for i, w in
                 enumerate(["This is one.", "And two.", "Then three.", "Four."])]
        self.assertTrue(build_transcript(words, 5.0)["punctuated"])


if __name__ == "__main__":
    unittest.main()


class TestReviewFixes(unittest.TestCase):
    """Regressions found by code review, each with the failure it caused."""

    def test_spoken_estimate_handles_a_whole_cue(self):
        """Segment transcripts hold a full cue per entry. Estimating only the
        first word made the cue look instantaneous, so no pause was ever seen."""
        one = spoken_estimate("hello")
        many = spoken_estimate("hello there my friend")
        self.assertGreater(many, one * 3)

    def test_measured_durations_win_over_the_estimate(self):
        """Whisper supplies a true duration. Estimating over it invents a gap
        and places the break before the word has finished — a cut mid-word."""
        words = [{"t": 0.0, "w": "aaaaaaaaaa", "d": 2.0},
                 {"t": 2.05, "w": "b", "d": 0.1}]
        breaks, _ = pause_breaks(words, 10.0, measured=True)
        self.assertEqual(breaks, [], "0.05s is not a pause")

    def test_estimate_is_used_when_durations_are_derived(self):
        words = [{"t": 0.0, "w": "aaaaaaaaaa"}, {"t": 2.05, "w": "b"}]
        breaks, _ = pause_breaks(words, 10.0, measured=False)
        self.assertTrue(breaks)

    def test_build_transcript_detects_measured_durations(self):
        whisper = [{"t": 0.0, "w": "a", "d": 0.3}, {"t": 1.0, "w": "b", "d": 0.3}]
        self.assertTrue(build_transcript(whisper, 5.0)["durations_measured"])
        captions = [{"t": 0.0, "w": "a"}, {"t": 1.0, "w": "b"}]
        self.assertFalse(build_transcript(captions, 5.0)["durations_measured"])

    def test_punctuation_wins_when_it_is_dense_enough(self):
        """Sentence ends start a clip on a sentence. Supplementing adequate
        punctuation with estimated pauses introduced mid-sentence cut points
        that outranked the real ones."""
        words = [{"t": i * 2.0, "w": f"sentence{i}."} for i in range(60)]
        t = build_transcript(words, 120.0)
        self.assertEqual(t["break_source"], "punctuation")
        self.assertEqual(t["pause_threshold"], 0.0)

    def test_pauses_are_used_when_there_is_no_punctuation(self):
        words = [{"t": i * 0.4, "w": "word"} for i in range(300)]
        self.assertEqual(build_transcript(words, 120.0)["break_source"], "pauses")

    def test_vtt_dedup_is_adjacent_only(self):
        """A global set silently deleted the second 'Thank you.' in a talk,
        taking its timing and its break with it."""
        vtt = ("WEBVTT\n\n"
               "00:00:00.000 --> 00:00:02.000\nThank you.\n\n"
               "00:00:02.000 --> 00:00:04.000\nThank you.\n\n"
               "00:00:10.000 --> 00:00:12.000\nSomething else\n\n"
               "00:45:00.000 --> 00:45:02.000\nThank you.\n")
        out = parse_vtt(vtt)
        self.assertEqual([w["w"] for w in out],
                         ["Thank you.", "Something else", "Thank you."])
        self.assertEqual(out[-1]["t"], 2700.0)
