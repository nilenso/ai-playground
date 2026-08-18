"""Tests for the parts where a silent mistake would be expensive."""

from __future__ import annotations

import os

import pytest

from pathlib import Path

from autoresearch import config, credits, score
from autoresearch.questions import Question, load, split
from autoresearch.taxonomy import classify
from autoresearch.trace import Call, Transcript, Usage


def call(argv=("count", "-t", "place"), exit_code=0, stderr="", stdout="") -> Call:
    return Call(list(argv), exit_code, stdout, stderr, 1.0)


def transcript(ok=True, answer="12 hospitals", tokens=1000, ms=1000) -> Transcript:
    return Transcript(
        final_answer=answer,
        completed=ok and bool(answer),
        status="ok" if ok else "error",
        usage=Usage(cost_usd=0.25, input_tokens=tokens, duration_ms=ms),
    )


QUESTION = Question(id="q1", question="how many hospitals?", tier=1)


class TestErrorNaming:
    def test_the_ambiguous_place_note_is_not_an_error(self):
        # The tool says "I picked one of several matching places". That is
        # information. Counting it as a failure would penalise correct runs.
        assert classify(call(stderr="[botmap] Ambiguous --in 'Manhattan': picked ...")) == "clean"

    def test_a_zero_result_with_a_suggestion_is_an_error_even_though_it_exited_ok(self):
        # This is the worst failure we have: it looks like "there are none
        # here", so the AI reports a confident wrong answer.
        assert classify(call(stderr="0 rows. No place has categories.primary=cafe. Did you mean:")) \
            == "bad_category_value"

    def test_a_crash_is_named_as_a_crash_not_the_generic_fallback(self):
        assert classify(call(exit_code=1, stderr="Traceback (most recent call last):\n ...")) \
            == "traceback"

    def test_something_unrecognised_still_gets_a_name(self):
        assert classify(call(exit_code=2, stderr="weird")) == "other_error"


class TestCorrectness:
    def test_a_clean_finished_attempt_scores_full_marks(self):
        a = score.analyse(QUESTION, [call()], transcript(), 1)
        assert score.correctness([a]) == 1.0

    def test_no_answer_scores_nothing(self):
        a = score.analyse(QUESTION, [call()], transcript(answer=""), 1)
        assert score.correctness([a]) == 0.0

    def test_falling_back_to_bulk_download_is_penalised_hardest(self):
        dumped = score.analyse(QUESTION, [call(argv=("download", "-t", "place"))], transcript(), 1)
        errored = score.analyse(
            QUESTION, [call(exit_code=1, stderr="no such option"), call()], transcript(), 1
        )
        assert score.correctness([dumped]) < score.correctness([errored])

    def test_recovering_from_an_error_is_penalised_less_than_not_recovering(self):
        bad = call(exit_code=1, stderr="no such option")
        stuck = score.analyse(QUESTION, [bad], transcript(), 1)
        recovered = score.analyse(QUESTION, [bad, call()], transcript(), 1)
        assert score.correctness([stuck]) < score.correctness([recovered])

    def test_a_legitimate_download_is_not_punished(self):
        allowed = Question(id="q", question="?", download_is_legitimate=True)
        a = score.analyse(allowed, [call(argv=("download", "-t", "land"))], transcript(), 1)
        assert not a.unnecessary_download
        assert score.correctness([a]) == 1.0


class TestEfficiency:
    def test_matching_the_old_tool_scores_the_midpoint(self):
        # Deliberately 0.5, not 1.0, so a change can move in either direction.
        assert score.efficiency(1000, 1000) == 0.5

    def test_faster_scores_above_the_midpoint_and_slower_below(self):
        assert score.efficiency(1000, 500) > 0.5
        assert score.efficiency(1000, 2000) < 0.5

    def test_with_nothing_to_compare_against_we_stay_neutral(self):
        # Not 1.0 — that would hand out a free win for being unmeasured.
        assert score.efficiency(None, 1234) == 0.5

    def test_the_weights_add_up_and_are_applied(self):
        assert sum(config.WEIGHTS.values()) == pytest.approx(1.0)
        assert score.objective(1.0, 0.5, 0.5) == pytest.approx(0.6 + 0.1 + 0.1)


