import json

from autoresearch.agenteval.repair import repair_us_state_entity_false_positives


def test_repairs_us_state_entity_probe_false_positive(tmp_path):
    attempt = tmp_path / "attempts" / "q__r1"
    attempt.mkdir(parents=True)
    record = {
        "schema": "agenteval/2",
        "question_id": "q",
        "repeat": 1,
        "calls": [
            {
                "argv": ["--json", "count", "-t", "place", "--in", "Cambridge, MA", "--where", "categories.primary=foo"],
                "exit_code": 0,
                "stdout_head": '{"count": 0}',
                "stderr_head": "",
                "duration_s": 1.0,
                "outcome": "empty",
                "blame": "tool",
                "recovery": "unguided",
                "class": "C",
                "subtype": "c-wrong-entity",
                "evidence": "c-wrong-entity: qualifier MA implies country MA, but resolved Cambridge with country US / region US-MA",
                "probes": [
                    {
                        "kind": "entity_check",
                        "ran": "botmap --json where 'Cambridge, MA'",
                        "result": "qualifier MA implies country MA, but resolved Cambridge with country US / region US-MA",
                        "conclusive": True,
                    }
                ],
            }
        ],
        "agent_side": [],
        "tools_used": {},
        "botmap_calls": 1,
        "answer": {"text": "", "verified": None},
    }
    (attempt / "record-v2.json").write_text(json.dumps(record), encoding="utf-8")

    stats = repair_us_state_entity_false_positives(tmp_path)

    repaired = json.loads((attempt / "record-v2.json").read_text())
    call = repaired["calls"][0]
    assert stats == {"records_seen": 1, "calls_repaired": 1, "probes_removed": 1}
    assert call["class"] == "C"
    assert call["subtype"] == "c-unknown"
    assert call["probes"] == []
