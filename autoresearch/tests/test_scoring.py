"""Tests for the parts where a silent mistake would be expensive."""

from __future__ import annotations

import os

import pytest

from pathlib import Path

from autoresearch import config, credits, score
from autoresearch.questions import Question, load, split
from autoresearch.taxonomy import classify
from autoresearch.score import Attempt
from autoresearch.trace import Call, Transcript, Usage


def call(argv=("count", "-t", "place"), exit_code=0, stderr="", stdout="") -> Call:
    return Call(list(argv), exit_code, stdout, stderr, 1.0)


def transcript(ok=True, answer="12 hospitals", tokens=1000, ms=1000, turns=1) -> Transcript:
    return Transcript(
        final_answer=answer,
        completed=ok and bool(answer),
        status="ok" if ok else "error",
        usage=Usage(cost_usd=0.25, input_tokens=tokens, duration_ms=ms, num_turns=turns),
    )


def silent_call() -> Call:
    """Exited 0 and matched nothing, offering the assistant no way forward.

    The tool named the field but not a value that would work, so all the
    assistant learns is "none here" -- which is what it will go on to report.
    """
    return call(stderr="0 rows. No place has categories.primary=cafe")


def hinted_call() -> Call:
    """The same wrong value, but the tool caught it and named the right one.

    The opposite outcome from `silent_call`, and the two must never be scored
    alike: this is the tool working.
    """
    return call(stderr="0 rows. No place has categories.primary=cafe. "
                       "Did you mean: coffee_shop?")


def failing_call() -> Call:
    """Failed loudly. The assistant can see this one and react to it."""
    return call(exit_code=1, stderr="Error: no such option: --category")


QUESTION = Question(id="q1", question="how many hospitals?", tier=1)


class TestErrorNaming:
    def test_the_ambiguous_place_note_is_not_an_error(self):
        # The tool says "I picked one of several matching places". That is
        # information. Counting it as a failure would penalise correct runs.
        assert classify(call(stderr="[botmap] Ambiguous --in 'Manhattan': picked ...")) == "clean"

    def test_a_zero_result_with_no_way_forward_is_the_silent_failure(self):
        # The worst failure we have: it looks like "there are none here", so
        # the AI reports a confident wrong answer.
        assert classify(silent_call()) == "bad_value_silent"

    def test_a_suggestion_is_the_opposite_of_a_silent_failure(self):
        # These two shared a label once, and it was backwards in a way that
        # actively hurt: a suggestion is PROOF the failure was not silent, yet
        # it was scored as the silent failure it prevents.
        assert classify(hinted_call()) == "bad_value_reported"

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
        w = config.WEIGHTS
        assert score.objective(1.0, 1.0, 0.5, 0.5) == pytest.approx(
            w["correctness"] + w["struggle"]
            + 0.5 * w["token_efficiency"] + 0.5 * w["wallclock"]
        )


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


class TestStruggleWeights:
    """The struggle term's shape is a claim about what matters. Assert it."""

    def test_the_struggle_weights_add_up(self):
        assert sum(config.STRUGGLE_WEIGHTS.values()) == pytest.approx(1.0)

    def test_silent_failures_carry_the_most_weight(self):
        # The premise of the whole term: a wrong answer the assistant cannot
        # see is worse than any failure it can.
        assert config.STRUGGLE_WEIGHTS["silent"] == max(config.STRUGGLE_WEIGHTS.values())

    def test_the_scorer_is_named_apart_from_the_one_it_replaced(self):
        # Two runs scored by different rules must never be compared as if they
        # matched, and the name is what stops that happening silently.
        assert config.CORRECTNESS_IMPL != config.LEGACY_CORRECTNESS_IMPL


class TestAllowanceCurve:
    def test_within_the_allowance_scores_full_marks(self):
        assert score._allowance(3, 3) == 1.0
        assert score._allowance(1, 3) == 1.0

    def test_twice_the_allowance_always_scores_a_half(self):
        # The same shape at every scale — which is the point of a ratio.
        assert score._allowance(6, 3) == pytest.approx(0.5)
        assert score._allowance(60, 30) == pytest.approx(0.5)

    def test_it_decays_instead_of_falling_off_a_cliff(self):
        # Past the allowance every candidate must still be rankable, or GEPA
        # loses the gradient it climbs.
        assert score._allowance(9, 3) > score._allowance(30, 3) > 0


