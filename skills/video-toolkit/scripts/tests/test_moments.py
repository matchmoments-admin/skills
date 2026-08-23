"""The moments.json front door.

`render` refuses to run on any violation, so these tests are what stand between
a freehand model-written file and a clip that sounds chopped.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.moments import (  # noqa: E402
    ClipConstraints, bracket, nearest_break, validate_moments,
)

BREAKS = [10.0, 25.5, 40.0, 62.25, 90.0, 130.0, 175.5]
TRANSCRIPT = {
    "key": "yt-abc12345678",
    "duration": 300.0,
    "breaks": BREAKS,
    "punctuated": True,
    "granularity": "word",
    "break_density_seconds": 8.0,
}


def moments(*spans, rights="owned", **extra):
    return {"source": {"url": "https://example.test/v"}, "rights": rights,
            "moments": [{"rank": i, "start": s, "end": e}
                        for i, (s, e) in enumerate(spans, 1)],
            **extra}


def codes(report):
    return sorted(v.code for v in report.violations)


class TestBracket(unittest.TestCase):
    def test_empty_breaks(self):
        self.assertEqual(bracket(5.0, []), (None, None))

    def test_below_first(self):
        self.assertEqual(bracket(1.0, BREAKS), (None, 10.0))

    def test_above_last(self):
        self.assertEqual(bracket(999.0, BREAKS), (175.5, None))

    def test_exact_hit_returns_itself_both_sides(self):
        self.assertEqual(bracket(40.0, BREAKS), (40.0, 40.0))

    def test_between(self):
        self.assertEqual(bracket(30.0, BREAKS), (25.5, 40.0))

    def test_nearest_prefers_the_closer_side(self):
        self.assertEqual(nearest_break(26.0, BREAKS), 25.5)
        self.assertEqual(nearest_break(39.0, BREAKS), 40.0)

    def test_nearest_on_empty(self):
        self.assertIsNone(nearest_break(5.0, []))


class TestValidEdges(unittest.TestCase):
    def test_exact_break_edges_pass(self):
        rep = validate_moments(moments((10.0, 62.25)), TRANSCRIPT)
        self.assertTrue(rep.ok, [v.message for v in rep.violations])

    def test_within_tolerance_passes_and_snaps(self):
        """Breaks are stored to 3dp; a model writing 62.3 must not be rejected,
        but the repaired file has to carry the exact value."""
        rep = validate_moments(moments((10.0, 62.28)), TRANSCRIPT)
        self.assertTrue(rep.ok)
        m = rep.repaired["moments"][0]
        self.assertEqual(m["end"], 62.25)
        self.assertTrue(m["snapped"])

    def test_strict_mode_rejects_a_near_miss(self):
        rep = validate_moments(moments((10.0, 62.28)), TRANSCRIPT,
                               ClipConstraints(strict=True))
        self.assertIn("not_a_break", codes(rep))

    def test_strict_mode_accepts_an_exact_value(self):
        rep = validate_moments(moments((10.0, 62.25)), TRANSCRIPT,
                               ClipConstraints(strict=True))
        self.assertTrue(rep.ok)


class TestInvariants(unittest.TestCase):
    def test_edge_off_break_is_flagged_with_both_neighbours(self):
        rep = validate_moments(moments((10.0, 50.0)), TRANSCRIPT)
        v = [x for x in rep.violations if x.code == "not_a_break"][0]
        self.assertIn("nearest below: 40.00", v.message)
        self.assertIn("nearest above: 62.25", v.message)
        self.assertIn("breaks within", v.message)

    def test_suggestion_is_the_nearest_break(self):
        rep = validate_moments(moments((10.0, 41.0)), TRANSCRIPT)
        v = [x for x in rep.violations if x.code == "not_a_break"][0]
        self.assertEqual(v.suggestion, 40.0)

    def test_message_reports_the_resulting_duration(self):
        rep = validate_moments(moments((10.0, 50.0)), TRANSCRIPT)
        v = [x for x in rep.violations if x.code == "not_a_break"][0]
        self.assertIn("duration would be 30.00s", v.message)

    def test_too_short(self):
        rep = validate_moments(moments((25.5, 40.0)), TRANSCRIPT,
                               ClipConstraints(min_len=20, max_len=90))
        self.assertIn("too_short", codes(rep))

    def test_too_long(self):
        rep = validate_moments(moments((10.0, 175.5)), TRANSCRIPT,
                               ClipConstraints(min_len=15, max_len=90))
        self.assertIn("too_long", codes(rep))

    def test_reversed_edges(self):
        rep = validate_moments(moments((90.0, 40.0)), TRANSCRIPT)
        self.assertIn("reversed", codes(rep))

    def test_out_of_bounds(self):
        rep = validate_moments(moments((10.0, 9999.0)), TRANSCRIPT)
        self.assertIn("out_of_bounds", codes(rep))

    def test_negative_start(self):
        rep = validate_moments(moments((-5.0, 40.0)), TRANSCRIPT)
        self.assertIn("out_of_bounds", codes(rep))

    def test_missing_fields(self):
        rep = validate_moments({"moments": [{"rank": 1}]}, TRANSCRIPT)
        self.assertIn("missing", codes(rep))

    def test_empty_file(self):
        rep = validate_moments({"moments": []}, TRANSCRIPT)
        self.assertIn("empty", codes(rep))

    def test_ranks_must_be_a_permutation(self):
        m = moments((10.0, 62.25), (90.0, 130.0))
        m["moments"][1]["rank"] = 5
        self.assertIn("bad_ranks", codes(validate_moments(m, TRANSCRIPT)))

    def test_overlapping_moments_are_rejected(self):
        rep = validate_moments(moments((10.0, 90.0), (25.5, 90.0)), TRANSCRIPT)
        self.assertIn("overlaps", codes(rep))

    def test_adjacent_moments_are_fine(self):
        rep = validate_moments(moments((10.0, 62.25), (62.25, 130.0)), TRANSCRIPT)
        self.assertNotIn("overlaps", codes(rep))


class TestWrongSource(unittest.TestCase):
    """Validating moment A's timestamps against video B's breaks fails silently
    and completely — every edge looks wrong for reasons that make no sense."""

    def test_mismatched_key_is_flagged(self):
        rep = validate_moments(moments((10.0, 62.25)), TRANSCRIPT,
                               source_key="yt-DIFFERENT99")
        self.assertIn("wrong_source", codes(rep))

    def test_matching_key_passes(self):
        rep = validate_moments(moments((10.0, 62.25)), TRANSCRIPT,
                               source_key="yt-abc12345678")
        self.assertTrue(rep.ok)

    def test_no_key_supplied_is_not_an_error(self):
        self.assertTrue(validate_moments(moments((10.0, 62.25)), TRANSCRIPT).ok)


class TestWarnings(unittest.TestCase):
    def warn_codes(self, transcript, **kw):
        rep = validate_moments(moments((10.0, 62.25), **kw), transcript)
        return sorted(w.code for w in rep.warnings)

    def test_coarse_breaks(self):
        t = {**TRANSCRIPT, "break_density_seconds": 42.0}
        self.assertIn("coarse_breaks", self.warn_codes(t))

    def test_segment_granularity(self):
        t = {**TRANSCRIPT, "granularity": "segment"}
        self.assertIn("segment_timing", self.warn_codes(t))

    def test_unpunctuated(self):
        t = {**TRANSCRIPT, "punctuated": False}
        self.assertIn("unpunctuated", self.warn_codes(t))

    def test_content_id_risk_only_for_third_party_over_60s(self):
        rep = validate_moments(
            moments((10.0, 90.0), rights="third-party"), TRANSCRIPT)
        self.assertIn("content_id_risk", [w.code for w in rep.warnings])

    def test_owned_content_gets_no_content_id_warning(self):
        rep = validate_moments(moments((10.0, 90.0)), TRANSCRIPT)
        self.assertNotIn("content_id_risk", [w.code for w in rep.warnings])

    def test_warnings_do_not_make_it_fail(self):
        t = {**TRANSCRIPT, "punctuated": False, "granularity": "segment"}
        rep = validate_moments(moments((10.0, 62.25)), t)
        self.assertTrue(rep.ok)
        self.assertTrue(rep.warnings)


class TestRepair(unittest.TestCase):
    def test_repaired_is_always_produced(self):
        rep = validate_moments(moments((10.0, 50.0)), TRANSCRIPT)
        self.assertFalse(rep.ok)
        self.assertEqual(len(rep.repaired["moments"]), 1)

    def test_repair_preserves_unrelated_fields(self):
        m = moments((10.0, 62.28))
        m["moments"][0]["hook"] = "keep me"
        rep = validate_moments(m, TRANSCRIPT)
        self.assertEqual(rep.repaired["moments"][0]["hook"], "keep me")
        self.assertEqual(rep.repaired["rights"], "owned")

    def test_repair_does_not_mutate_the_input(self):
        m = moments((10.0, 62.28))
        validate_moments(m, TRANSCRIPT)
        self.assertEqual(m["moments"][0]["end"], 62.28)


if __name__ == "__main__":
    unittest.main()
