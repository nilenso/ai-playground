"""Tests for the noise floor.

The number this produces decides whether a candidate's gain gets believed, so
a quiet mistake here would be expensive in the most annoying way: it would not
break anything, it would just make us wrong about what we found.
"""

from __future__ import annotations

import json

import pytest

from autoresearch import config, noise_floor
from autoresearch.questions import Question


def write_attempt(root, qid, repeat, *, argv_list, answer="12 hospitals",
                  turns=2, tokens=1000, ms=1000):
    d = root / f"{qid}__r{repeat}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "commands.jsonl").write_text("\n".join(
        json.dumps({"argv": argv, "exit_code": code, "stdout": "", "stderr": err,
                    "duration": 1.0})
        for argv, code, err in argv_list
    ))
    (d / "transcript.jsonl").write_text(json.dumps({
        "type": "result", "result": answer, "is_error": False,
        "total_cost_usd": 0.25, "duration_ms": ms, "num_turns": turns,
        "usage": {"input_tokens": tokens},
    }))
    return d


CLEAN = [(["count", "-t", "place"], 0, "")]
MESSY = [(["count", "--category", "cafe"], 1, "Error: no such option: --category"),
         (["count", "-t", "place"], 0, "")]
BANK = [Question(id="q1", question="how many hospitals?", tier=1)]


class TestNoiseFloor:
    def test_two_identical_runs_have_no_wobble(self, tmp_path):
        a, b = tmp_path / "a", tmp_path / "b"
        for root in (a, b):
            for r in (1, 2):
                write_attempt(root, "q1", r, argv_list=CLEAN)
        result = noise_floor.compare(a, b, BANK)
        assert result["paired"]["q1"]["struggle"] == pytest.approx(0.0)
        assert result["objective"]["max"] == pytest.approx(0.0)

    def test_a_run_that_flailed_shows_up_as_wobble(self, tmp_path):
        a, b = tmp_path / "a", tmp_path / "b"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
            write_attempt(b, "q1", r, argv_list=MESSY)
        result = noise_floor.compare(a, b, BANK)
        # The wasted command is what differs, so that is the term that must move.
        assert result["paired"]["q1"]["waste"] > 0
        assert result["paired"]["q1"]["struggle"] > 0

    def test_a_question_missing_from_one_run_is_named_not_skipped(self, tmp_path):
        # A floor computed over only the questions that happened to survive
        # would not be a floor.
        a, b = tmp_path / "a", tmp_path / "b"
        write_attempt(a, "q1", 1, argv_list=CLEAN)
        b.mkdir()
        result = noise_floor.compare(a, b, BANK)
        assert "q1" in result["dropped"]
        assert not result["paired"]

    def test_network_bound_attempts_are_excluded_as_the_evaluator_excludes_them(self, tmp_path):
        # A floor measured over attempts the real run would have discarded
        # would not describe the real run.
        a, b = tmp_path / "a", tmp_path / "b"
        curl = [(["count", "-t", "place"], 1,
                 "Traceback (most recent call last):\nOSError: AWS Error "
                 "NETWORK_CONNECTION during HeadObject operation: curlCode: 28")]
        write_attempt(a, "q1", 1, argv_list=curl, answer="could not reach the data")
        write_attempt(b, "q1", 1, argv_list=CLEAN)
        result = noise_floor.compare(a, b, BANK)
        assert "q1" in result["dropped"]

    def test_the_objective_floor_is_the_weighted_sum_of_the_terms(self, tmp_path):
        a, b = tmp_path / "a", tmp_path / "b"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
            write_attempt(b, "q1", r, argv_list=MESSY)
        result = noise_floor.compare(a, b, BANK)
        row = result["paired"]["q1"]
        expected = sum(config.WEIGHTS[n] * row[n] for n in config.WEIGHTS if n in row)
        assert result["objective"]["max"] == pytest.approx(expected)

    def test_it_reports_rather_than_crashing_when_nothing_pairs(self, tmp_path):
        a, b = tmp_path / "a", tmp_path / "b"
        a.mkdir(); b.mkdir()
        assert noise_floor.compare(a, b, BANK)["paired"] == {}


