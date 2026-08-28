from autoresearch.agenteval.contract import C_SUBTYPES, validate
from autoresearch.agenteval.sabotage import FIXTURES, assert_sabotage_passes, expected_verdict, run_sabotage


def test_sabotage_has_every_class_and_class_c_subtype():
    classes = {fixture.expected_class for fixture in FIXTURES}
    subtypes = {fixture.expected_subtype for fixture in FIXTURES if fixture.expected_subtype}

    assert {"A", "B", "C", "D", "E", "F"}.issubset(classes)
    assert C_SUBTYPES == subtypes


def test_reference_fixture_verdicts_pass_contract_validation():
    for fixture in FIXTURES:
        raw = {
            "schema": "agenteval/2",
            "question_id": fixture.id,
            "repeat": 1,
            "calls": [fixture.call],
            "agent_side": [],
            "tools_used": {},
            "botmap_calls": 1 if fixture.call["argv"] else 0,
            "answer": {"text": "fixture", "verified": None},
        }
        assert validate(raw) == []


def test_sabotage_passes_with_reference_classifier():
    assert_sabotage_passes(expected_verdict)
    assert all(result.passed for result in run_sabotage(expected_verdict))


def test_sabotage_fails_if_silent_wrong_classifies_clean():
    def broken_classifier(call):
        verdict = expected_verdict(call)
        if call.get("subtype") == "c-vocabulary":
            return {"class": None, "subtype": None}
        return verdict

    results = run_sabotage(broken_classifier)

    failed = [result for result in results if result.fixture_id == "c-vocabulary-bus-stop"]
    assert len(failed) == 1
    assert failed[0].passed is False
    assert failed[0].expected_class == "C"
    assert failed[0].actual_class is None
