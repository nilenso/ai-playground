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
