"""Tests for the parts where a silent mistake would be expensive."""

from __future__ import annotations

import json
import os

import pytest

from pathlib import Path

from autoresearch import baseline, config, credits, score
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
        assert "could not check" in config.preflight(check_network=False, check_quota=False)["balance"]

    def test_revoked_key_stops_the_run(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        monkeypatch.setenv(config.REFLECTION_KEY_VAR, "sk-or-v1-revoked")
        monkeypatch.setattr(credits, "fetch",
                            lambda key, **kw: (_ for _ in ()).throw(credits.Unauthorized("no")))
        with pytest.raises(credits.Unauthorized):
            config.preflight()


class TestBaselineSnapshotGuard:
    """A yardstick is only a yardstick if it was measured on the same data.

    `botmap` is unpinned — it always uses the newest map-data release. So a
    baseline measured last week and a candidate measured today can sit on
    different snapshots with nothing looking wrong, and every comparison
    afterwards is meaningless. This happened for real on 2026-08-20: the
    release rolled from 2026-07-22.0 to 2026-08-19.0 overnight, the cached
    divisions index went stale, every place lookup raised, and correctness
    collapsed from 0.76 to 0.19 — which reads exactly like a terrible
    candidate rather than a broken measurement.
    """

    def write_baseline(self, tmp_path, monkeypatch, **extra):
        monkeypatch.setattr(config, "ROOT", tmp_path)
        path = baseline.path_for("abc1234")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"sha": "abc1234", "questions": {}, **extra}))
        return path

    def test_the_same_release_is_no_complaint(self):
        assert config.release_mismatch("2026-07-22.0", "2026-07-22.0") is None

    def test_a_moved_release_names_both_sides(self):
        problem = config.release_mismatch("2026-07-22.0", "2026-08-19.0")
        # Naming both is the whole point: "stale baseline" alone doesn't tell
        # you which snapshot to go and re-measure against.
        assert "2026-07-22.0" in problem and "2026-08-19.0" in problem

    def test_an_unknown_release_is_not_a_match(self):
        # Not knowing is different from agreeing. Neither direction may pass
        # silently, or the guard would approve exactly what it exists to catch.
        assert config.release_mismatch(None, "2026-08-19.0") is None
        assert config.release_mismatch("2026-07-22.0", None) is None

    def test_a_measured_baseline_carries_its_release(self, tmp_path, monkeypatch):
        self.write_baseline(tmp_path, monkeypatch, release="2026-07-22.0")
        assert baseline.saved_release("abc1234") == "2026-07-22.0"

    def test_a_baseline_written_before_we_recorded_it_reads_as_unknown(
            self, tmp_path, monkeypatch):
        self.write_baseline(tmp_path, monkeypatch)  # no release key
        assert baseline.saved_release("abc1234") is None

    def test_no_baseline_at_all_reads_as_unknown(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, "ROOT", tmp_path)
        assert baseline.saved_release("nosuch") is None

    def test_a_stale_baseline_stops_the_run(self, tmp_path, monkeypatch):
        self.write_baseline(tmp_path, monkeypatch, release="2026-07-22.0")
        monkeypatch.setattr(config, "detected_release", lambda repo=None: "2026-08-19.0")
        monkeypatch.setenv(config.REFLECTION_KEY_VAR, "sk-or-v1-fine")
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        monkeypatch.setattr(credits, "fetch",
                            lambda key, **kw: credits.Balance(granted=100.0, used=0.0))
        with pytest.raises(ValueError, match="2026-08-19.0"):
            config.preflight(sha="abc1234")

    def test_a_matching_baseline_is_waved_through(self, tmp_path, monkeypatch):
        self.write_baseline(tmp_path, monkeypatch, release="2026-08-19.0")
        monkeypatch.setattr(config, "detected_release", lambda repo=None: "2026-08-19.0")
        assert "matching" in config._check_baseline_release("abc1234")

    def test_being_unable_to_ask_does_not_block_the_run(self, tmp_path, monkeypatch):
        # Same reasoning as the credit check: a slow S3 is not evidence that
        # anything is wrong, and refusing to start over it would be worse.
        self.write_baseline(tmp_path, monkeypatch, release="2026-07-22.0")
        monkeypatch.setattr(config, "detected_release", lambda repo=None: None)
        assert "unchecked" in config._check_baseline_release("abc1234")

    def test_an_unrecorded_release_warns_rather_than_passing_quietly(
            self, tmp_path, monkeypatch):
        # The pre-existing baselines are all this shape. Saying nothing would
        # let the exact failure we are guarding against slip through.
        self.write_baseline(tmp_path, monkeypatch)
        monkeypatch.setattr(config, "detected_release", lambda repo=None: "2026-08-19.0")
        assert "predates" in config._check_baseline_release("abc1234")

    def test_no_sha_means_the_check_is_skipped_not_passed(self, tmp_path, monkeypatch):
        # smoke.py preflights without a sha; it must not claim a clean bill.
        monkeypatch.setattr(config, "ENV_FILE", tmp_path / "absent")
        monkeypatch.setenv(config.REFLECTION_KEY_VAR, "sk-or-v1-fine")
        monkeypatch.setattr(credits, "fetch",
                            lambda key, **kw: credits.Balance(granted=100.0, used=0.0))
        assert config.preflight(check_network=False, check_quota=False)["release"] == "not checked"


