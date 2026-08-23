"""Window placement, boundary snapping and dedup."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.candidates import (  # noqa: E402
    BOILERPLATE_PENALTY, CandidateParams, chapter_at, find_candidates,
    find_peaks, iou, mask_head_tail, opener_ok, place_window, snap_window,
    words_in,
)

BREAKS = [float(x) for x in range(0, 601, 10)]


def synthetic(duration=600, spikes=(), words_every=0.5):
    """A signals+transcript pair with fused energy only where told."""
    fused = [0.05] * duration
    for start, end, value in spikes:
        for i in range(start, end):
            fused[i] = value
    words = [{"t": round(i * words_every, 3), "w": "word", "d": words_every}
             for i in range(int(duration / words_every))]
    signals = {
        "duration": float(duration),
        "fused": fused,
        "series": {"heatmap": fused},
        "available": ["heatmap"],
        "weights_used": {"heatmap": 1.0},
    }
    transcript = {"duration": float(duration), "punctuated": False,
                  "words": words, "breaks": list(BREAKS)}
    return signals, transcript


class TestMaskHeadTail(unittest.TestCase):
    def test_head_and_tail_are_zeroed(self):
        out = mask_head_tail([1.0] * 100, skip_head=10, skip_tail=5)
        self.assertEqual(out[:10], [0.0] * 10)
        self.assertEqual(out[95:], [0.0] * 5)
        self.assertEqual(out[10:95], [1.0] * 85)

    def test_does_not_mutate_the_input(self):
        src = [1.0] * 20
        mask_head_tail(src, 5, 5)
        self.assertEqual(src, [1.0] * 20)


class TestIntroExclusion(unittest.TestCase):
    """The regression test for what the toolkit calls the single most common way
    a clip pipeline produces confidently wrong output.

    A YouTube heatmap's global maximum sits at t=0 on essentially every video,
    on top of the intro and the sponsor read. Before head exclusion, 5 of 6
    candidates on a real 5-hour podcast landed in the first three minutes.
    """

    def test_no_candidate_starts_inside_the_excluded_head(self):
        signals, transcript = synthetic(
            duration=600, spikes=[(0, 40, 1.0), (300, 340, 0.6)])
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=6, min_len=20, max_len=58))
        self.assertTrue(out["candidates"], "expected at least one candidate")
        head = out["constraints"]["skip_head"]
        for c in out["candidates"]:
            self.assertGreaterEqual(c["start"], head)

    def test_the_mid_video_peak_is_found_instead(self):
        signals, transcript = synthetic(
            duration=600, spikes=[(0, 40, 1.0), (300, 340, 0.6)])
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=6, min_len=20, max_len=58))
        best = out["candidates"][0]
        self.assertTrue(280 <= best["start"] <= 340,
                        f"top candidate at {best['start']}, not the real peak")

    def test_explicit_skip_head_overrides_the_default(self):
        signals, transcript = synthetic(duration=600, spikes=[(100, 140, 1.0)])
        out = find_candidates(
            signals, transcript, [],
            CandidateParams(count=3, min_len=20, max_len=58, skip_head=0,
                            skip_tail=0))
        self.assertEqual(out["constraints"]["skip_head"], 0)

    def test_default_head_is_clamped_between_30_and_180(self):
        self.assertEqual(CandidateParams().resolved_head(100), 30.0)
        self.assertEqual(CandidateParams().resolved_head(18900), 180.0)
        self.assertEqual(CandidateParams().resolved_head(5000), 100.0)


class TestSnapWindow(unittest.TestCase):
    def test_both_edges_land_on_breaks(self):
        s, e = snap_window(12.0, 34.0, BREAKS, 20, 58)
        self.assertIn(s, BREAKS)
        self.assertIn(e, BREAKS)
        self.assertEqual((s, e), (10.0, 40.0))

    def test_never_exceeds_max_len(self):
        s, e = snap_window(5.0, 55.0, BREAKS, 20, 30)
        self.assertLessEqual(e - s, 30)

    def test_extends_a_too_short_window(self):
        s, e = snap_window(20.0, 22.0, BREAKS, 20, 58)
        self.assertGreaterEqual(e - s, 20)

    def test_no_breaks_returns_the_original_edges(self):
        self.assertEqual(snap_window(5.0, 25.0, [], 20, 58), (5.0, 25.0))


class TestOpener(unittest.TestCase):
    def test_dangling_pronoun_is_rejected(self):
        ok, first = opener_ok([{"t": 0, "w": "It"}, {"t": 1, "w": "works"}])
        self.assertFalse(ok)
        self.assertEqual(first, "it")

    def test_conjunction_is_rejected(self):
        self.assertFalse(opener_ok([{"t": 0, "w": "And,"}])[0])

    def test_a_real_opener_passes(self):
        self.assertTrue(opener_ok([{"t": 0, "w": "Nobody"}])[0])

    def test_empty_is_rejected(self):
        self.assertEqual(opener_ok([]), (False, ""))


class TestIou(unittest.TestCase):
    def test_identical_windows(self):
        self.assertEqual(iou((0, 10), (0, 10)), 1.0)

    def test_disjoint_windows(self):
        self.assertEqual(iou((0, 10), (20, 30)), 0.0)

    def test_touching_windows_do_not_overlap(self):
        self.assertEqual(iou((0, 10), (10, 20)), 0.0)

    def test_half_overlap(self):
        self.assertAlmostEqual(iou((0, 10), (5, 15)), 5 / 15)


class TestDedup(unittest.TestCase):
    def test_overlapping_windows_are_collapsed(self):
        signals, transcript = synthetic(
            duration=600, spikes=[(200, 260, 1.0)])
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=10, min_len=20, max_len=58))
        for i, a in enumerate(out["candidates"]):
            for b in out["candidates"][i + 1:]:
                self.assertLessEqual(
                    iou((a["start"], a["end"]), (b["start"], b["end"])), 0.35)

    def test_count_is_respected(self):
        signals, transcript = synthetic(
            duration=600,
            spikes=[(i, i + 20, 1.0) for i in range(200, 500, 60)])
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=2, min_len=20, max_len=58))
        self.assertLessEqual(len(out["candidates"]), 2)

    def test_ranks_are_a_dense_sequence(self):
        signals, transcript = synthetic(duration=600, spikes=[(200, 300, 1.0)])
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=5, min_len=20, max_len=58))
        self.assertEqual([c["rank"] for c in out["candidates"]],
                         list(range(1, len(out["candidates"]) + 1)))


class TestBoilerplate(unittest.TestCase):
    def test_sponsor_read_is_flagged_and_penalised(self):
        signals, transcript = synthetic(duration=600, spikes=[(200, 300, 1.0)])
        for w in transcript["words"]:
            if 200 <= w["t"] < 260:
                w["w"] = "sponsors"
        transcript["words"][400]["w"] = "check out our sponsors"
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=5, min_len=20, max_len=58))
        flagged = [c for c in out["candidates"] if c["boilerplate"]]
        for c in flagged:
            self.assertAlmostEqual(
                c["fused_mean"], round(c["fused_raw"] * BOILERPLATE_PENALTY, 5),
                places=4)


class TestSignalsPassthrough(unittest.TestCase):
    def test_only_available_series_appear_per_candidate(self):
        signals, transcript = synthetic(duration=600, spikes=[(200, 300, 1.0)])
        signals["series"]["heatmap_raw"] = signals["fused"]  # a diagnostic sneaking in
        out = find_candidates(signals, transcript, [],
                              CandidateParams(count=3, min_len=20, max_len=58))
        for c in out["candidates"]:
            self.assertEqual(sorted(c["signals"]), ["heatmap"])


class TestHelpers(unittest.TestCase):
    def test_words_in_is_half_open(self):
        words = [{"t": 0.0, "w": "a"}, {"t": 5.0, "w": "b"}, {"t": 10.0, "w": "c"}]
        self.assertEqual([w["w"] for w in words_in(words, 0.0, 10.0)], ["a", "b"])

    def test_chapter_lookup(self):
        chapters = [{"start_time": 0, "end_time": 100, "title": "One"},
                    {"start_time": 100, "end_time": 200, "title": "Two"}]
        self.assertEqual(chapter_at(chapters, 150), "Two")
        self.assertIsNone(chapter_at(chapters, 500))
        self.assertIsNone(chapter_at([], 5))

    def test_find_peaks_falls_back_when_series_is_flat(self):
        self.assertTrue(find_peaks([0.5] * 100, count=3))

    def test_place_window_returns_none_when_clip_cannot_fit(self):
        self.assertIsNone(place_window([0.1] * 10, peak=5, min_len=20, max_len=58))


if __name__ == "__main__":
    unittest.main()
