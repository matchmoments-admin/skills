"""Filter-graph assembly, the loudnorm parser, and the encode argv.

All string generation, so none of it needs ffmpeg. The graphs themselves were
verified against ffmpeg 4.3.2 by rendering all four layouts; these tests keep
that shape from drifting.
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.errors import VtError  # noqa: E402
from vtlib.graph import (  # noqa: E402
    Measured, TargetSpec, compile_audio_graph, compile_graph,
    compile_video_graph, ffmpeg_argv, loudnorm_filter, loudnorm_probe_argv,
    parse_loudnorm_json,
)
from vtlib.reframe import (  # noqa: E402
    Face, SourceInfo, SpeakerTrack, TrackSample, plan_reframe,
)

HD = SourceInfo(width=1920, height=1080, fps=30, duration=600)
TARGET = TargetSpec()
MEASURED = Measured(input_i=-19.84, input_tp=-1.33, input_lra=1.8,
                    input_thresh=-30.03, target_offset=0.08)

REAL_STDERR = """\
[Parsed_loudnorm_0 @ 0x600001]
{
	"input_i" : "-19.84",
	"input_tp" : "-1.33",
	"input_lra" : "1.80",
	"input_thresh" : "-30.03",
	"output_i" : "-14.00",
	"target_offset" : "0.08"
}
"""


def moving_track(start=0.0, n=12):
    return SpeakerTrack(fps=2, frame_w=1920, frame_h=1080, samples=tuple(
        TrackSample(t=start + i * 0.5,
                    faces=(Face(x=200 + i * 80, y=300, w=200, h=200,
                                id="A", speaking=0.9),))
        for i in range(n)))


class TestLoudnormParser(unittest.TestCase):
    def test_parses_a_real_stderr_block(self):
        m = parse_loudnorm_json(REAL_STDERR)
        self.assertEqual(m.input_i, -19.84)
        self.assertEqual(m.target_offset, 0.08)

    def test_values_arrive_as_strings_and_are_coerced(self):
        self.assertIsInstance(parse_loudnorm_json(REAL_STDERR).input_lra, float)

    def test_trailing_log_lines_after_the_block(self):
        noisy = REAL_STDERR + "\nsize=N/A time=00:00:06.00 bitrate=N/A\n"
        self.assertEqual(parse_loudnorm_json(noisy).input_i, -19.84)

    def test_leading_log_noise_before_the_block(self):
        noisy = "ffmpeg version 4.3.2\nStream #0:0 ...\n" + REAL_STDERR
        self.assertEqual(parse_loudnorm_json(noisy).input_i, -19.84)

    def test_minus_inf_true_peak_on_silence(self):
        silent = REAL_STDERR.replace('"-1.33"', '"-inf"')
        self.assertEqual(parse_loudnorm_json(silent).input_tp, float("-inf"))

    def test_missing_block_is_an_error(self):
        with self.assertRaises(VtError):
            parse_loudnorm_json("ffmpeg version 4.3.2\nno json here\n")

    def test_a_json_object_that_is_not_the_measurement_is_skipped(self):
        other = '{"unrelated": "1"}\n' + REAL_STDERR
        self.assertEqual(parse_loudnorm_json(other).input_i, -19.84)


class TestLoudnormFilter(unittest.TestCase):
    def test_pass_one_asks_for_json(self):
        f = loudnorm_filter(TARGET, None)
        self.assertIn("print_format=json", f)
        self.assertNotIn("measured_I", f)

    def test_pass_two_feeds_the_measurements_back(self):
        """Single-pass loudnorm is a dynamic normaliser and pumps audibly on
        speech containing laughter — exactly what this pipeline selects for."""
        f = loudnorm_filter(TARGET, MEASURED)
        self.assertIn("measured_I=-19.84", f)
        self.assertIn("linear=true", f)
        self.assertNotIn("print_format", f)

    def test_targets_are_carried(self):
        self.assertIn("I=-14.0", loudnorm_filter(TARGET, None))
        self.assertIn("TP=-1.0", loudnorm_filter(TARGET, None))

    def test_minus_inf_measurement_is_clamped(self):
        m = Measured(input_i=-70.0, input_tp=float("-inf"), input_lra=0.0,
                     input_thresh=-80.0, target_offset=0.0)
        self.assertNotIn("-inf", loudnorm_filter(TARGET, m))


class TestVideoGraph(unittest.TestCase):
    def graph_for(self, layout, track=None):
        return compile_video_graph(
            plan_reframe(layout, 0, 30, HD, track), TARGET)

    def test_every_layout_terminates_in_the_v_label(self):
        for layout in ("center", "split", "fit"):
            self.assertTrue(self.graph_for(layout).endswith("[v]"), layout)
        self.assertTrue(self.graph_for("path", moving_track()).endswith("[v]"))

    def test_every_layout_starts_from_the_input(self):
        for layout in ("center", "split", "fit"):
            self.assertTrue(self.graph_for(layout).startswith("[0:v]"), layout)

    def test_timestamps_are_reset_in_every_layout(self):
        for layout in ("center", "split", "fit"):
            self.assertIn("setpts=PTS-STARTPTS", self.graph_for(layout))

    def test_pixel_format_is_set_before_captions(self):
        g = compile_video_graph(plan_reframe("center", 0, 30, HD), TARGET,
                                captions="drawtext=x")
        self.assertLess(g.index("format=yuv420p"), g.index("drawtext=x"))

    def test_captions_are_optional(self):
        self.assertNotIn("drawtext", self.graph_for("center"))

    def test_fps_and_sar_are_pinned(self):
        g = self.graph_for("center")
        self.assertIn("fps=30", g)
        self.assertIn("setsar=1", g)

    def test_split_stacks_two_half_height_panes(self):
        g = self.graph_for("split")
        self.assertIn("vstack=inputs=2", g)
        self.assertEqual(g.count("scale=1080:960:flags=lanczos"), 2)

    def test_fit_crops_nothing_and_blurs_a_background(self):
        g = self.graph_for("fit")
        self.assertIn("gblur", g)
        self.assertIn("force_original_aspect_ratio=increase", g)
        self.assertIn("overlay=", g)

    def test_path_uses_a_time_varying_crop(self):
        g = self.graph_for("path", moving_track())
        self.assertRegex(g, r"crop=\d+:\d+:x='[^']*clip\(")

    def test_no_label_is_defined_twice(self):
        for layout in ("split", "fit"):
            g = self.graph_for(layout)
            defs = re.findall(r"\]([a-z]+)\];", g + ";")
            self.assertEqual(len(defs), len(set(defs)), f"{layout}: {defs}")

    def test_split_without_panes_is_an_error(self):
        from vtlib.reframe import ReframePlan
        with self.assertRaises(VtError):
            compile_video_graph(ReframePlan(layout="split"), TARGET)

    def test_path_without_an_expression_is_an_error(self):
        from vtlib.reframe import ReframePlan
        with self.assertRaises(VtError):
            compile_video_graph(ReframePlan(layout="path"), TARGET)


class TestAudioGraph(unittest.TestCase):
    def test_resets_timestamps_and_resamples(self):
        a = compile_audio_graph(TARGET, MEASURED)
        self.assertIn("asetpts=PTS-STARTPTS", a)
        self.assertIn("aresample=48000", a)
        self.assertTrue(a.endswith("[a]"))

    def test_silent_source_produces_no_audio_chain(self):
        self.assertEqual(compile_audio_graph(TARGET, MEASURED, has_audio=False), "")

    def test_full_graph_joins_video_and_audio(self):
        g = compile_graph(plan_reframe("center", 0, 30, HD), TARGET,
                          measured=MEASURED)
        self.assertIn("[v];[0:a]", g)

    def test_full_graph_omits_the_join_when_silent(self):
        g = compile_graph(plan_reframe("center", 0, 30, HD), TARGET,
                          measured=MEASURED, has_audio=False)
        self.assertTrue(g.endswith("[v]"))
        self.assertNotIn("[0:a]", g)


class TestArgv(unittest.TestCase):
    def argv(self, **kw):
        return ffmpeg_argv("in.mp4", "out.mp4", "g.txt", 68.0, 30.0, TARGET, **kw)

    def test_seek_comes_before_the_input(self):
        """-ss before -i plus setpts=PTS-STARTPTS is what makes every caption
        and crop timestamp clip-relative. Reversing it drifts them by `start`."""
        a = self.argv()
        self.assertLess(a.index("-ss"), a.index("-i"))

    def test_duration_is_applied_after_the_input(self):
        a = self.argv()
        self.assertGreater(a.index("-t"), a.index("-i"))

    def test_faststart_is_set(self):
        self.assertIn("+faststart", self.argv())

    def test_pixel_format_and_profile(self):
        a = self.argv()
        self.assertIn("yuv420p", a)
        self.assertIn("high", a)

    def test_colour_is_tagged(self):
        """Untagged 1080x1920 is the usual cause of washed-out playback."""
        a = self.argv()
        for flag in ("-color_primaries", "-color_trc", "-colorspace"):
            self.assertIn(flag, a)
            self.assertEqual(a[a.index(flag) + 1], "bt709")

    def test_frame_rate_is_pinned(self):
        a = self.argv()
        self.assertEqual(a[a.index("-r") + 1], "30")

    def test_audio_is_mapped_and_encoded(self):
        a = self.argv()
        self.assertIn("[a]", a)
        self.assertIn("aac", a)

    def test_silent_source_maps_no_audio(self):
        a = self.argv(has_audio=False)
        self.assertNotIn("[a]", a)
        self.assertNotIn("-c:a", a)

    def test_metadata_is_stripped(self):
        a = self.argv()
        self.assertIn("-map_metadata", a)
        self.assertEqual(a[a.index("-map_metadata") + 1], "-1")

    def test_probe_argv_decodes_no_video_and_writes_no_file(self):
        p = loudnorm_probe_argv("in.mp4", "loudnorm=I=-14", 0.0, 10.0)
        self.assertIn("-vn", p)
        self.assertEqual(p[-1], "-")
        self.assertIn("null", p)


if __name__ == "__main__":
    unittest.main()