class TestAnalyseCountsStruggle:
    def test_it_counts_the_failures_before_the_first_success(self):
        a = score.analyse(QUESTION, [failing_call(), failing_call(), call()], transcript(), 1)
        assert a.wasted == 2

    def test_a_run_that_never_worked_counts_every_failure_as_wasted(self):
        a = score.analyse(QUESTION, [failing_call(), failing_call()], transcript(), 1)
        assert a.wasted == 2

    def test_failures_after_the_first_success_are_not_counted_as_wasted(self):
        # It had already found its way; what it did afterwards is a different
        # problem from not being able to get started.
        a = score.analyse(QUESTION, [call(), failing_call()], transcript(), 1)
        assert a.wasted == 0

    def test_it_counts_the_commands_that_lied_about_succeeding(self):
        a = score.analyse(QUESTION, [silent_call(), call()], transcript(), 1)
        assert a.silent_failures == 1

    def test_a_corrected_value_is_not_counted_as_a_silent_failure(self):
        a = score.analyse(QUESTION, [hinted_call(), call()], transcript(), 1)
        assert a.silent_failures == 0
        assert a.values_corrected == 1


class TestStruggle:
    def test_a_short_clean_completed_attempt_scores_full_marks(self):
        a = score.analyse(QUESTION, [call()], transcript(turns=1), 1)
        assert score.struggle([a]) == pytest.approx(1.0)

    def test_an_attempt_that_never_answered_scores_nothing(self):
        a = score.analyse(QUESTION, [call()], transcript(answer=""), 1)
        assert score.struggle([a]) == 0.0

    def test_giving_up_immediately_must_not_beat_answering(self):
        # The reason the completion gate exists. Fewer commands and fewer turns
        # both score better, so without the gate the winning strategy would be
        # to run nothing and answer nothing.
        gave_up = score.analyse(QUESTION, [], transcript(answer=""), 1)
        worked_hard = score.analyse(QUESTION, [call()] * 5, transcript(turns=9), 1)
        assert score.struggle([gave_up]) < score.struggle([worked_hard])

    def test_a_silent_wrong_answer_is_punished_harder_than_a_loud_error(self):
        silent = score.analyse(QUESTION, [silent_call(), call()], transcript(), 1)
        loud = score.analyse(QUESTION, [failing_call(), call()], transcript(), 1)
        assert score.struggle([silent]) < score.struggle([loud])

    def test_fewer_wasted_commands_scores_better(self):
        one = score.analyse(QUESTION, [failing_call(), call()], transcript(), 1)
        three = score.analyse(
            QUESTION, [failing_call(), failing_call(), failing_call(), call()], transcript(), 1
        )
        assert score.struggle([one]) > score.struggle([three])

    def test_taking_more_commands_to_get_there_scores_worse(self):
        few = score.analyse(QUESTION, [call()] * 3, transcript(turns=1), 1)
        many = score.analyse(QUESTION, [call()] * 9, transcript(turns=1), 1)
        assert score.struggle([few]) > score.struggle([many])

    def test_taking_more_turns_to_get_there_scores_worse(self):
        brisk = score.analyse(QUESTION, [call()], transcript(turns=2), 1)
        laboured = score.analyse(QUESTION, [call()], transcript(turns=18), 1)
        assert score.struggle([brisk]) > score.struggle([laboured])

    def test_recovering_from_an_error_scores_better_than_staying_stuck(self):
        recovered = score.analyse(QUESTION, [failing_call(), call()], transcript(), 1)
        stuck = score.analyse(QUESTION, [failing_call()], transcript(), 1)
        assert score.struggle([recovered]) > score.struggle([stuck])

    def test_nothing_to_score_is_zero_not_a_crash(self):
        assert score.struggle([]) == 0.0