class TestNetworkGuard:
    """A flaky link does not add noise — it invents failures that aren't there.

    When an S3 read drops, `botmap` raises, and taxonomy.classify records
    `traceback` — the same label a genuine bug gets. So the network becomes the
    tool's biggest apparent failure cluster and GEPA tries to fix it.

    A partial outage is the dangerous one. A total outage floors every score
    and is obvious; at 50% every candidate still produces a plausible number
    and they get ranked by which minute they happened to run in. Observed for
    real on 2026-08-20: ~50% failures, identical `count` calls returning in
    anywhere from 17s to 259s.
    """

    def test_a_sound_link_has_no_complaint(self):
        assert config.network_problem([7.0, 8.0, 9.0, 7.5, 8.5, 8.0], failures=0) is None

    def test_the_observed_half_failure_rate_stops_the_run(self):
        assert config.network_problem([17.0, 40.0, 259.0], failures=3) is not None

    def test_one_blip_in_six_is_tolerated(self):
        # Below MAX_FAILURE_RATE. A single transient drop is not a reason to
        # refuse an hour of work — REPEATS exists precisely to absorb it.
        assert config.network_problem([8.0] * 5, failures=1) is None

    def test_everything_failing_is_caught_by_the_rate_check(self):
        # No successes means a 100% failure rate, so the rate check answers
        # this before any latency maths is attempted. There is deliberately no
        # separate "everything failed" branch — it would be unreachable.
        problem = config.network_problem([], failures=4)
        assert "4 of 4" in problem and "100%" in problem

    def test_nothing_attempted_cannot_be_judged(self):
        # Not the same as healthy. The caller reports this as unchecked rather
        # than as a pass, so an unrunnable probe never looks like a green light.
        assert config.network_problem([], failures=0) is None

    def test_a_slow_but_reliable_link_still_stops_the_run(self):
        # Every call succeeds, so the failure rate is clean — but an agent
        # chains several calls per question against RUN_TIMEOUT_S, so these
        # questions would time out for reasons unrelated to the candidate.
        problem = config.network_problem([200.0] * 6, failures=0)
        assert problem is not None and "time out" in problem

    def test_the_slowness_threshold_is_justified_by_the_question_timeout(self):
        # Not a magic number: a question dies at RUN_TIMEOUT_S, and an agent
        # makes several calls inside one, so the median must leave room for
        # roughly eight of them.
        assert config.MAX_MEDIAN_LATENCY_S * 8 >= config.RUN_TIMEOUT_S

    def test_a_timeout_counts_against_the_link(self, monkeypatch, tmp_path):
        # Waiting out a call that slow buys nothing, and it is what stops the
        # probe itself taking minutes.
        import subprocess as sp
        (tmp_path / ".venv" / "bin").mkdir(parents=True)
        (tmp_path / ".venv" / "bin" / "python").touch()

        def always_times_out(*a, **kw):
            raise sp.TimeoutExpired(cmd="botmap", timeout=kw.get("timeout", 45))

        monkeypatch.setattr(sp, "run", always_times_out)
        latencies, failures = config.probe_network(repo=tmp_path, calls=3, timeout=1)
        assert (latencies, failures) == ([], 3)

    def test_no_interpreter_means_nothing_attempted(self, tmp_path):
        # A checkout with no venv cannot be probed. That must read as unknown,
        # never as healthy.
        assert config.probe_network(repo=tmp_path, calls=3) == ([], 0)


class TestQuotaGuard:
    """Running out of subscription quota is the failure that reads least like one.

    The agent returns `is_error: true` with subtype "success" and the text
    "You've hit your session limit". The harness turns that into an attempt
    that did not complete. At baseline that is a skipped question — annoying.
    Inside a GEPA run there is no skip: it scores as correctness 0, which means
    "this candidate broke the tool", and budget goes on fixing something that
    was never broken.

    Observed for real on 2026-08-20: 50 of 60 baseline attempts returned that
    exact message, and the baseline finished with 5 of 30 questions measured.
    """

    def test_a_working_agent_is_no_complaint(self):
        assert config.quota_problem("ok", is_error=False) is None

    def test_the_observed_session_limit_message_stops_the_run(self):
        seen = "You've hit your session limit · resets 10:50pm (Asia/Calcutta)"
        assert config.quota_problem(seen, is_error=True) is not None

    def test_a_usage_limit_also_counts(self):
        assert config.quota_problem("Your usage limit has been reached", is_error=True)

    def test_an_answer_merely_discussing_limits_is_not_exhaustion(self):
        # An agent that answers a question by talking about rate limits has
        # told us nothing about our own quota. Blocking on that would refuse
        # runs at random, which is worse than the thing we are guarding.
        assert config.quota_problem("Rate limits apply to the S3 API", is_error=False) is None

    def test_an_unrelated_error_is_not_reported_as_exhaustion(self):
        # Still an error, but naming it wrongly would send someone off waiting
        # for a quota reset that was never the problem.
        assert config.quota_problem("model not found", is_error=True) is None

    def test_the_reset_time_is_kept_because_it_tells_you_when_to_retry(self):
        seen = "You've hit your session limit · resets 10:50pm (Asia/Calcutta)"
        assert "10:50pm" in config.quota_problem(seen, is_error=True)

    def test_no_answer_at_all_reads_as_unknown(self):
        # probe_quota returns ("", False) when it could not ask. That must not
        # look like healthy quota.
        assert config.quota_problem("", is_error=False) is None


