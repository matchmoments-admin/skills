"""Signal construction and fusion."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.errors import VtError  # noqa: E402
from vtlib.signals import (  # noqa: E402
    box_blur, build_signals, comment_series, density_series, gaussian_blur,
    heatmap_series, normalize, prominence, rms_to_spike,
)


def heatmap_info(values, bucket=6.0):
    """A yt-dlp-shaped heatmap: 100 buckets of {start_time, end_time, value}."""
    return {"heatmap": [
        {"start_time": i * bucket, "end_time": (i + 1) * bucket, "value": v}
        for i, v in enumerate(values)]}


def transcript_with_words(duration, step=0.5):
    return {"duration": duration,
            "words": [{"t": round(i * step, 3), "w": "word", "d": step}
                      for i in range(int(duration / step))]}


class TestPrimitives(unittest.TestCase):
    def test_normalize_flat_series_is_all_zero(self):
        self.assertEqual(normalize([3.0, 3.0, 3.0]), [0.0, 0.0, 0.0])

    def test_normalize_spans_zero_to_one(self):
        out = normalize([1.0, 2.0, 3.0])
        self.assertEqual((out[0], out[-1]), (0.0, 1.0))

    def test_normalize_empty(self):
        self.assertEqual(normalize([]), [])

    def test_box_blur_preserves_a_constant(self):
        self.assertEqual(box_blur([2.0] * 10, 3), [2.0] * 10)

    def test_box_blur_zero_radius_is_identity(self):
        self.assertEqual(box_blur([1.0, 5.0, 2.0], 0), [1.0, 5.0, 2.0])

    def test_gaussian_blur_reduces_a_spike(self):
        s = [0.0] * 50
        s[25] = 1.0
        out = gaussian_blur(s, 4.0)
        self.assertLess(out[25], 1.0)
        self.assertGreater(out[24], 0.0)
        self.assertAlmostEqual(sum(out), sum(s), places=6)  # mass preserved

    def test_gaussian_blur_zero_sigma_is_identity(self):
        self.assertEqual(gaussian_blur([1.0, 2.0], 0), [1.0, 2.0])


class TestProminence(unittest.TestCase):
    """The heatmap's raw maximum is structurally at t=0 on every video — it
    measures 'pressed play', not 'rewatched this'. Prominence must remove that
    decay trend so a real mid-video peak can win."""

    def test_a_pure_decay_still_shows_an_edge_artifact_at_zero(self):
        """Documents a real limit rather than a feature.

        The blur's window is truncated at index 0, so on a descending series the
        baseline there is computed only from *lower* values and sits below the
        signal — leaving positive prominence at t=0. Prominence removes the trend
        in the interior but cannot remove a maximum that sits on the boundary.
        That is exactly why `mask_head_tail` exists and why detrending alone was
        not enough to stop every candidate landing on the intro.
        """
        n = 600
        series = [1.0 - i / n for i in range(n)]
        out = prominence(series, baseline_sigma=n / 12.0)
        self.assertEqual(out.index(max(out)), 0)
        # ...but the trend is gone everywhere else: the interior is near-flat.
        self.assertLess(max(out[60:]), 0.2)

    def test_a_mid_series_bump_beats_the_opening(self):
        n = 600
        series = [1.0 - i / n for i in range(n)]
        for i in range(360, 380):
            series[i] += 0.5
        out = prominence(series, baseline_sigma=n / 12.0)
        peak = out.index(max(out))
        self.assertTrue(340 <= peak <= 400, f"peak landed at {peak}, not the bump")

    def test_output_is_normalised(self):
        out = prominence([1.0 - i / 100 for i in range(100)], 10.0)
        self.assertGreaterEqual(min(out), 0.0)
        self.assertLessEqual(max(out), 1.0)


class TestSeries(unittest.TestCase):
    def test_heatmap_returns_prominence_and_raw(self):
        pro, raw = heatmap_series(heatmap_info([1.0] + [0.2] * 99), 600)
        self.assertEqual(len(pro), 600)
        self.assertEqual(len(raw), 600)
        self.assertEqual(max(raw), 1.0)
        self.assertEqual(raw.index(max(raw)), 0)  # raw still peaks at the start

    def test_no_heatmap_returns_none(self):
        self.assertIsNone(heatmap_series({}, 100))

    def test_comment_timestamps_are_extracted_and_like_weighted(self):
        info = {"comments": [
            {"text": "the bit at 2:30 is gold", "like_count": 500},
            {"text": "nothing here", "like_count": 3},
            {"text": "also 1:00:05 wow", "like_count": 0},
        ]}
        series, hits = comment_series(info, 4000)
        self.assertEqual(hits, 2)
        self.assertEqual(max(range(len(series)), key=lambda i: series[i]) // 10,
                         150 // 10)

    def test_comment_regex_ignores_non_timestamps(self):
        info = {"comments": [{"text": "score was 10:1:5:3 and 2024", "like_count": 1}]}
        _, hits = comment_series(info, 4000)
        self.assertEqual(hits, 0)

    def test_no_comments_returns_none(self):
        self.assertEqual(comment_series({}, 100), (None, 0))

    def test_density_tracks_word_positions(self):
        words = [{"t": 50.0 + i * 0.1, "w": "x"} for i in range(100)]
        out = density_series(words, 200)
        self.assertGreater(out[50], out[150])

    def test_rms_to_spike_ignores_a_constant_level(self):
        """Absolute loudness just tracks who is talking; only the burst matters."""
        self.assertEqual(max(rms_to_spike([100.0] * 200, 200)), 0.0)

    def test_rms_to_spike_finds_a_burst(self):
        rms = [100.0] * 200
        for i in range(100, 106):
            rms[i] = 900.0
        out = rms_to_spike(rms, 200)
        self.assertTrue(95 <= out.index(max(out)) <= 111)

    def test_rms_to_spike_pads_short_input(self):
        self.assertEqual(len(rms_to_spike([1.0] * 10, 50)), 50)


class TestFusion(unittest.TestCase):
    def test_weights_renormalise_when_a_series_is_missing(self):
        out = build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                            energy=None)
        self.assertEqual(out["available"], ["density", "heatmap"])
        self.assertAlmostEqual(sum(out["weights_used"].values()), 1.0, places=3)

    def test_heatmap_raw_is_a_diagnostic_not_a_fusable_series(self):
        """It appeared in signals_available, in every candidate's signals dict,
        and propagated into moments.json. Worse, weighting it double-counted the
        heatmap — the exact signal whose over-weighting causes intro clustering."""
        out = build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                            energy=None)
        self.assertNotIn("heatmap_raw", out["available"])
        self.assertNotIn("heatmap_raw", out["series"])
        self.assertIn("heatmap_raw", out["diagnostics"])

    def test_weighting_an_unknown_signal_is_an_error(self):
        with self.assertRaises(VtError) as cm:
            build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                          energy=None, weights_override={"heatmap_raw": 0.5})
        self.assertIn("heatmap_raw", str(cm.exception))

    def test_energy_joins_the_fusion_when_supplied(self):
        out = build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                            energy=[0.0] * 600)
        self.assertIn("energy", out["available"])
        self.assertIn("energy", out["weights_used"])

    def test_zero_weight_drops_a_series(self):
        out = build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                            energy=None, weights_override={"heatmap": 0.0})
        self.assertNotIn("heatmap", out["weights_used"])

    def test_zero_duration_is_an_error(self):
        with self.assertRaises(VtError):
            build_signals({}, {"duration": 0, "words": []}, energy=None)

    def test_fused_length_matches_the_grid(self):
        out = build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                            energy=None)
        self.assertEqual(len(out["fused"]), 600)

    def test_energy_note_is_recorded_when_absent(self):
        out = build_signals(heatmap_info([0.5] * 100), transcript_with_words(600),
                            energy=None, energy_note="ffmpeg not installed")
        self.assertEqual(out["meta"]["energy_skipped"], "ffmpeg not installed")


if __name__ == "__main__":
    unittest.main()