class TestFeedbackNamesTheStruggle:
    """A number GEPA cannot read an explanation for teaches it nothing."""

    def test_a_silent_wrong_answer_is_called_out_as_the_worst_problem(self):
        a = score.analyse(QUESTION, [silent_call()], transcript(), 1)
        assert "WORST PROBLEM" in score.feedback(QUESTION, [a])

    def test_it_reports_the_effort_even_when_nothing_went_wrong(self):
        # So a change that shortened the path is visible, not just one that
        # fixed an outright failure.
        a = score.analyse(QUESTION, [call()], transcript(turns=4), 1)
        assert "Effort:" in score.feedback(QUESTION, [a])

    def test_a_wasted_command_is_explained_not_just_counted(self):
        a = score.analyse(QUESTION, [failing_call(), call()], transcript(), 1)
        assert "before finding one that" in score.feedback(QUESTION, [a])



class TestRepoContext:
    """GEPA may now SEE more than it may EDIT. Those are different permissions
    and the value of the whole change depends on not confusing them."""

    def _repo(self, tmp_path):
        pkg = tmp_path / "botmap"
        pkg.mkdir()
        (pkg / "cli.py").write_text('"""The commands."""\nCLI_MARKER = 1\n')
        (pkg / "core.py").write_text('"""Data plumbing."""\nCORE_MARKER = 1\n')
        (pkg / "__init__.py").write_text("VERSION = 1\n")
        return tmp_path

    def test_every_file_is_listed_even_when_its_source_is_not_included(self, tmp_path):
        from autoresearch import repo_context
        text = repo_context.build(self._repo(tmp_path), ("botmap/cli.py",))
        for rel in ("botmap/cli.py", "botmap/core.py", "botmap/__init__.py"):
            assert rel in text

    def test_a_file_it_cannot_edit_has_its_source_included(self, tmp_path):
        # The whole point: core.py was reached for 35 times and never seen.
        from autoresearch import repo_context
        text = repo_context.build(self._repo(tmp_path), ("botmap/cli.py",))
        assert "CORE_MARKER" in text

    def test_an_editable_file_is_not_sent_twice(self, tmp_path):
        # GEPA already holds it as the candidate. Sending it again pays for it
        # twice and invites an edit to the stale copy.
        from autoresearch import repo_context
        text = repo_context.build(self._repo(tmp_path), ("botmap/cli.py",))
        assert "CLI_MARKER" not in text

    def test_the_map_says_which_files_are_editable(self, tmp_path):
        from autoresearch import repo_context
        text = repo_context.build(self._repo(tmp_path), ("botmap/cli.py",))
        cli_line = next(l for l in text.splitlines()
                        if "botmap/cli.py" in l and "lines" in l)
        assert "EDITABLE" in cli_line

    def test_dropping_a_file_for_length_is_announced_not_silent(self, tmp_path):
        # A truncated context reads exactly like a complete one. GEPA would
        # draw conclusions from a gap it could not see.
        from autoresearch import repo_context
        text = repo_context.build(self._repo(tmp_path), ("botmap/cli.py",), budget_chars=5)
        assert "omitted for length" in text and "botmap/core.py" in text
        assert "CORE_MARKER" not in text

    def test_it_reports_what_it_actually_sent(self, tmp_path):
        from autoresearch import repo_context
        note = repo_context.describe(self._repo(tmp_path), ("botmap/cli.py",))
        assert note["read_only_sources_included"] == ["botmap/core.py"]
        assert note["chars"] > 0


