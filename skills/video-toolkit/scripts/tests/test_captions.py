"""Caption phrasing, safe areas, and both rendering back ends.

None of this needs ffmpeg: the back ends are string generation, which is exactly
why the ASS one is worth building even on a machine whose ffmpeg cannot burn it.
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vtlib.captions import (  # noqa: E402
    DEFAULT_PAUSE, MIN_PHRASE_SECONDS, CaptionStyle, TimedWord, apply_case,
    ass_color, ass_escape, ass_time, caption_box, clip_words, default_case,
    distribute_word_times, expand_segments, group_phrases, render_ass,
    render_drawtext, resolve_font, text_block_rect,
)

STYLE = CaptionStyle()


def words(*pairs, d=0.3):
    return [TimedWord(t=t, d=d, w=w) for t, w in pairs]


class TestSafeArea(unittest.TestCase):
    def test_box_matches_the_documented_rectangle(self):
        self.assertEqual(tuple(caption_box().__dict__.values()),
                         (81, 192, 999, 1632))

    def test_text_block_clears_the_bottom_rail_at_every_size(self):
        """Bottom 15% is TikTok's caption/CTA rail. Text under it is unreadable."""
        box = caption_box()
        for size in (64, 80, 96, 120):
            for lines in (1, 2, 3):
                s = CaptionStyle(font_size=size)
                x0, y0, x1, y1 = text_block_rect(lines, s)
                self.assertGreaterEqual(y0, box.y0,
                                        f"{size}px x{lines} runs into the top")
                self.assertLessEqual(y1, box.y1,
                                     f"{size}px x{lines} runs into the rail")

    def test_block_is_horizontally_inside_the_box(self):
        box = caption_box()
        x0, _, x1, _ = text_block_rect(2, STYLE)
        self.assertGreaterEqual(x0, box.x0)
        self.assertLessEqual(x1, box.x1)


class TestClipRelativeTiming(unittest.TestCase):
    """The renderer seeks with -ss before -i and resets PTS, so a caption still
    carrying source timestamps lands `start` seconds late. This is the single
    conversion, and the classic place a caption pipeline drifts."""

    def test_times_are_rebased_to_zero(self):
        src = [{"t": 100.0, "w": "a", "d": 0.4}, {"t": 101.5, "w": "b", "d": 0.4}]
        out = clip_words(src, 100.0, 110.0)
        self.assertEqual([w.t for w in out], [0.0, 1.5])

    def test_words_outside_the_window_are_dropped(self):
        src = [{"t": 99.0, "w": "before"}, {"t": 105.0, "w": "inside"},
               {"t": 120.0, "w": "after"}]
        self.assertEqual([w.w for w in clip_words(src, 100.0, 110.0)], ["inside"])

    def test_a_word_is_not_allowed_to_run_past_the_clip(self):
        src = [{"t": 109.5, "w": "tail", "d": 5.0}]
        self.assertLessEqual(clip_words(src, 100.0, 110.0)[0].end, 10.0)

    def test_blank_words_are_dropped(self):
        self.assertEqual(clip_words([{"t": 0.0, "w": "   "}], 0, 10), [])


class TestSegmentFallback(unittest.TestCase):
    def test_durations_sum_to_the_cue_exactly(self):
        out = distribute_word_times("one two three four", 5.0, 2.0)
        self.assertAlmostEqual(out[-1].end - out[0].t, 2.0, places=6)

    def test_times_are_monotonic(self):
        out = distribute_word_times("a bb ccc dddd", 0.0, 3.0)
        self.assertEqual([w.t for w in out], sorted(w.t for w in out))

    def test_longer_words_get_longer_slots(self):
        out = distribute_word_times("a wwwwwwwwww", 0.0, 2.0)
        self.assertLess(out[0].d, out[1].d)

    def test_single_word_takes_the_whole_cue(self):
        out = distribute_word_times("solo", 1.0, 2.0)
        self.assertEqual((out[0].t, round(out[0].d, 6)), (1.0, 2.0))

    def test_empty_text(self):
        self.assertEqual(distribute_word_times("", 0.0, 1.0), [])

    def test_expand_segments_leaves_single_words_alone(self):
        src = [TimedWord(t=0.0, d=0.3, w="hello")]
        self.assertEqual(expand_segments(src), src)

    def test_expand_segments_splits_a_cue(self):
        src = [TimedWord(t=0.0, d=1.2, w="three words here")]
        self.assertEqual([w.w for w in expand_segments(src)],
                         ["three", "words", "here"])