class TestFeedback:
    """The written feedback is what GEPA actually learns from, so it has to
    contain the specifics, not just a verdict."""

    def test_it_quotes_the_commands_that_were_run(self):
        a = score.analyse(QUESTION, [call(argv=("count", "-t", "place"))], transcript(), 1)
        assert "botmap count -t place" in score.feedback(QUESTION, [a])

    def test_it_names_the_bulk_download_fallback_and_says_why_it_matters(self):
        a = score.analyse(QUESTION, [call(argv=("download", "-t", "place"))], transcript(), 1)
        text = score.feedback(QUESTION, [a])
        assert "download" in text and "PROBLEM" in text

    def test_it_includes_the_error_text_so_the_cause_is_visible(self):
        a = score.analyse(
            QUESTION, [call(exit_code=1, stderr="Error: No such option: --category")], transcript(), 1
        )
        assert "--category" in score.feedback(QUESTION, [a])

    def test_an_unmeasurable_question_says_so_rather_than_blaming_the_change(self):
        a = score.analyse(QUESTION, [], transcript(ok=False, answer=""), 1)
        assert "learned nothing" in score.feedback(QUESTION, [a])


class TestQuestionBank:
    def test_the_real_bank_loads(self):
        assert len(load()) >= 10

    def test_both_halves_of_the_split_cover_every_difficulty(self):
        # Otherwise the held-out score could be all-easy or all-hard, and
        # "does it generalise?" would be answered by accident.
        train, val = split(load())
        assert val and train
        assert {q.tier for q in val} == {q.tier for q in train}

    def test_the_split_is_the_same_every_time(self):
        bank = load()
        assert [q.id for q in split(bank)[1]] == [q.id for q in split(bank)[1]]

    def test_no_question_appears_in_both_halves(self):
        train, val = split(load())
        assert not ({q.id for q in train} & {q.id for q in val})

    def test_a_bad_id_is_rejected_with_the_offending_entry_named(self, tmp_path):
        # "__" would break the run-folder naming, so it is refused up front.
        bad = tmp_path / "q.yaml"
        bad.write_text("- id: a__b\n  question: x\n")
        with pytest.raises(SystemExit, match="must not contain"):
            load(bad)

    def test_duplicate_ids_are_rejected(self, tmp_path):
        bad = tmp_path / "q.yaml"
        bad.write_text("- id: a\n  question: x\n- id: a\n  question: y\n")
        with pytest.raises(SystemExit, match="duplicate"):
            load(bad)


class TestBlockedFiles:
    """GEPA can only edit the files we hand it. When it wants another one, we
    want to hear about it rather than silently underperform."""

    def _run_dir(self, tmp_path, log: str):
        d = tmp_path / "gepa"
        d.mkdir()
        (d / "run_log.txt").write_text(log)
        return d

    def test_it_notices_a_file_gepa_kept_asking_for(self, tmp_path):
        from autoresearch import blocked, config
        d = self._run_dir(tmp_path, "the real fix belongs in core.py, not here.\n" * 3)
        wanted = blocked.scan(d, config.lever_files("tool"), config.repo_root())
        assert wanted.out_of_scope["botmap/core.py"] == 3

    def test_files_it_is_allowed_to_edit_are_not_reported(self, tmp_path):
        # Mentioning cli.py is normal — it is in scope. Reporting it would bury
        # the signal we actually care about.
        from autoresearch import blocked, config
        d = self._run_dir(tmp_path, "rewrote cli.py and filters.py")
        wanted = blocked.scan(d, config.lever_files("tool"), config.repo_root())
        assert not wanted

    def test_no_log_is_not_an_error(self, tmp_path):
        from autoresearch import blocked, config
        d = tmp_path / "gepa"; d.mkdir()
        assert not blocked.scan(d, config.lever_files("tool"), config.repo_root())

    def test_the_report_suggests_a_concrete_next_command(self):
        from autoresearch import blocked
        w = blocked.Wanted()
        w.out_of_scope.update({"botmap/core.py": 5})
        text = blocked.report(w)
        assert "--files botmap/core.py" in text
        # and hedges, because a mention is not proof
        assert "not proof" in text

    def test_nothing_blocked_produces_no_noise(self):
        from autoresearch import blocked
        assert blocked.report(blocked.Wanted()) == ""