class TestBaselineSchema:
    """A baseline is measured once and then consumed by other runs, possibly
    ones scored by different rules. What it promises has to stay exact."""

    def _record(self, **top):
        base = {
            "sha": "3009509",
            "correctness_impl": config.LEGACY_CORRECTNESS_IMPL,
            "repeats": 2,
            "skipped": [],
            "questions": {
                "q1": {"tokens": 1000.0, "duration_ms": 2000.0, "correctness": 0.8},
            },
        }
        base.update(top)
        return base

    def _write(self, tmp_path, monkeypatch, record):
        import json
        from autoresearch import baseline
        d = tmp_path / "baselines"
        d.mkdir()
        (d / "3009509.json").write_text(json.dumps(record))
        monkeypatch.setattr(baseline, "path_for", lambda sha: d / f"{sha}.json")
        return baseline

    def test_a_baseline_round_trips(self, tmp_path, monkeypatch):
        baseline = self._write(tmp_path, monkeypatch, self._record())
        assert baseline.load("3009509")["q1"].correctness == 0.8

    def test_an_unknown_top_level_field_is_ignored(self, tmp_path, monkeypatch):
        # The compatibility guarantee that lets one arm consume a baseline
        # measured by another arm's newer code. Whole-measurement metadata --
        # the map-data release, for instance -- belongs at this level, where
        # adding it cannot break an older reader.
        baseline = self._write(tmp_path, monkeypatch,
                               self._record(release="2026-08-19.0"))
        assert baseline.load("3009509")["q1"].tokens == 1000.0

    def test_an_unknown_per_question_field_is_refused_loudly(self, tmp_path, monkeypatch):
        # The other half of the same contract, asserted so nobody adds a field
        # here by accident. `Reading(**v)` has no room for extras, so a
        # per-question addition breaks every reader that has not been updated
        # -- and it would break at load time, an hour into a paid run.
        record = self._record()
        record["questions"]["q1"]["release"] = "2026-08-19.0"
        baseline = self._write(tmp_path, monkeypatch, record)
        with pytest.raises(TypeError, match="release"):
            baseline.load("3009509")

    def test_the_stamp_names_the_measure_that_produced_the_numbers(self):
        # The file records `correctness`, which comes from the frozen
        # proxy-v1 function -- not from whatever scorer this run uses.
        import inspect
        from autoresearch import baseline
        src = inspect.getsource(baseline.measure)
        assert "LEGACY_CORRECTNESS_IMPL" in src


def network_call() -> Call:
    """A command that never reached the data. Arrives as a traceback."""
    return call(
        exit_code=1,
        stderr="Traceback (most recent call last):\n  ...\nOSError: When reading "
               "information for key 'theme=places' in bucket 'overturemaps-us-west-2': "
               "AWS Error NETWORK_CONNECTION during HeadObject operation: "
               "curlCode: 28, Timeout was reached",
    )


class TestNetworkFailuresAreNotToolFailures:
    """A flaky connection must not read as a broken tool.

    botmap does not catch S3 errors, so pyarrow's OSError propagates raw and
    lands in the same bucket as a genuine crash. Left that way, a bad
    afternoon on the network becomes the dominant failure cluster, and the
    proposer spends its budget 'fixing' our connection.
    """

    def test_a_curl_timeout_is_named_as_a_network_failure_not_a_crash(self):
        assert classify(network_call()) == "network_failure"

    def test_a_genuine_crash_is_still_named_a_crash(self):
        # The label must stay specific enough to be worth having.
        assert classify(call(exit_code=1, stderr="Traceback (most recent call last):\n"
                                                 "ValueError: bad category")) == "traceback"

    def test_a_tool_error_merely_mentioning_a_timeout_flag_is_not_network(self):
        # Guards the false positive: mislabelling a real bug as weather would
        # hide exactly what we are looking for.
        assert classify(call(exit_code=2, stderr="Error: no such option: --timeout")) \
            == "bad_option"

    def test_it_is_counted_apart_from_errors_the_tool_caused(self):
        a = score.analyse(QUESTION, [network_call(), call()], transcript(), 1)
        assert a.network_failures == 1
        assert a.errors == []

    def test_it_does_not_count_as_a_wasted_command(self):
        # The assistant did not take a wrong turn; the network ate the call.
        a = score.analyse(QUESTION, [network_call(), call()], transcript(), 1)
        assert a.wasted == 0

    def test_it_does_not_drag_the_struggle_score_down(self):
        clean = score.analyse(QUESTION, [call()], transcript(turns=1), 1)
        flaky = score.analyse(QUESTION, [network_call(), call()], transcript(turns=1), 1)
        assert score.struggle([flaky]) == pytest.approx(score.struggle([clean]))

    def test_an_attempt_that_never_got_through_is_not_scored_at_all(self):
        # Otherwise excluding network failures from the penalties would hand
        # full marks to a run where nothing worked: no errors on the record,
        # nothing wasted, and an answer saying it could not reach the data.
        a = score.analyse(QUESTION, [network_call(), network_call()],
                          transcript(answer="I could not reach the map data"), 1)
        assert a.network_bound

    def test_a_run_that_got_through_once_is_still_scored(self):
        a = score.analyse(QUESTION, [network_call(), call()], transcript(), 1)
        assert not a.network_bound

    def test_the_proposer_is_told_not_to_chase_them(self):
        a = score.analyse(QUESTION, [network_call(), call()], transcript(), 1)
        text = score.feedback(QUESTION, [a])
        assert "Do NOT try to fix these" in text
        assert "network timeouts" in text

    def test_a_run_with_network_trouble_is_not_called_clean(self):
        a = score.analyse(QUESTION, [network_call(), call()], transcript(), 1)
        assert "This one went cleanly." not in score.feedback(QUESTION, [a])


