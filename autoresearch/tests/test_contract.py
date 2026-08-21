from autoresearch.agenteval.contract import (
    SCHEMA,
    AttemptVerdict,
    Probe,
    Record2,
    derive_class,
    load,
    validate,
    write,
)


def test_derive_class_covers_failure_table_and_clean():
    assert derive_class("ok", "tool", "n/a") is None
    assert derive_class("error", "tool", "unguided") == "A"
    assert derive_class("error", "tool", "guided") == "B"
    assert derive_class("empty", "tool", "unguided") == "C"
    assert derive_class("degenerate", "tool", "n/a") == "D"
    assert derive_class("error", "environment", "unguided") == "E"
    assert derive_class("empty", "agent", "guided") == "F"


def test_round_trips_record_v2_with_clean_class_null(tmp_path):
    path = tmp_path / "record-v2.json"
    record = Record2(
        schema=SCHEMA,
        question_id="bus-stops-cambridge",
        repeat=1,
        calls=(
            {
                "argv": ["count", "-t", "place"],
                "exit_code": 0,
                "stdout_head": "12",
                "stderr_head": "",
                "duration_s": 1.2,
                "outcome": "ok",
                "blame": "tool",
                "recovery": "n/a",
                "cls": None,
                "subtype": None,
                "evidence": "answered directly",
                "probes": (Probe("none", "", "", False),),
            },
        ),
        agent_side=(),
        tools_used={"Bash": 1},
        botmap_calls=1,
        answer={"text": "12", "verified": None},
    )

    write(path, record)

    raw_text = path.read_text()
    assert '"class": null' in raw_text
    loaded = load(path)
    assert loaded.question_id == record.question_id
    assert loaded.calls[0]["class"] is None
    assert validate(__import__("json").loads(raw_text)) == []


def test_validate_rejects_class_that_disagrees_with_axes():
    raw = minimal_record()
    raw["calls"][0].update(outcome="empty", blame="tool", recovery="unguided", **{"class": None})

    problems = validate(raw)

    assert any("calls[0].class must be 'C'" in problem for problem in problems)


def test_validate_accepts_attempt_level_environment_verdict_without_calls():
    raw = minimal_record()
    raw["calls"] = []
    raw["botmap_calls"] = 0
    raw["attempt"] = {
        "outcome": "error",
        "blame": "environment",
        "recovery": "unguided",
        "class": "E",
        "subtype": None,
        "evidence": "Claude session limit before any botmap command",
    }

    assert validate(raw) == []


def test_validate_reports_invalid_axes_and_probe_shape():
    raw = minimal_record()
    raw["calls"][0]["outcome"] = "zero-ish"
    raw["calls"][0]["probes"] = [{"kind": "vocabulary", "ran": 3, "result": "absent"}]

    problems = validate(raw)

    assert "calls[0].outcome invalid: 'zero-ish'" in problems
    assert "calls[0].probes[0].ran must be a string" in problems
    assert "calls[0].probes[0].conclusive must be a boolean" in problems


def minimal_record():
    return {
        "schema": SCHEMA,
        "question_id": "q1",
        "repeat": 1,
        "calls": [
            {
                "argv": ["count"],
                "exit_code": 0,
                "outcome": "ok",
                "blame": "tool",
                "recovery": "n/a",
                "class": None,
                "subtype": None,
                "evidence": "clean",
                "probes": [],
            }
        ],
        "agent_side": [],
        "tools_used": {},
        "botmap_calls": 1,
        "answer": {"text": "ok", "verified": None},
    }
