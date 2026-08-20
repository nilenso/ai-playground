"""Tests for reconciling a shared baseline against this branch's rules.

The failure this guards is quiet by nature: a number computed under someone
else's taxonomy, sitting in a file that looks authoritative, feeding the prose
GEPA reasons from.
"""

from __future__ import annotations

import json

import pytest

from autoresearch import reconcile
from autoresearch.questions import Question
from tests.test_noise_floor import CLEAN, MESSY, write_attempt

BANK = [Question(id="q1", question="how many hospitals?", tier=1)]

CURL = [(["count", "-t", "place"], 1,
         "Traceback (most recent call last):\nOSError: AWS Error "
         "NETWORK_CONNECTION during HeadObject operation: curlCode: 28")]


def baseline_file(tmp_path, correctness, qid="q1"):
    p = tmp_path / "3009509.json"
    p.write_text(json.dumps({
        "sha": "3009509", "release": "2026-08-19.0",
        "correctness_impl": "proxy-v1", "repeats": 2, "skipped": [],
        "questions": {qid: {"tokens": 1000.0, "duration_ms": 2000.0,
                            "correctness": correctness}},
    }, indent=2))
    return p


class TestReconcile:
    def test_a_baseline_scored_the_same_way_shows_no_divergence(self, tmp_path):
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
        result = reconcile.check(baseline_file(tmp_path, 1.0), a, BANK)
        assert result["agree"] == ["q1"] and not result["diverge"]

    def test_a_network_timeout_scored_as_a_tool_error_is_caught(self, tmp_path):
        # The one way the two branches differ. The measuring branch files the
        # curl timeout into errors and docks correctness; this branch does not.
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CURL + CLEAN)
        result = reconcile.check(baseline_file(tmp_path, 0.7), a, BANK)
        assert "q1" in result["diverge"]
        assert result["diverge"]["q1"]["ours"] == pytest.approx(1.0)

    def test_applying_changes_only_the_computed_number(self, tmp_path):
        # Tokens and duration are raw readings carrying no scoring rules.
        # Rewriting them would be overreach and would corrupt efficiency.
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CURL + CLEAN)
        p = baseline_file(tmp_path, 0.7)
        reconcile.apply(p, reconcile.check(p, a, BANK))
        after = json.loads(p.read_text())["questions"]["q1"]
        assert after["correctness"] == pytest.approx(1.0)
        assert after["tokens"] == 1000.0 and after["duration_ms"] == 2000.0

    def test_applying_records_what_it_changed(self, tmp_path):
        # An overwritten number that does not say it was overwritten is the
        # same class of undetectable defect we have been chasing all day.
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CURL + CLEAN)
        p = baseline_file(tmp_path, 0.7)
        reconcile.apply(p, reconcile.check(p, a, BANK))
        record = json.loads(p.read_text())["correctness_overrides"]["q1"]
        assert record["was"] == 0.7 and record["now"] == pytest.approx(1.0)
        assert "network timeout" in record["why"]

    def test_the_override_record_does_not_break_loading(self, tmp_path, monkeypatch):
        # It sits at the top level for exactly this reason: Reading(**v) has no
        # room for extras, so a per-question field would break every reader.
        from autoresearch import baseline
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CURL + CLEAN)
        p = baseline_file(tmp_path, 0.7)
        reconcile.apply(p, reconcile.check(p, a, BANK))
        monkeypatch.setattr(baseline, "path_for", lambda sha: p)
        assert baseline.load("3009509")["q1"].correctness == pytest.approx(1.0)

    def test_applying_nothing_when_they_agree(self, tmp_path):
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
        p = baseline_file(tmp_path, 1.0)
        assert reconcile.apply(p, reconcile.check(p, a, BANK)) == 0
        assert "correctness_overrides" not in json.loads(p.read_text())

    def test_a_question_with_no_retained_attempts_is_named_not_assumed_equal(self, tmp_path):
        # Silently treating "cannot check" as agreement is how this survives.
        a = tmp_path / "attempts"
        a.mkdir()
        result = reconcile.check(baseline_file(tmp_path, 0.7), a, BANK)
        assert "q1" in result["unchecked"]
        assert not result["diverge"] and not result["agree"]


class TestRefusesAnUnusableBaseline:
    """A withdrawn baseline is renamed, not deleted, so the numbers survive for
    forensics. That leaves it on disk one careless argument away from being
    used as a yardstick -- which nearly happened."""

    def _attempts(self, tmp_path):
        a = tmp_path / "attempts"
        for r in (1, 2):
            write_attempt(a, "q1", r, argv_list=CLEAN)
        return a

    def test_a_file_marked_incomplete_is_refused(self, tmp_path):
        p = baseline_file(tmp_path, 1.0)
        withdrawn = p.parent / "3009509.INCOMPLETE-5of30.json"
        p.rename(withdrawn)
        with pytest.raises(SystemExit, match="INCOMPLETE"):
            reconcile.check(withdrawn, self._attempts(tmp_path), BANK)

    def test_a_file_marked_stale_is_refused(self, tmp_path):
        p = baseline_file(tmp_path, 1.0)
        stale = p.parent / "3009509.release-2026-07-22.0.STALE.json"
        p.rename(stale)
        with pytest.raises(SystemExit, match="STALE"):
            reconcile.check(stale, self._attempts(tmp_path), BANK)

    def test_a_baseline_missing_questions_is_refused_by_default(self, tmp_path):
        # The 5-of-30 case. Reconciling it yields a report that is right about
        # the five and silent about the rest, which reads as a completed check.
        bank = BANK + [Question(id="q2", question="?", tier=1)]
        with pytest.raises(SystemExit, match="covers 1 of 2"):
            reconcile.check(baseline_file(tmp_path, 1.0), self._attempts(tmp_path), bank)

    def test_the_refusal_names_what_is_missing(self, tmp_path):
        bank = BANK + [Question(id="q2", question="?", tier=1)]
        with pytest.raises(SystemExit, match="q2"):
            reconcile.check(baseline_file(tmp_path, 1.0), self._attempts(tmp_path), bank)

    def test_a_partial_baseline_can_be_used_deliberately(self, tmp_path):
        bank = BANK + [Question(id="q2", question="?", tier=1)]
        result = reconcile.check(baseline_file(tmp_path, 1.0), self._attempts(tmp_path),
                                 bank, allow_partial=True)
        assert result["agree"] == ["q1"]

    def test_a_complete_canonical_baseline_passes(self, tmp_path):
        result = reconcile.check(baseline_file(tmp_path, 1.0), self._attempts(tmp_path),
                                 BANK)
        assert result["agree"] == ["q1"]