class TestQuotaExhaustion:
    """Running out of subscription quota looks exactly like a candidate that
    broke the tool: no commands, no answer, an errored result. Charging a
    candidate for the account being empty would send the proposer hunting a
    fault that does not exist.

    Shape confirmed against real transcripts from the baseline run that hit it:
    `is_error: true` with `subtype: "success"`, and a fixed message.
    """

    def _transcript(self, text, errored=True):
        import json
        from autoresearch.trace import parse_transcript
        from pathlib import Path
        import tempfile
        d = Path(tempfile.mkdtemp())
        (d / "t.jsonl").write_text(json.dumps({
            "type": "result", "subtype": "success", "result": text,
            "is_error": errored, "duration_ms": 900, "num_turns": 1,
            "usage": {"input_tokens": 10},
        }))
        return parse_transcript(d / "t.jsonl")

    def test_the_real_message_is_recognised(self):
        t = self._transcript("You've hit your session limit · resets 10:50pm (Asia/Calcutta)")
        assert t.quota_exhausted

    def test_the_status_alone_does_not_give_it_away(self):
        # subtype is "success" even here, so anything keying off status would
        # miss it. This is the reason the check reads the message.
        t = self._transcript("You've hit your session limit · resets 10:50pm")
        assert t.status == "error" and not t.completed

    def test_an_ordinary_failure_is_not_mistaken_for_quota(self):
        assert not self._transcript("The command failed with an error").quota_exhausted

    def test_a_successful_answer_is_never_quota(self):
        # Guards the false positive: a question *about* rate limits must not
        # abort the run.
        t = self._transcript("The rate limit for that API is 10/sec", errored=False)
        assert not t.quota_exhausted

    def test_the_proposer_is_told_this_is_not_its_fault(self):
        a = score.analyse(QUESTION, [], self._transcript("You've hit your session limit"), 1)
        text = score.feedback(QUESTION, [a])
        assert "MEASUREMENT ABANDONED" in text
        assert "Do NOT" in text

    def test_it_is_not_reported_as_the_tool_crashing(self):
        # The pre-existing wording would have blamed the run itself.
        a = score.analyse(QUESTION, [], self._transcript("You've hit your session limit"), 1)
        assert "crashed or timed out" not in score.feedback(QUESTION, [a])

    @pytest.mark.filterwarnings("ignore::UserWarning")
    def test_the_evaluator_stops_the_run_rather_than_scoring_zero(self, monkeypatch):
        # Scoring zero is the whole problem: it reads as "this candidate broke
        # the tool" and burns the rest of the budget on an empty account.
        from autoresearch import runner as runner_mod
        from autoresearch.evaluator import Evaluator, QuotaExhausted
        from autoresearch.score import Attempt

        starved = Attempt(QUESTION.id, 1, [],
                          self._transcript("You've hit your session limit"))
        monkeypatch.setattr(runner_mod, "ask_repeatedly",
                            lambda *a, **k: [starved, starved])
        monkeypatch.setattr(Evaluator, "_broken", lambda self, tree: None)

        pool = TestCandidateIsolation.FakePool()
        ev = Evaluator("tool", pool, reference={})
        with pytest.raises(QuotaExhausted, match="quota"):
            ev({"botmap/cli.py": "x"}, QUESTION)

    @pytest.mark.filterwarnings("ignore::UserWarning")
    def test_a_normal_failure_still_scores_rather_than_stopping_everything(self,
                                                                          monkeypatch):
        # The abort must be reserved for quota. A candidate that genuinely
        # breaks the tool has to keep scoring zero, or GEPA stops learning.
        from autoresearch import runner as runner_mod
        from autoresearch.evaluator import Evaluator

        broken = Attempt(QUESTION.id, 1, [], self._transcript("it crashed"))
        monkeypatch.setattr(runner_mod, "ask_repeatedly",
                            lambda *a, **k: [broken, broken])
        monkeypatch.setattr(Evaluator, "_broken", lambda self, tree: None)

        pool = TestCandidateIsolation.FakePool()
        ev = Evaluator("tool", pool, reference={})
        total, report = ev({"botmap/cli.py": "x"}, QUESTION)
        assert total == 0.0 and "Unmeasurable" in report


