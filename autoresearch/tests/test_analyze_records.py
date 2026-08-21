import json

from autoresearch.agenteval.analyze import summarize_run, write_summary


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
