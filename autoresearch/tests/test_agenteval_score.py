from autoresearch.agenteval.contract import AttemptVerdict, CallVerdict, derive_class
from autoresearch.agenteval.score import score_attempt


def verdict(outcome, blame="tool", recovery="unguided", subtype=None):
    return CallVerdict(
        outcome=outcome,
        blame=blame,
        recovery=recovery,
        cls=derive_class(outcome, blame, recovery),
        subtype=subtype,
        evidence="fixture",
        probes=(),
    )


def attempt_verdict(outcome, blame="environment", recovery="unguided"):
    return AttemptVerdict(
        outcome=outcome,
        blame=blame,
        recovery=recovery,
        cls=derive_class(outcome, blame, recovery),
        subtype=None,
        evidence="fixture",
    )


def test_clean_attempt_scores_full_value():
    score = score_attempt([verdict("ok", recovery="n/a")])

    assert score.value == 1.0
    assert not score.excluded


def test_class_b_hint_scores_better_than_silent_class_c_zero():
    guided_hint = verdict("error", recovery="guided")
    silent_zero = verdict("empty", recovery="unguided", subtype="c-unknown")

    assert guided_hint.cls == "B"
    assert silent_zero.cls == "C"
    assert score_attempt([guided_hint]).value > score_attempt([silent_zero]).value


def test_class_c_dominates_several_guided_class_b_failures():
    one_silent = score_attempt([verdict("empty", recovery="unguided", subtype="c-unknown")])
    several_guided = score_attempt([verdict("error", recovery="guided") for _ in range(3)])

    assert one_silent.value < several_guided.value


def test_environment_call_is_dropped_from_scoring():
    clean = verdict("ok", recovery="n/a")
    network = verdict("error", blame="environment", recovery="unguided")

    with_network = score_attempt([network, clean])
    without_network = score_attempt([clean])

    assert with_network.value == without_network.value
    assert with_network.environment == (network,)
    assert with_network.charged == (clean,)


def test_attempt_level_quota_environment_is_excluded_when_nothing_was_measured():
    quota = attempt_verdict("error")

    score = score_attempt([], attempt=quota)

    assert score.excluded
    assert score.value is None
    assert score.attempt_environment == quota


def test_agent_side_class_f_is_recorded_not_charged():
    agent_fault = verdict("error", blame="agent", recovery="guided")
    clean = verdict("ok", recovery="n/a")

    score = score_attempt([agent_fault, clean], agent_side=[{"kind": "ignored_hint", "strict": True}])

    assert score.value == score_attempt([clean]).value
    assert score.recorded_not_charged == (agent_fault,)
    assert score.charged == (clean,)


def test_ignored_hint_detail_does_not_turn_guided_tool_signal_into_tool_penalty():
    guided_hint = verdict("error", recovery="guided")

    with_agent_detail = score_attempt([guided_hint], agent_side=[{
        "kind": "ignored_hint",
        "strict": True,
        "window": {"from_call": 1, "to_call": 3},
    }])
    without_agent_detail = score_attempt([guided_hint])

    assert with_agent_detail.value == without_agent_detail.value