class TestDiagnosticsAreNeverPunished:
    """The gradient must never point at deleting the tool's own diagnostics.

    Found by arm A: its candidate C1 adds a near-match hint where the tool
    previously returned an unexplained zero. Under the original rules that
    turned a `clean` call into a scored error, so C1 looked worse precisely
    because it made the tool better. Any optimiser reading that learns to
    remove diagnostics -- driving the tool toward the silent failures this
    scorer exists to punish.

    These are the cases that inversion would break. They are worth more than
    their line count: the defect was invisible in every unit test that existed,
    and only showed up when the three variants were scored side by side.
    """

    def _objective(self, first):
        a = score.analyse(QUESTION, [first, call()], transcript(turns=2), 1)
        return score.objective(score.correctness([a]), score.struggle([a]), 0.5, 0.5)

    def test_adding_a_suggestion_scores_better_than_staying_unhelpful(self):
        # The C1 case, stated as a number. This is the assertion that would
        # have caught the original defect.
        assert self._objective(hinted_call()) > self._objective(silent_call())

    def test_removing_a_suggestion_never_pays(self):
        # The same claim from the optimiser's side: going from helpful to
        # unhelpful must never be an improvement.
        assert self._objective(silent_call()) <= self._objective(hinted_call())

    def test_a_helpful_tool_is_not_scored_below_one_that_says_nothing(self):
        # The subtler half. A tool that says nothing at all is invisible to
        # us -- it looks like a legitimate empty result -- so the best we can
        # do is make sure being helpful is not actively worse than being mute.
        says_nothing = call()
        assert self._objective(hinted_call()) >= self._objective(says_nothing)

    def test_the_suggestion_does_not_count_as_a_wasted_command(self):
        # It cost a turn, and `path` already charges for that. Charging it
        # again here would rebuild the same disincentive at lower magnitude.
        a = score.analyse(QUESTION, [hinted_call(), call()], transcript(), 1)
        assert a.wasted == 0

    def test_the_proposer_is_told_the_suggestion_is_wanted(self):
        a = score.analyse(QUESTION, [hinted_call(), call()], transcript(), 1)
        text = score.feedback(QUESTION, [a])
        assert "GOOD:" in text and "Do not remove it" in text

    def test_spraying_suggestions_at_genuine_empty_results_does_not_pay(self):
        # Guards the reward hack the fix could have opened: if a suggestion
        # were rewarded rather than merely not punished, a candidate could add
        # one to every empty result, including the honest ones.
        honest_zero = self._objective(call())
        sprayed = self._objective(hinted_call())
        assert sprayed <= honest_zero