class TestNewFileRequests:
    """GEPA can never create a file. If it needs one, that has to reach us as a
    plain instruction, not as a workaround jammed into a file it can edit."""

    def _log(self, tmp_path, text):
        d = tmp_path / "gepa"; d.mkdir()
        (d / "run_log.txt").write_text(text)
        return d

    def test_an_explicit_request_is_captured_with_its_reason(self, tmp_path):
        from autoresearch import blocked, config
        d = self._log(tmp_path,
            "NEW FILE NEEDED: botmap/boundary.py - polygon logic does not belong in cli.py\n")
        w = blocked.scan(d, config.lever_files("tool"), config.repo_root())
        assert w.new_files["botmap/boundary.py"] == 1
        assert "polygon logic" in w.reasons["botmap/boundary.py"]

    def test_repeated_requests_are_counted(self, tmp_path):
        from autoresearch import blocked, config
        d = self._log(tmp_path, "NEW FILE NEEDED: botmap/verbs.py - needs its own module\n" * 4)
        w = blocked.scan(d, config.lever_files("tool"), config.repo_root())
        assert w.new_files["botmap/verbs.py"] == 4

    def test_a_nonexistent_file_is_not_confused_with_an_unlisted_one(self, tmp_path):
        # core.py exists but is out of scope; verbs.py does not exist at all.
        # They need different fixes, so they must not land in the same bucket.
        from autoresearch import blocked, config
        d = self._log(tmp_path, "the fix belongs in core.py, or a new botmap/verbs.py")
        w = blocked.scan(d, config.lever_files("tool"), config.repo_root())
        assert "botmap/core.py" in w.out_of_scope
        assert "botmap/core.py" not in w.new_files
        assert any("verbs.py" in f for f in w.new_files)

    def test_the_report_tells_you_to_create_the_file_first(self, tmp_path):
        from autoresearch import blocked, config
        d = self._log(tmp_path, "NEW FILE NEEDED: botmap/verbs.py - cleaner home for the verbs\n")
        text = blocked.report(blocked.scan(d, config.lever_files("tool"), config.repo_root()))
        assert "touch botmap/verbs.py" in text
        assert "cannot create files" in text

    def test_the_prompt_teaches_the_exact_marker(self):
        from autoresearch import blocked
        from autoresearch.optimize import BACKGROUND
        assert blocked.NEW_FILE_MARKER in BACKGROUND