class TestPhrasing(unittest.TestCase):
    def test_a_phrase_never_spans_a_break(self):
        """Captions and cuts must tell the same story, so the artifact that
        governs clip edges governs caption edges too."""
        ws = words((0.0, "one"), (0.4, "two"), (0.8, "three"), (1.2, "four"))
        phrases = group_phrases(ws, breaks=[1.1])
        for p in phrases:
            self.assertFalse(p.start < 1.1 < p.end,
                             f"phrase {p.start}-{p.end} spans the break")

    def test_a_long_gap_starts_a_new_phrase(self):
        ws = words((0.0, "one"), (0.4, "two"), (5.0, "later"))
        self.assertGreater(len(group_phrases(ws, breaks=[])), 1)

    def test_line_word_cap_is_respected(self):
        ws = words(*[(i * 0.4, "w") for i in range(12)])
        for p in group_phrases(ws, breaks=[]):
            for line in p.lines:
                self.assertLessEqual(len(line), 3)

    def test_line_char_cap_is_respected(self):
        ws = words(*[(i * 0.4, "elephantine") for i in range(6)])
        for p in group_phrases(ws, breaks=[]):
            for line in p.lines:
                self.assertLessEqual(sum(len(w.w) + 1 for w in line), 25)

    def test_no_phrase_is_a_sub_threshold_flash(self):
        ws = words(*[(i * 0.1, "w") for i in range(20)], d=0.1)
        for p in group_phrases(ws, breaks=[]):
            self.assertGreaterEqual(p.end - p.start, MIN_PHRASE_SECONDS * 0.5)

    def test_none_pause_threshold_does_not_split_every_word(self):
        """transcript.json carries None when the pause pass never ran; reading
        that as 0.0 would make every single word its own phrase."""
        ws = words(*[(i * 0.4, "w") for i in range(9)])
        as_none = group_phrases(ws, breaks=[], pause_threshold=None)
        as_default = group_phrases(ws, breaks=[], pause_threshold=DEFAULT_PAUSE)
        self.assertEqual(len(as_none), len(as_default))
        self.assertLess(len(as_none), len(ws))

    def test_zero_pause_threshold_is_also_treated_as_unset(self):
        ws = words(*[(i * 0.4, "w") for i in range(9)])
        self.assertLess(len(group_phrases(ws, breaks=[], pause_threshold=0.0)),
                        len(ws))

    def test_every_word_survives_phrasing(self):
        ws = words(*[(i * 0.4, f"w{i}") for i in range(15)])
        out = [w.w for p in group_phrases(ws, breaks=[2.0, 4.0]) for w in p.words]
        self.assertEqual(out, [w.w for w in ws])

    def test_empty_input(self):
        self.assertEqual(group_phrases([], breaks=[]), [])


class TestCasing(unittest.TestCase):
    def test_upper(self):
        self.assertEqual(apply_case("don't stop", "upper"), "DON'T STOP")

    def test_as_is_leaves_text_alone(self):
        self.assertEqual(apply_case("Don't Stop", "as-is"), "Don't Stop")

    def test_sentence_uppercases_known_acronyms(self):
        self.assertEqual(apply_case("api", "sentence"), "API")

    def test_sentence_leaves_ordinary_words_alone(self):
        self.assertEqual(apply_case("apple", "sentence"), "apple")

    def test_default_case_follows_punctuation(self):
        self.assertEqual(default_case(False), "upper")
        self.assertEqual(default_case(True), "as-is")


class TestAss(unittest.TestCase):
    def test_colour_bytes_are_reversed(self):
        """ASS is &HAABBGGRR, not RGB. Getting this wrong is silent and ugly."""
        self.assertEqual(ass_color(255, 229, 0), "&H0000E5FF")
        self.assertEqual(ass_color(0, 0, 0), "&H00000000")

    def test_time_format(self):
        self.assertEqual(ass_time(0.0), "0:00:00.00")
        self.assertEqual(ass_time(3661.25), "1:01:01.25")
        self.assertEqual(ass_time(-5.0), "0:00:00.00")

    def test_braces_are_escaped(self):
        self.assertEqual(ass_escape("a {b} c"), r"a \{b\} c")

    def test_newlines_do_not_break_the_event_line(self):
        self.assertNotIn("\n", ass_escape("a\nb"))

    def test_one_dialogue_event_per_word(self):
        ws = words((0.0, "one"), (0.4, "two"), (0.8, "three"))
        out = render_ass(group_phrases(ws, breaks=[]), STYLE, "Arial")
        self.assertEqual(out.count("Dialogue:"), 3)

    def test_header_resolution_matches_the_output(self):
        out = render_ass(group_phrases(words((0.0, "x")), breaks=[]),
                         STYLE, "Arial")
        self.assertIn("PlayResX: 1080", out)
        self.assertIn("PlayResY: 1920", out)

    def test_every_event_is_absolutely_positioned_in_the_safe_area(self):
        ws = words((0.0, "one"), (0.4, "two"))
        out = render_ass(group_phrases(ws, breaks=[]), STYLE, "Arial")
        box = caption_box()
        ys = [int(m) for m in re.findall(r"\\pos\(\d+,(\d+)\)", out)]
        self.assertTrue(ys)
        for y in ys:
            self.assertTrue(box.y0 < y < box.y1)

    def test_highlight_can_be_disabled(self):
        ws = words((0.0, "one"), (0.4, "two"))
        plain = render_ass(group_phrases(ws, breaks=[]),
                           CaptionStyle(highlight=False), "Arial")
        self.assertNotIn(r"\fscx112", plain)