class TestSkillSourceDetection:
    """Which instruction file the agent read is invisible in the score, and
    has already been wrong once without anything looking wrong."""

    def _transcript(self, tmp_path, text):
        import json
        d = tmp_path / "q1__r1"
        d.mkdir(parents=True)
        (d / "transcript.jsonl").write_text(json.dumps({
            "type": "result", "result": text, "is_error": False,
            "usage": {"input_tokens": 10},
        }))
        return d / "transcript.jsonl"

    def test_it_finds_a_user_global_skill(self, tmp_path):
        t = self._transcript(
            tmp_path,
            "Base directory for this skill: /Users/x/.claude/skills/botmap\n\n# CLI")
        assert noise_floor.skill_source(t) == "/Users/x/.claude/skills/botmap"

    def test_it_finds_a_project_scoped_skill(self, tmp_path):
        t = self._transcript(
            tmp_path,
            "Base directory for this skill: /private/var/folders/T/oa-q1-x/"
            ".claude/skills/botmap\n\n# CLI")
        assert "/private/var/folders" in noise_floor.skill_source(t)

    def test_no_skill_loaded_is_not_an_error(self, tmp_path):
        # Some questions never trigger the skill at all. That is information,
        # not a failure, and must not crash the analysis.
        assert noise_floor.skill_source(self._transcript(tmp_path, "12 hospitals")) is None

    def test_a_missing_transcript_is_not_an_error(self, tmp_path):
        assert noise_floor.skill_source(tmp_path / "absent.jsonl") is None

    def test_runs_reading_different_instruction_files_are_flagged(self, tmp_path):
        import json
        a, b = tmp_path / "a", tmp_path / "b"
        for root, where in ((a, "/Users/x/.claude/skills/botmap"),
                            (b, "/private/var/folders/T/oa/.claude/skills/botmap")):
            for r in (1, 2):
                d = write_attempt(root, "q1", r, argv_list=CLEAN)
                (d / "transcript.jsonl").write_text(json.dumps({
                    "type": "result",
                    "result": f"Base directory for this skill: {where}\n\nok",
                    "is_error": False, "duration_ms": 1000, "num_turns": 2,
                    "usage": {"input_tokens": 1000},
                }))
        result = noise_floor.compare(a, b, BANK)
        assert not result["skills_consistent"]
        assert "user-global" in result["skill_sources"]["run_a"]
        assert "project-scoped" in result["skill_sources"]["run_b"]

    def test_a_project_that_lives_under_home_is_not_mistaken_for_the_global_one(self, tmp_path):
        # ~/work/thing/.claude/skills/botmap is project-scoped, not global.
        # Both paths end in .claude/skills/botmap, so only the root tells them
        # apart -- and getting this backwards would report the bug as fixed
        # while it was still happening.
        import json
        a, b = tmp_path / "a", tmp_path / "b"
        for root, where in ((a, "/Users/someone/work/thing/.claude/skills/botmap"),
                            (b, "/Users/someone/other/.claude/skills/botmap")):
            d = write_attempt(root, "q1", 1, argv_list=CLEAN)
            (d / "transcript.jsonl").write_text(json.dumps({
                "type": "result",
                "result": f"Base directory for this skill: {where}\n\nok",
                "is_error": False, "duration_ms": 1000, "num_turns": 2,
                "usage": {"input_tokens": 1000},
            }))
        result = noise_floor.compare(a, b, BANK)
        assert result["skill_sources"]["run_a"] == {"project-scoped": 1}
        assert result["skills_consistent"]


class TestCrossConditionVerdict:
    """The same arithmetic answers two different questions. Between repeats it
    measures noise; between two setups it measures whether they behave alike.
    The verdict is what keeps those apart in the reader's head."""

    def _result(self, p90):
        return {"objective": {"p90": p90},
                "summary": {n: {"p90": 0.0} for n in
                            ("path", "waste", "silent", "recovery")}}

    def test_a_divergence_inside_the_floor_reads_as_interchangeable(self):
        assert "WITHIN the floor" in noise_floor._verdict(self._result(0.02), 0.05)

    def test_a_divergence_beyond_the_floor_reads_as_not_interchangeable(self):
        text = noise_floor._verdict(self._result(0.12), 0.05)
        assert "EXCEEDS the floor" in text and "0.070" in text

    def test_exactly_at_the_floor_is_allowed(self):
        assert "WITHIN the floor" in noise_floor._verdict(self._result(0.05), 0.05)

    def test_it_names_which_term_moved_most(self):
        # A path change can move turns and commands while correctness sits
        # still, so the headline number alone can hide the thing that matters.
        r = self._result(0.10)
        r["summary"]["path"]["p90"] = 0.4
        assert "path 0.400" in noise_floor._verdict(r, 0.05)


