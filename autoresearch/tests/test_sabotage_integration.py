from autoresearch.agenteval.sabotage import FIXTURES, run_sabotage
from autoresearch.agenteval.taxonomy import classify, classify_attempt, TranscriptLike


def test_call_level_sabotage_fixtures_fire_with_taxonomy_classifier():
    call_level = [fixture for fixture in FIXTURES if fixture.expected_class not in {"E", "F"}]

    results = run_sabotage(lambda call: classify(call, call.get("probes", [])), call_level)

    assert all(result.passed for result in results), [result for result in results if not result.passed]


def test_attempt_level_quota_fixture_fires_with_taxonomy_classifier():
    quota = next(fixture for fixture in FIXTURES if fixture.id == "e-quota-attempt-level")

    verdict = classify_attempt(TranscriptLike(final_answer=quota.call["stderr_head"]))

    assert verdict is not None
    assert verdict.cls == "E"
    assert verdict.blame == "environment"