class TestBillingPathIsRecorded:
    """Same model, different till — but only if something writes down which.

    OpenRouter is the fallback when subscription quota runs out. It serves the
    same Sonnet, so the numbers *should* be comparable. The danger is that
    "should" is untested: a baseline measured on one path and candidates on
    another is the same defect as measuring across two map-data releases, and
    nothing about the scores would reveal it.
    """

    def test_the_default_path_is_the_subscription(self, monkeypatch):
        monkeypatch.delenv("AUTORESEARCH_AGENT_PATH", raising=False)
        assert config.agent_path() == "subscription"

    def test_the_fallback_path_is_recorded_when_selected(self, monkeypatch):
        monkeypatch.setenv("AUTORESEARCH_AGENT_PATH", "openrouter")
        assert config.agent_path() == "openrouter"

    def test_the_serving_host_is_recorded_separately_from_the_path(self, monkeypatch):
        # Separate because OpenRouter is a pool, not a host: unpinned it
        # returned Anthropic, Amazon Bedrock, Claude Platform on AWS and Azure
        # across four consecutive calls. "openrouter" alone does not identify
        # what actually answered.
        monkeypatch.setenv("AUTORESEARCH_AGENT_PROVIDER", "anthropic")
        assert config.agent_provider() == "anthropic"

    def test_the_fallback_names_a_specific_sonnet_not_an_alias(self):
        # `sonnet` is the subscription's alias and resolves to claude-sonnet-5.
        # OpenRouter offers sonnet-4, 4.5, 4.6 and 5, so an alias there would
        # silently pick a different model and we would report the resulting
        # difference as a property of the billing path.
        assert config.OPENROUTER_MODEL == "anthropic/claude-sonnet-5"
        assert config.AGENT_MODEL == "sonnet"

    def test_the_base_url_stops_at_api_because_claude_appends_v1_messages(self):
        # Observed: a base ending in /api/v1 produces /api/v1/v1/messages -> 404.
        assert config.OPENROUTER_BASE.endswith("/api")


class TestBaselineRetentionIsScoped:
    """Baselines keep their attempts. Candidate runs do not.

    A baseline is 60 attempts and is read by everything downstream; a GEPA run
    is hundreds and would quietly fill the disk. Retention has already paid for
    itself twice on evidence kept for an unrelated reason — verifying a second
    scorer could share the baseline, and deriving a noise floor from the
    repeat-pairs, which replaced a whole second measurement.
    """

    def test_a_baseline_keeps_its_attempts_without_being_asked(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, "ROOT", tmp_path)
        seen = {}

        def fake_ask(question, tree, keep_dir=None):
            seen["keep_dir"] = keep_dir
            return []

        monkeypatch.setattr("autoresearch.runner.ask_repeatedly", fake_ask)
        baseline.measure([QUESTION], tmp_path, "abc1234")
        assert seen["keep_dir"] == baseline.attempts_dir("abc1234")

    def test_attempts_live_beside_the_numbers_they_produced(self, tmp_path, monkeypatch):
        # Keyed by commit, not by run: a baseline belongs to a sha and is
        # reused by every run at that sha.
        monkeypatch.setattr(config, "ROOT", tmp_path)
        assert baseline.attempts_dir("abc1234").parent == baseline.path_for("abc1234").parent

    def test_an_explicit_directory_still_wins(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, "ROOT", tmp_path)
        seen = {}

        def fake_ask(question, tree, keep_dir=None):
            seen["keep_dir"] = keep_dir
            return []

        monkeypatch.setattr("autoresearch.runner.ask_repeatedly", fake_ask)
        chosen = tmp_path / "somewhere-else"
        baseline.measure([QUESTION], tmp_path, "abc1234", keep_dir=chosen)
        assert seen["keep_dir"] == chosen

    def test_candidate_runs_do_not_inherit_baseline_retention(self):
        # The guard that matters. `optimize.run` must not hand the baseline's
        # default to the Evaluator: that would retain hundreds of attempt
        # directories and fill the disk silently, which is exactly the class of
        # quiet failure this project keeps turning up.
        import inspect

        from autoresearch import optimize

        src = inspect.getsource(optimize.run)
        assert "Evaluator(lever, pool, reference, keep_dir=candidate_attempts)" in src
        # measure() must be called WITHOUT a keep_dir, so the two cannot share one.
        assert "baseline.measure(bank, tree, sha)" in src
