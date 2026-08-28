from dataclasses import dataclass

from autoresearch.agenteval.contract import Probe, derive_class
from autoresearch.agenteval.taxonomy import classify, classify_attempt


@dataclass(frozen=True)
class Call:
    argv: list[str]
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""


def test_clean_call_has_null_class_derived_from_axes():
    verdict = classify(Call(["count"], stdout="12"))

    assert verdict.outcome == "ok"
    assert verdict.blame == "tool"
    assert verdict.recovery == "n/a"
    assert verdict.cls is None
    assert verdict.cls == derive_class(verdict.outcome, verdict.blame, verdict.recovery)


def test_exit_zero_did_you_mean_is_guided_class_b_recovery_signal():
    verdict = classify(Call(
        ["count", "-t", "place", "--where", "categories.primary=bus_stop"],
        exit_code=0,
        stderr="0 rows. No place has categories.primary=bus_stop. Did you mean: bus_station?",
    ))

    assert verdict.outcome == "error"
    assert verdict.recovery == "guided"
    assert verdict.cls == "B"
    assert verdict.cls == derive_class(verdict.outcome, verdict.blame, verdict.recovery)


def test_network_traceback_is_attempt_environment_shape_not_tool_crash():
    verdict = classify(Call(
        ["count"],
        exit_code=1,
        stderr="Traceback (most recent call last): AWS Error NETWORK_CONNECTION curlCode: 28, Timeout was reached",
    ))

    assert verdict.blame == "environment"
    assert verdict.cls == "E"
    assert verdict.subtype is None


def test_empty_without_conclusive_probe_is_class_c_unknown_not_clean():
    verdict = classify(Call(["count"], stdout="0"))

    assert verdict.outcome == "empty"
    assert verdict.recovery == "unguided"
    assert verdict.cls == "C"
    assert verdict.subtype == "c-unknown"


def test_conclusive_probe_names_class_c_subtype():
    probe = Probe(
        kind="column_swap",
        ran="count -t land --class recreation; count -t land --where subtype=recreation",
        result="class returned 0; subtype returned 86",
        conclusive=True,
    )

    verdict = classify(Call(["count"], stderr="0 rows"), probes=(probe,))

    assert verdict.cls == "C"
    assert verdict.subtype == "c-wrong-column"
    assert verdict.probes == (probe,)
    assert "86" in verdict.evidence


def test_quota_is_attempt_level_environment_verdict_without_call():
    class Transcript:
        quota_exhausted = True
        final_answer = "You've hit your session limit"

    verdict = classify_attempt(Transcript())

    assert verdict is not None
    assert verdict.blame == "environment"
    assert verdict.cls == "E"
    assert verdict.subtype is None


def test_non_quota_attempt_has_no_attempt_verdict():
    class Transcript:
        quota_exhausted = False
        final_answer = "12 hospitals"

    assert classify_attempt(Transcript()) is None