class TestDrawtext(unittest.TestCase):
    def chain(self, ws, style=STYLE):
        return render_drawtext(group_phrases(ws, breaks=[]), style, "/f/Arial.ttf")

    def test_one_instance_and_one_sidecar_per_word(self):
        ws = words((0.0, "one"), (0.4, "two"), (0.8, "three"))
        chain, sidecars = self.chain(ws)
        self.assertEqual(chain.count("drawtext="), 3)
        self.assertEqual(len(sidecars), 3)

    def test_text_goes_in_a_sidecar_not_inline(self):
        """Escaping caption text through both the filtergraph and drawtext
        parsers is not reliably solvable — `[go], ok` gets parsed as a font."""
        chain, sidecars = self.chain(words((0.0, "it's 50%: [go], ok")))
        self.assertIn("textfile=", chain)
        # ":text=" would be the inline form; "drawtext=" itself contains "text=".
        self.assertNotIn(":text=", chain)
        self.assertEqual(sidecars[0].content, "IT'S 50%: [GO], OK")

    def test_expansion_is_disabled_on_every_instance(self):
        """A literal % otherwise emits `Stray %` on every frame."""
        chain, sidecars = self.chain(words((0.0, "100%"), (0.4, "sure")))
        self.assertEqual(chain.count("expansion=none"), len(sidecars))

    def test_enable_windows_are_monotonic_and_clip_relative(self):
        ws = words((0.0, "one"), (0.5, "two"), (1.0, "three"))
        chain, _ = self.chain(ws)
        spans = [(float(a), float(b)) for a, b in
                 re.findall(r"between\(t,([\d.]+),([\d.]+)\)", chain)]
        self.assertEqual(spans, sorted(spans))
        self.assertLess(spans[0][0], 0.001)

    def test_windows_do_not_overlap(self):
        ws = words((0.0, "one"), (0.5, "two"), (1.0, "three"))
        chain, _ = self.chain(ws)
        spans = [(float(a), float(b)) for a, b in
                 re.findall(r"between\(t,([\d.]+),([\d.]+)\)", chain)]
        for (_, end), (nxt, _) in zip(spans, spans[1:]):
            self.assertLessEqual(end, nxt + 1e-6)

    def test_sidecar_paths_are_unique(self):
        ws = words(*[(i * 0.4, "same") for i in range(6)])
        _, sidecars = self.chain(ws)
        self.assertEqual(len({s.path for s in sidecars}), len(sidecars))

    def test_font_path_is_absolute_and_escaped(self):
        chain, _ = render_drawtext(
            group_phrases(words((0.0, "x")), breaks=[]), STYLE,
            "/System/Fonts/Arial Bold.ttf")
        self.assertIn("fontfile='/System/Fonts/Arial Bold.ttf'", chain)


class TestFontResolution(unittest.TestCase):
    def test_first_existing_candidate_wins(self):
        found = resolve_font(["/nope.ttf", "/yes.ttf", "/also.ttf"],
                             exists=lambda p: p == "/yes.ttf")
        self.assertEqual(found, "/yes.ttf")

    def test_blank_entries_are_skipped(self):
        self.assertEqual(resolve_font(["", "/yes.ttf"], lambda p: p == "/yes.ttf"),
                         "/yes.ttf")

    def test_no_font_names_what_was_tried(self):
        """No fontconfig means drawtext=font=Arial fails with 'Option not
        found', and the repo ships no font binaries."""
        with self.assertRaises(ValueError) as cm:
            resolve_font(["/a.ttf", "/b.ttf"], lambda p: False)
        self.assertIn("VT_FONT", str(cm.exception))
        self.assertIn("/a.ttf", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
