"""Layout choice, crop smoothing, and the moving-crop expression.

The speaker-track branches are tested against hand-written fixtures, before any
detector exists. That is the point of the seam: the hard logic ships tested, and
the detector only has to produce the JSON.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.errors import VtError  # noqa: E402
from vtlib.reframe import (  # noqa: E402
    DEADZONE_FRAC, SLEW_PX_PER_SECOND, TARGET_ASPECT, Face, SourceInfo,
    SpeakerTrack, TrackSample, apply_deadzone, compile_crop_expr,
    dominant_speaker, evaluate_crop_expr, even, even_round, limit_slew,
    parse_track, plan_reframe, portrait_crop, smooth_path, split_panes,
)  # noqa: F401

HD = SourceInfo(width=1920, height=1080, fps=30, duration=600)


def track(*, fps=2.0, samples):
    return SpeakerTrack(fps=fps, frame_w=1920, frame_h=1080,
                        samples=tuple(samples))


def two_speakers(n=40, start=0.0, step=0.5, speaking_left=True):
    out = []
    for i in range(n):
        left = Face(x=300, y=300, w=200, h=200, id="A",
                    speaking=0.9 if speaking_left else 0.05)
        right = Face(x=1400, y=300, w=200, h=200, id="B",
                     speaking=0.05 if speaking_left else 0.9)
        out.append(TrackSample(t=start + i * step, faces=(left, right)))
    return out


class TestQuantisation(unittest.TestCase):
    def test_even_floors(self):
        self.assertEqual(even(607.9), 606)
        self.assertEqual(even(608.0), 608)

    def test_even_round_goes_to_nearest(self):
        self.assertEqual(even_round(607.5), 608)
        self.assertEqual(even_round(606.4), 606)

    def test_crop_dimensions_stay_close_to_target_aspect(self):
        for w, h in ((1920, 1080), (3840, 2160), (1280, 720), (1080, 1080)):
            r = portrait_crop(SourceInfo(width=w, height=h))
            self.assertLess(abs(r.w / r.h - TARGET_ASPECT), 0.002,
                            f"{w}x{h} -> {r.w}x{r.h}")

    def test_all_coordinates_are_even(self):
        r = portrait_crop(HD)
        for v in (r.x, r.y, r.w, r.h):
            self.assertEqual(v % 2, 0)


class TestGeometry(unittest.TestCase):
    def test_crop_stays_inside_the_frame(self):
        for cx in (-500, 0, 960, 1920, 5000):
            r = portrait_crop(HD, cx)
            self.assertGreaterEqual(r.x, 0)
            self.assertLessEqual(r.x + r.w, 1920)

    def test_crop_follows_the_requested_centre(self):
        left = portrait_crop(HD, 400)
        right = portrait_crop(HD, 1500)
        self.assertLess(left.x, right.x)

    def test_portrait_source_is_not_cropped_horizontally(self):
        r = portrait_crop(SourceInfo(width=1080, height=1920))
        self.assertEqual(r.w, 1080)

    def test_rotation_swaps_displayed_dimensions(self):
        rotated = SourceInfo(width=1920, height=1080, rotation=90)
        self.assertEqual(rotated.displayed, (1080, 1920))
        self.assertEqual(portrait_crop(rotated).w, 1080)

    def test_split_panes_are_side_by_side_and_in_frame(self):
        a, b = split_panes(HD)
        self.assertLess(a.x, b.x)
        self.assertLessEqual(b.x + b.w, 1920)

    def test_split_panes_centre_on_faces_when_given(self):
        a, b = split_panes(HD, (400.0, 1500.0))
        self.assertLess(a.x, b.x)
        self.assertGreater(b.x, 900)

    def test_as_crop_string(self):
        self.assertEqual(portrait_crop(HD).as_crop(), "crop=608:1080:656:0")


class TestSmoothing(unittest.TestCase):
    def test_deadzone_holds_through_small_wobble(self):
        vals = [500, 505, 498, 502, 500]
        self.assertEqual(len(set(apply_deadzone(vals, 50))), 1)

    def test_deadzone_releases_on_a_real_move(self):
        out = apply_deadzone([500, 500, 900], 50)
        self.assertEqual(out[-1], 900)

    def test_slew_limit_caps_a_step(self):
        out = limit_slew([0, 1000], 10)
        self.assertEqual(out[-1], 10)

    def test_slew_limit_leaves_small_steps_alone(self):
        self.assertEqual(limit_slew([0, 5, 9], 10), [0, 5, 9])

    def test_constant_input_gives_constant_output(self):
        out = smooth_path([700.0] * 40, fps=2, frame_width=1920)
        self.assertTrue(all(abs(v - 700.0) < 1e-6 for v in out))

    def test_a_step_becomes_a_ramp_within_the_slew_limit(self):
        vals = [0.0] * 10 + [800.0] * 30
        out = smooth_path(vals, fps=2, frame_width=1920)
        max_step = SLEW_PX_PER_SECOND / 2
        for a, b in zip(out, out[1:]):
            self.assertLessEqual(abs(b - a), max_step + 1e-6)

    def test_wobble_below_the_deadzone_is_suppressed(self):
        wobble = [700.0 + (30 if i % 2 else -30) for i in range(40)]
        out = smooth_path(wobble, fps=2, frame_width=1920)
        self.assertLess(max(out) - min(out), DEADZONE_FRAC * 1920)

    def test_empty_input(self):
        self.assertEqual(smooth_path([], 2, 1920), [])


class TestSpeakerHysteresis(unittest.TestCase):
    def test_a_brief_interjection_does_not_switch_the_crop(self):
        """A two-second 'mm-hm' must not whip the frame across and back."""
        samples = two_speakers(n=20, speaking_left=True)
        blip = two_speakers(n=1, start=10.0, speaking_left=False)
        samples = samples[:10] + blip + samples[11:]
        who = dominant_speaker(samples, fps=2.0)
        self.assertTrue(all(w == "A" for w in who), who)

    def test_a_sustained_change_does_switch(self):
        samples = (two_speakers(n=10, speaking_left=True)
                   + two_speakers(n=10, start=5.0, speaking_left=False))
        who = dominant_speaker(samples, fps=2.0)
        self.assertEqual(who[0], "A")
        self.assertEqual(who[-1], "B")

    def test_empty_track(self):
        self.assertEqual(dominant_speaker([], 2.0), [])


class TestCropExpression(unittest.TestCase):
    def test_single_keyframe_is_a_constant(self):
        self.assertEqual(compile_crop_expr([(0.0, 400.0)]), "400.00")

    def test_term_count_matches_the_segments(self):
        kf = [(float(i), float(i * 100)) for i in range(10)]
        self.assertEqual(compile_crop_expr(kf).count("clip("), 9)

    def test_expression_reproduces_every_keyframe(self):
        kf = [(i * 0.5, 400.0 + (i % 7) * 60) for i in range(60)]
        for t, x in kf:
            self.assertAlmostEqual(evaluate_crop_expr(kf, t), x, places=4)

    def test_value_is_held_before_and_after_the_path(self):
        kf = [(1.0, 100.0), (2.0, 200.0)]
        self.assertAlmostEqual(evaluate_crop_expr(kf, 0.0), 100.0)
        self.assertAlmostEqual(evaluate_crop_expr(kf, 99.0), 200.0)

    def test_midpoint_interpolates_linearly(self):
        kf = [(0.0, 0.0), (2.0, 200.0)]
        self.assertAlmostEqual(evaluate_crop_expr(kf, 1.0), 100.0)

    def test_no_keyframes_is_an_error(self):
        with self.assertRaises(VtError):
            compile_crop_expr([])


class TestPlanReframe(unittest.TestCase):
    def test_unknown_layout_is_an_error(self):
        with self.assertRaises(VtError):
            plan_reframe("sideways", 0, 30, HD)

    def test_center_without_a_track(self):
        p = plan_reframe("center", 0, 30, HD)
        self.assertEqual(p.layout, "center")
        self.assertIsNotNone(p.rect)

    def test_fit_crops_nothing(self):
        p = plan_reframe("fit", 0, 30, HD)
        self.assertIsNone(p.rect)
        self.assertEqual(p.panes, ())

    def test_split_produces_two_panes(self):
        self.assertEqual(len(plan_reframe("split", 0, 30, HD).panes), 2)

    def test_path_without_a_track_falls_back_to_center(self):
        p = plan_reframe("path", 0, 30, HD, track(samples=[]))
        self.assertEqual(p.layout, "center")
        self.assertIn("no speaker track", p.reason)

    def test_path_with_a_track_produces_an_expression(self):
        p = plan_reframe("path", 0, 20, HD, track(samples=two_speakers(n=40)))
        self.assertEqual(p.layout, "path")
        self.assertIsNotNone(p.crop_expr)
        self.assertEqual(p.crop_size, (608, 1080))

    def test_path_keyframes_are_clip_relative(self):
        """The renderer resets timestamps, so a path timed against the source
        would start moving `start` seconds late."""
        moving = [TrackSample(t=100.0 + i * 0.5, faces=(
            Face(x=200 + i * 60, y=300, w=200, h=200, id="A", speaking=0.9),))
            for i in range(20)]
        p = plan_reframe("path", 100.0, 110.0, HD, track(samples=moving))
        self.assertIn("(t-0.00)", p.crop_expr)
        self.assertNotIn("t-100", p.crop_expr)
        self.assertGreater(p.crop_expr.count("clip("), 1)

    def test_auto_prefers_split_for_two_detected_speakers(self):
        p = plan_reframe("auto", 0, 20, HD, track(samples=two_speakers(n=40)))
        self.assertEqual(p.layout, "split")
        self.assertIn("two speakers", p.reason)

    def test_auto_without_a_track_uses_aspect(self):
        wide = plan_reframe("auto", 0, 30, HD)
        self.assertEqual(wide.layout, "split")
        square = plan_reframe("auto", 0, 30, SourceInfo(width=1080, height=1080))
        self.assertEqual(square.layout, "center")

    def test_center_follows_the_mean_face_position(self):
        left_only = [TrackSample(t=i * 0.5, faces=(
            Face(x=200, y=300, w=200, h=200, id="A", speaking=0.9),))
            for i in range(20)]
        p = plan_reframe("center", 0, 10, HD, track(samples=left_only))
        self.assertLess(p.rect.x, portrait_crop(HD).x)


class TestParseTrack(unittest.TestCase):
    def test_round_trips_the_on_disk_shape(self):
        data = {"fps": 2, "frame_w": 1920, "frame_h": 1080, "samples": [
            {"t": 1.5, "faces": [
                {"id": "A", "x": 100, "y": 50, "w": 200, "h": 200,
                 "det": 0.9, "speaking": 0.8}]}]}
        tr = parse_track(data)
        self.assertEqual(tr.fps, 2.0)
        self.assertEqual(tr.samples[0].faces[0].id, "A")
        self.assertEqual(tr.samples[0].faces[0].cx, 200.0)

    def test_empty(self):
        self.assertEqual(parse_track({}).samples, ())

    def test_between_filters_by_time(self):
        tr = track(samples=two_speakers(n=40))
        self.assertEqual(len(tr.between(5.0, 10.0)), 10)


if __name__ == "__main__":
    unittest.main()


class TestTrackScaling(unittest.TestCase):
    """A detector normally runs on a downscaled copy — that is why frame_w is
    in the schema. Applying its coordinates raw puts every crop at roughly half
    the correct x, silently."""

    def half_res_track(self, n=20):
        return SpeakerTrack(fps=2, frame_w=960, frame_h=540, samples=tuple(
            TrackSample(t=i * 0.5, faces=(
                Face(x=700, y=150, w=100, h=100, id="A", speaking=0.9),))
            for i in range(n)))

    def test_scale_factor(self):
        self.assertEqual(self.half_res_track().scale_to(1920), 2.0)

    def test_missing_frame_width_is_a_no_op(self):
        tr = SpeakerTrack(fps=2, frame_w=0, frame_h=0, samples=())
        self.assertEqual(tr.scale_to(1920), 1.0)

    def test_centre_crop_uses_full_resolution_coordinates(self):
        scaled = plan_reframe("center", 0, 10, HD, self.half_res_track())
        raw = plan_reframe("center", 0, 10, HD, SpeakerTrack(
            fps=2, frame_w=1920, frame_h=1080,
            samples=self.half_res_track().samples))
        self.assertNotEqual(scaled.rect.x, raw.rect.x)
        # 700 in a 960-wide track is 1400 in a 1920-wide frame: right of centre.
        self.assertGreater(scaled.rect.x, portrait_crop(HD).x)


class TestCropExprPrecision(unittest.TestCase):
    def test_a_sub_millisecond_interval_does_not_divide_by_zero(self):
        """dt was guarded unrounded but printed rounded, so a 4ms interval
        emitted '/0.00' and the crop x became nan for the whole clip."""
        kf = [(0.0, 100.0), (0.004, 400.0), (1.0, 500.0)]
        self.assertNotIn("/0.00", compile_crop_expr(kf))

    def test_evaluator_skips_the_same_terms_as_the_compiler(self):
        kf = [(i * 0.5, 100.0 + i * 0.001) for i in range(50)]
        self.assertEqual(compile_crop_expr(kf).count("clip("), 0)
        self.assertAlmostEqual(evaluate_crop_expr(kf, 25.0), 100.0, places=6)


class TestFacelessSamples(unittest.TestCase):
    def test_a_dropout_holds_the_current_speaker(self):
        """A head turn or a cutaway drops the detection. Letting 'nobody' claim
        the streak resets the crop to per-sample jitter."""
        samples = list(two_speakers(n=10, speaking_left=True))
        samples[5] = TrackSample(t=samples[5].t, faces=())
        samples[6] = TrackSample(t=samples[6].t, faces=())
        self.assertTrue(all(w == "A" for w in dominant_speaker(samples, 2.0)))