class TestWithinRunFloor:
    """A five-question run-to-run floor is too thin to lean on: at n=5 the
    90th percentile lands on the largest value, so one unlucky question sets
    the threshold. One 30-question run already holds thirty repeat-pairs."""

    def test_identical_repeats_show_no_wobble(self, tmp_path):
        a = tmp_path / "run"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
        assert noise_floor.compare_repeats(a, BANK)["paired"]["q1"]["struggle"] == \
            pytest.approx(0.0)

    def test_repeats_that_behaved_differently_show_wobble(self, tmp_path):
        a = tmp_path / "run"
        write_attempt(a, "q1", 1, argv_list=CLEAN)
        write_attempt(a, "q1", 2, argv_list=MESSY)
        assert noise_floor.compare_repeats(a, BANK)["paired"]["q1"]["struggle"] > 0

    def test_it_uses_only_the_two_repeats_it_was_asked_for(self, tmp_path):
        # A third repeat must not be silently folded into either side.
        a = tmp_path / "run"
        write_attempt(a, "q1", 1, argv_list=CLEAN)
        write_attempt(a, "q1", 2, argv_list=CLEAN)
        write_attempt(a, "q1", 3, argv_list=MESSY)
        assert noise_floor.compare_repeats(a, BANK)["paired"]["q1"]["struggle"] == \
            pytest.approx(0.0)

    def test_a_missing_second_repeat_is_named_not_skipped(self, tmp_path):
        a = tmp_path / "run"
        write_attempt(a, "q1", 1, argv_list=CLEAN)
        result = noise_floor.compare_repeats(a, BANK)
        assert "q1" in result["dropped"] and "repeat 2" in result["dropped"]["q1"]


class TestTheCaveatTravelsWithTheNumber:
    """Today's recurring lesson: a figure gets separated from its caveats.
    The limitation has to be in the artifact, not only in the writeup."""

    def _within(self, tmp_path):
        a = tmp_path / "run"
        write_attempt(a, "q1", 1, argv_list=CLEAN)
        write_attempt(a, "q1", 2, argv_list=MESSY)
        return noise_floor.compare_repeats(a, BANK)

    def _across(self, tmp_path):
        a, b = tmp_path / "a", tmp_path / "b"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
            write_attempt(b, "q1", r, argv_list=MESSY)
        return noise_floor.compare(a, b, BANK)

    def test_a_within_run_floor_says_it_is_a_lower_bound(self, tmp_path):
        text = noise_floor.render(self._within(tmp_path))
        assert "LOWER BOUND" in text and "the real floor is HIGHER" in text

    def test_it_says_what_may_and_may_not_be_concluded(self, tmp_path):
        # Exceeding a lower bound is necessary, not sufficient. Without this
        # the number reads as permission to believe a movement.
        text = noise_floor.render(self._within(tmp_path))
        assert "is unproven" in text and "NOT thereby proven" in text

    def test_a_real_run_to_run_floor_carries_no_such_caveat(self, tmp_path):
        text = noise_floor.render(self._across(tmp_path))
        assert "LOWER BOUND" not in text and "the real floor is HIGHER" not in text

    def test_clearing_a_lower_bound_is_not_reported_as_proof(self, tmp_path):
        r = self._within(tmp_path)
        text = noise_floor._verdict(r, 0.01, floor_is_lower_bound=True)
        assert "NOT proof" in text and "EXCEEDS" not in text

    def test_clearing_a_real_floor_is_reported_as_a_difference(self, tmp_path):
        r = self._across(tmp_path)
        assert "EXCEEDS the floor" in noise_floor._verdict(r, 0.01)
