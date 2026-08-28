from pathlib import Path

import gepa.optimize_anything as oa

from autoresearch.baseline import Reading, _summarise
from autoresearch.evaluator import Evaluator
from autoresearch.questions import Question
from autoresearch.score import Attempt
from autoresearch.trace import Call, Transcript, Usage


class FakePool:
    files = None

    def __init__(self):
        self.log = []

    def acquire(self):
        self.log.append("acquire")
        return Path("/tmp/fake-tree")

    def reset(self, tree):
        self.log.append("reset")

    def write_candidate(self, tree, lever, files):
        self.log.append(f"write:{sorted(files)}")


def transcript(answer="done", *, status="ok", tokens=1000, ms=1000):
    return Transcript(
        final_answer=answer,
        completed=status == "ok" and bool(answer),
        status=status,
        usage=Usage(input_tokens=tokens, duration_ms=ms),
    )


def attempt(calls, transcript_=None):
    return Attempt(
        question_id="q1",
        repeat=1,
        calls=calls,
        transcript=transcript_ or transcript(),
    )


def test_evaluator_scores_and_logs_record_v2_explanations(monkeypatch):
    logs = []
    monkeypatch.setattr(oa, "log", logs.append)
    monkeypatch.setattr(Evaluator, "_broken", lambda self, tree: None)
    monkeypatch.setattr(
        "autoresearch.runner.ask_repeatedly",
        lambda *args, **kwargs: [attempt([
            Call(
                ["count", "-t", "place", "--where", "categories.primary=bus_stop"],
                exit_code=0,
                stdout="",
                stderr="0 rows. Did you mean: bus_station?",
            )
        ])],
    )
    ev = Evaluator("tool", FakePool(), {"q1": Reading(tokens=1000, duration_ms=1000, correctness=1.0)})

    total, report = ev({"botmap/cli.py": "x"}, Question(id="q1", tier=1, question="how many?"))

    assert total > 0
    assert "agenteval" in report["Score"]
    assert report["ClassifiedFailures"] == 1
    assert any("CLASS B" in line for line in logs)
    assert any('Question: "how many?"' in line for line in logs)


def test_evaluator_excludes_attempt_level_quota_instead_of_scoring_candidate(monkeypatch):
    logs = []
    monkeypatch.setattr(oa, "log", logs.append)
    monkeypatch.setattr(Evaluator, "_broken", lambda self, tree: None)
    starved = attempt([], transcript("You've hit your session limit", status="error"))
    monkeypatch.setattr("autoresearch.runner.ask_repeatedly", lambda *args, **kwargs: [starved])
    ev = Evaluator("tool", FakePool(), {})

    total, report = ev({"botmap/cli.py": "x"}, Question(id="q1", tier=1, question="how many?"))

    assert total == 0.0
    assert report == {"Unmeasurable": "all attempts excluded by agenteval"}
    assert any("CLASS E" in line for line in logs)


def test_baseline_summary_uses_agenteval_and_drops_environment_attempts():
    starved = attempt([], transcript("You've hit your session limit", status="error", tokens=9999, ms=9999))
    clean = attempt([Call(["count"], exit_code=0, stdout="12", stderr="")], transcript(tokens=100, ms=200))

    reading = _summarise([starved, clean])

    assert reading == Reading(tokens=100, duration_ms=200, correctness=1.0)