class TestEnvFile:
    """Keys come from `.env` so a checkout is self-contained.

    The rule that matters: an already-exported variable always wins, so you can
    override one key for a single run without editing the file.
    """

    def _env_file(self, tmp_path, monkeypatch, text):
        path = tmp_path / ".env"
        path.write_text(text)
        monkeypatch.setattr(config, "ENV_FILE", path)
        return path

    def test_reads_a_key(self, tmp_path, monkeypatch):
        self._env_file(tmp_path, monkeypatch, "OPENROUTER_API_KEY=sk-test\n")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        config.load_env()
        assert os.environ["OPENROUTER_API_KEY"] == "sk-test"

    def test_exported_value_wins(self, tmp_path, monkeypatch):
        self._env_file(tmp_path, monkeypatch, "OPENROUTER_API_KEY=from-file\n")
        monkeypatch.setenv("OPENROUTER_API_KEY", "from-shell")
        config.load_env()
        assert os.environ["OPENROUTER_API_KEY"] == "from-shell"

    def test_skips_comments_quotes_and_export(self, tmp_path, monkeypatch):
        self._env_file(tmp_path, monkeypatch,
                       '# a comment\n\nexport QUOTED="sk-quoted"\nnot-a-pair\n')
        monkeypatch.delenv("QUOTED", raising=False)
        config.load_env()
        assert os.environ["QUOTED"] == "sk-quoted"

    def test_missing_file_is_not_an_error(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        config.load_env()  # must not raise

    def test_preflight_demands_the_proposer_key(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        monkeypatch.delenv(config.REFLECTION_KEY_VAR, raising=False)
        with pytest.raises(ValueError, match=config.REFLECTION_KEY_VAR):
            config.preflight()

    def test_reflection_model_goes_through_openrouter(self):
        assert config.REFLECTION_LM.startswith("openrouter/")
        assert config.REFLECTION_KEY_VAR == "OPENROUTER_API_KEY"


# oa.log() warns when called outside a real GEPA run; that is exactly the
# situation here and says nothing about the code under test.
@pytest.mark.filterwarnings("ignore::UserWarning")
class TestCandidateIsolation:
    """Each candidate must be measured from a clean copy of the tool.

    This is the invariant the whole run rests on. If edits from candidate A
    survive into candidate B, every score after A is unattributable — and a
    run costs hours and real money before anyone would notice.
    """

    class FakePool:
        """Records the order of operations, so we can assert reset comes first."""

        def __init__(self):
            self.files = None
            self.log: list[str] = []
            self.contents: dict[str, str] = {}

        def acquire(self):
            self.log.append("acquire")
            return Path("/tmp/fake-tree")

        def reset(self, tree):
            self.log.append("reset")
            self.contents.clear()

        def write_candidate(self, tree, lever, files):
            self.log.append(f"write:{','.join(sorted(files))}")
            self.contents.update(files)

    def _evaluate(self, pool, candidate, monkeypatch):
        from autoresearch.evaluator import Evaluator

        ev = Evaluator("tool", pool, reference={})
        # Stop before anything real happens: we only care about the order of
        # operations on the copy, not about the score.
        monkeypatch.setattr(Evaluator, "_broken", lambda self, tree: "stub")
        return ev(candidate, Question(id="q", tier=1, question="q?", notes=""))

    def test_reset_precedes_every_write(self, monkeypatch):
        pool = self.FakePool()
        self._evaluate(pool, {"botmap/cli.py": "a"}, monkeypatch)
        assert pool.log.index("reset") < pool.log.index("write:botmap/cli.py")

    def test_previous_candidate_does_not_survive(self, monkeypatch):
        pool = self.FakePool()
        self._evaluate(pool, {"botmap/cli.py": "broken", "botmap/filters.py": "x"},
                       monkeypatch)
        # The next candidate touches only one file. The other must not persist.
        self._evaluate(pool, {"botmap/filters.py": "y"}, monkeypatch)
        assert pool.contents == {"botmap/filters.py": "y"}, "an earlier edit leaked"


class TestWriteCandidateRefusesOutsideTheLever:
    def test_refusal_writes_nothing_at_all(self, tmp_path, monkeypatch):
        """A rejected path must not leave earlier files already written."""
        from autoresearch.worktree import Pool

        monkeypatch.setattr(config, "repo_root", lambda: tmp_path)
        pool = Pool("deadbee", files=("botmap/filters.py",))
        (tmp_path / "botmap").mkdir()
        (tmp_path / "botmap" / "filters.py").write_text("original")

        with pytest.raises(ValueError, match="botmap/core.py"):
            pool.write_candidate(tmp_path, "tool",
                                 {"botmap/filters.py": "new", "botmap/core.py": "nope"})
        assert (tmp_path / "botmap" / "filters.py").read_text() == "original"


class TestCreditsCheck:
    """A key that is merely present tells us nothing.

    Both real failures we hit look identical to a working setup if you only
    check that the variable is set: a revoked key, and a valid key on an empty
    account. Each would surface an hour into a run, after the baseline had been
    paid for.
    """

    def test_remaining_is_granted_minus_used(self):
        assert credits.Balance(granted=1340.0, used=1338.64).remaining == pytest.approx(1.36)

    def test_enough_credit_passes_and_reports_the_figure(self):
        note = credits.assess(credits.Balance(granted=100.0, used=10.0), minimum=5.0)
        assert "$90.00" in note

    def test_too_little_credit_refuses_before_the_baseline_runs(self):
        with pytest.raises(ValueError, match=r"\$1\.36"):
            credits.assess(credits.Balance(granted=1340.0, used=1338.64), minimum=5.0)

    def test_exactly_the_floor_is_allowed(self):
        assert credits.assess(credits.Balance(granted=5.0, used=0.0), minimum=5.0)

    def test_unreachable_does_not_block_the_run(self, monkeypatch, tmp_path):
        """A flaky network is not evidence against the key."""
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        monkeypatch.setenv(config.REFLECTION_KEY_VAR, "sk-or-v1-whatever")
        monkeypatch.setattr(credits, "fetch",
                            lambda key, **kw: (_ for _ in ()).throw(credits.Unreachable("dns")))
        assert "could not check" in config.preflight()["balance"]

    def test_revoked_key_stops_the_run(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        monkeypatch.setenv(config.REFLECTION_KEY_VAR, "sk-or-v1-revoked")
        monkeypatch.setattr(credits, "fetch",
                            lambda key, **kw: (_ for _ in ()).throw(credits.Unauthorized("no")))
        with pytest.raises(credits.Unauthorized):
            config.preflight()
