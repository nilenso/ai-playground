from autoresearch.agenteval.contract import Probe, Record2, SCHEMA
from autoresearch.agenteval.explain import explain


def test_explain_turns_class_c_probe_into_fix_instruction():
    record = Record2(
        schema=SCHEMA,
        question_id="bus-stops-with-coffee",
        repeat=2,
        calls=(
            {
                "argv": ["count", "-t", "place", "--where", "categories.primary=bus_stop"],
                "exit_code": 0,
                "stdout_head": '{"count": 0}',
                "stderr_head": "",
                "duration_s": 9.6,
                "outcome": "empty",
                "blame": "tool",
                "recovery": "unguided",
                "cls": "C",
                "subtype": "c-vocabulary",
                "evidence": "bus_stop absent; bus_station exists",
                "probes": (Probe("vocabulary", "categories -t place --top 5000 | grep bus_stop", "absent", True),),
            },
        ),
        agent_side=(),
        tools_used={"Bash": 1},
        botmap_calls=1,
        answer={"text": "no bus stops", "verified": None},
    )

    text = explain(record)

    assert "CLASS C (silent wrong) - c-vocabulary" in text
    assert "The agent ran: count -t place --where categories.primary=bus_stop" in text
    assert "Probe (vocabulary, conclusive)" in text
    assert "never return empty" in text
    assert "nearest real values" in text


def test_explain_preserves_guided_recovery_and_agent_side_non_use():
    record = {
        "question_id": "bus-stops-with-coffee",
        "repeat": 1,
        "calls": [
            {
                "argv": ["count", "--where", "categories.primary=bus_stop"],
                "exit_code": 2,
                "outcome": "error",
                "blame": "tool",
                "recovery": "guided",
                "class": "B",
                "subtype": None,
                "evidence": "Did you mean: bus_station",
                "probes": [],
            }
        ],
        "agent_side": [
            {
                "kind": "ignored_hint",
                "at_call": 0,
                "ignored_by_next": True,
                "suggestions": ["bus_station"],
                "eventually_used": False,
                "used_at_call": None,
                "detail": "hint suggested bus_station; next command did not use it",
            }
        ],
    }

    text = explain(record)

    assert "CLASS B (soft failure)" in text
    assert "guided recovery was present" in text
    assert "AGENT-SIDE: ignored_hint" in text
    assert "Strict ignored-by-next: True" in text
