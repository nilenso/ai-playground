import json

from autoresearch.agenteval.analyze import summarize_run, summarize_with_completed_retries, write_combined_summary, write_summary


def test_summarize_run_counts_classes_subtypes_and_agent_side(tmp_path):
    attempt = tmp_path / "attempts" / "q__r1"
    attempt.mkdir(parents=True)
    (attempt / "record-v2.json").write_text(
        json.dumps(
            {
                "schema": "agenteval/2",
                "question_id": "q",
                "repeat": 1,
                "calls": [
                    {"class": None, "argv": ["count"]},
                    {"class": "C", "subtype": "c-vocabulary", "argv": ["count"], "evidence": "absent"},
                ],
                "agent_side": [{"kind": "ignored_hint", "detail": "ignored"}],
                "tools_used": {},
                "botmap_calls": 2,
                "answer": {"text": "", "verified": None},
            }
        ),
        encoding="utf-8",
    )

    summary = summarize_run(tmp_path)

    assert summary["records"] == 1
    assert summary["class_counts"] == {"clean": 1, "C": 1}
    assert summary["subtype_counts"] == {"c-vocabulary": 1}
    assert summary["agent_side_counts"] == {"ignored_hint": 1}
    assert summary["attempts_with_failures"] == 1


def test_write_summary_defaults_to_run_directory(tmp_path):
    out = write_summary(tmp_path)

    assert out == tmp_path / "agenteval-summary.json"
    assert json.loads(out.read_text())["records"] == 0


def test_summarize_with_completed_retries_replaces_only_completed_attempts(tmp_path):
    base = tmp_path / "base"
    retry = tmp_path / "retry"
    write_record(base, "q__r1", "q", "A", None)
    write_record(base, "q__r2", "q", "C", "c-unknown")
    write_record(retry, "q__r1", "q", "B", None)
    write_record(retry, "q__r2", "q", None, None)
    (retry / "progress.jsonl").write_text(
        json.dumps({"attempt": "q__r1", "completed": True}) + "\n" +
        json.dumps({"attempt": "q__r2", "completed": False}) + "\n",
        encoding="utf-8",
    )

    summary = summarize_with_completed_retries(base, retry)

    assert summary["retry_replacements"] == ["q__r1"]
    assert summary["class_counts"] == {"B": 1, "C": 1}
    assert summary["subtype_counts"] == {"c-unknown": 1}

    out = write_combined_summary(base, retry)
    assert out == base / "agenteval-summary-with-retries.json"


def write_record(root, name, question_id, cls, subtype):
    attempt = root / "attempts" / name
    attempt.mkdir(parents=True, exist_ok=True)
    attempt.joinpath("record-v2.json").write_text(
        json.dumps(
            {
                "schema": "agenteval/2",
                "question_id": question_id,
                "repeat": 1,
                "calls": [{"class": cls, "subtype": subtype, "argv": ["count"]}],
                "agent_side": [],
                "tools_used": {},
                "botmap_calls": 1,
                "answer": {"text": "", "verified": None},
            }
        ),
        encoding="utf-8",
    )
