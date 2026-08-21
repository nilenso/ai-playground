"""Sabotage fixtures for validating invisible-failure detection.

These fixtures are static and cheap. They intentionally do not run botmap or an
LLM; they encode recorded failure shapes so taxonomy/probe code can prove it
fires before any measurement run is allowed.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable

from autoresearch.agenteval.contract import CallVerdict, Probe, derive_class

Classifier = Callable[[dict[str, Any]], CallVerdict | dict[str, Any]]


@dataclass(frozen=True)
class SabotageFixture:
    id: str
    expected_class: str | None
    expected_subtype: str | None
    call: dict[str, Any]
    source: str


@dataclass(frozen=True)
class SabotageResult:
    fixture_id: str
    passed: bool
    expected_class: str | None
    actual_class: str | None
    expected_subtype: str | None
    actual_subtype: str | None
    detail: str


def expected_verdict(call: dict[str, Any]) -> CallVerdict:
    """Reference classifier for the static fixtures until taxonomy.py lands."""
    cls = derive_class(call["outcome"], call["blame"], call["recovery"])
    return CallVerdict(
        outcome=call["outcome"],
        blame=call["blame"],
        recovery=call["recovery"],
        cls=cls,
        subtype=call.get("subtype"),
        evidence=call.get("evidence", ""),
        probes=tuple(call.get("probes", ())),
    )


def run_sabotage(classifier: Classifier, fixtures: Iterable[SabotageFixture] | None = None) -> list[SabotageResult]:
    """Run fixtures through a classifier and report mismatches."""
    checked_fixtures = FIXTURES if fixtures is None else fixtures
    results: list[SabotageResult] = []
    for fixture in checked_fixtures:
        verdict = classifier(fixture.call)
        actual_class = _field(verdict, "cls", "class")
        actual_subtype = _field(verdict, "subtype")
        passed = actual_class == fixture.expected_class and actual_subtype == fixture.expected_subtype
        results.append(
            SabotageResult(
                fixture_id=fixture.id,
                passed=passed,
                expected_class=fixture.expected_class,
                actual_class=actual_class,
                expected_subtype=fixture.expected_subtype,
                actual_subtype=actual_subtype,
                detail="ok" if passed else f"expected {fixture.expected_class}/{fixture.expected_subtype}, got {actual_class}/{actual_subtype}",
            )
        )
    return results


def assert_sabotage_passes(classifier: Classifier, fixtures: Iterable[SabotageFixture] | None = None) -> None:
    failures = [result for result in run_sabotage(classifier, fixtures) if not result.passed]
    if failures:
        details = "; ".join(f"{item.fixture_id}: {item.detail}" for item in failures)
        raise AssertionError(f"sabotage fixtures failed: {details}")


def _call(
    *,
    argv: list[str],
    outcome: str,
    recovery: str,
    evidence: str,
    exit_code: int = 0,
    blame: str = "tool",
    subtype: str | None = None,
    stdout_head: str = "",
    stderr_head: str = "",
    duration_s: float = 1.0,
    probes: tuple[Probe, ...] = (),
) -> dict[str, Any]:
    return {
        "argv": argv,
        "exit_code": exit_code,
        "stdout_head": stdout_head,
        "stderr_head": stderr_head,
        "duration_s": duration_s,
        "outcome": outcome,
        "blame": blame,
        "recovery": recovery,
        "class": derive_class(outcome, blame, recovery),
        "subtype": subtype,
        "evidence": evidence,
        "probes": [asdict(probe) for probe in probes],
    }


def _field(verdict: CallVerdict | dict[str, Any], *names: str) -> Any:
    for name in names:
        if isinstance(verdict, dict) and name in verdict:
            return verdict[name]
        if hasattr(verdict, name):
            return getattr(verdict, name)
    return None


FIXTURES: tuple[SabotageFixture, ...] = (
    SabotageFixture(
        id="a-raw-traceback-unguided",
        expected_class="A",
        expected_subtype=None,
        source="docs/plan.md class A: raw traceback/refusal left agent unguided",
        call=_call(
            argv=["count", "-t", "place", "--in", "Brooklyn, US-NY", "--where", "categories.primary=coffee_shop"],
            exit_code=1,
            outcome="error",
            recovery="unguided",
            evidence="unhandled tool traceback, no retry instruction",
            stderr_head="Traceback (most recent call last): ValueError: unsupported filter operator",
        ),
    ),
    SabotageFixture(
        id="b-did-you-mean-guided",
        expected_class="B",
        expected_subtype=None,
        source="experiments/arm-a/HANDOVER.md C1: count-zero-hint emits bus_station near-match",
        call=_call(
            argv=["count", "-t", "place", "--in", "Williamsburg, Brooklyn, NY", "--where", "categories.primary=bus_stop"],
            exit_code=2,
            outcome="error",
            recovery="guided",
            evidence="tool names a concrete replacement value",
            stderr_head="Bad category value 'bus_stop'. Did you mean: bus_station",
        ),
    ),
    SabotageFixture(
        id="c-vocabulary-bus-stop",
        expected_class="C",
        expected_subtype="c-vocabulary",
        source="baseline-noise-run1 bus-stops-with-coffee__r2 commands.jsonl; failure_dataset no-hint-on-count-and-sample",
        call=_call(
            argv=["count", "-t", "place", "--in", "Williamsburg, Brooklyn, NY", "--where", "categories.primary=bus_stop"],
            outcome="empty",
            recovery="unguided",
            subtype="c-vocabulary",
            evidence="bus_stop returned count 0 while taxonomy contains bus_station, not bus_stop",
            stdout_head='{"count": 0}',
            probes=(Probe("vocabulary", "categories -t place --top 5000 | grep bus_stop", "absent; nearest bus_station", True),),
        ),
    ),
    SabotageFixture(
        id="c-wrong-column-recreation",
        expected_class="C",
        expected_subtype="c-wrong-column",
        source="docs/plan.md differential probe example: --class recreation -> 0, subtype=recreation -> 86",
        call=_call(
            argv=["landuse", "--in", "Cambridge, MA", "--class", "recreation"],
            outcome="empty",
            recovery="unguided",
            subtype="c-wrong-column",
            evidence="value exists as subtype, not class",
            stdout_head="0 rows",
            probes=(Probe("column_swap", "landuse --where subtype=recreation", "86 rows", True),),
        ),
    ),
    SabotageFixture(
        id="c-wrong-type-water-as-landuse",
        expected_class="C",
        expected_subtype="c-wrong-type",
        source="experiments/failure_dataset.yaml water/landuse convenience-verb defects",
        call=_call(
            argv=["landuse", "--in", "Boston", "--class", "water"],
            outcome="empty",
            recovery="unguided",
            subtype="c-wrong-type",
            evidence="same intent is answerable through the water verb/type sweep",
            stdout_head="0 rows",
            probes=(Probe("type_sweep", "water --in Boston", "non-empty", True),),
        ),
    ),
    SabotageFixture(
        id="c-dropped-input-repeat-class",
        expected_class="C",
        expected_subtype="c-dropped-input",
        source="docs/plan.md and failure_dataset class-flag-not-repeatable: repeated --class silently keeps last",
        call=_call(
            argv=["roads", "--in", "Malta", "--class", "trunk", "--class", "primary"],
            outcome="empty",
            recovery="unguided",
            subtype="c-dropped-input",
            evidence="repeated flag supplied two values but only last value affected the result",
            stdout_head="0 rows",
            probes=(Probe("argv_echo", "inspect parsed filters", "trunk dropped; primary kept", True),),
        ),
    ),
    SabotageFixture(
        id="c-truncated-bus-station",
        expected_class="C",
        expected_subtype="c-truncated",
        source="docs/plan.md: categories --top 200 omitted bus_station; --top 5000 found all 963",
        call=_call(
            argv=["categories", "-t", "place", "--in", "Williamsburg, Brooklyn, NY", "--top", "200"],
            outcome="empty",
            recovery="unguided",
            subtype="c-truncated",
            evidence="agent inferred absent after reading a capped taxonomy listing",
            stdout_head="[{... 200 categories ...}]",
            probes=(Probe("limit_raise", "categories -t place --top 5000 | grep bus_station", "present", True),),
        ),
    ),
    SabotageFixture(
        id="c-wrong-entity-malta-mt",
        expected_class="C",
        expected_subtype="c-wrong-entity",
        source="baseline-noise-run1 beach-accessibility-malta/malta-highways traces: Malta, MT vs Malta country ambiguity",
        call=_call(
            argv=["count", "-t", "segment", "--in", "Malta, MT", "--where", "class in [motorway,trunk,primary,secondary]"],
            outcome="empty",
            recovery="unguided",
            subtype="c-wrong-entity",
            evidence="question asked Malta country but command resolved Malta, Montana",
            stdout_head='{"count": 26}',
            probes=(Probe("entity_check", "where 'Malta, MT'", "resolved region US-MT, not country MT", True),),
        ),
    ),
    SabotageFixture(
        id="c-unknown-empty-no-probe",
        expected_class="C",
        expected_subtype="c-unknown",
        source="docs/plan.md: empty result with no conclusive differential probe must not silently classify clean",
        call=_call(
            argv=["count", "-t", "place", "--in", "Nowhere", "--where", "categories.primary=unknown"],
            outcome="empty",
            recovery="unguided",
            subtype="c-unknown",
            evidence="empty result; no probe explained why",
            stdout_head='{"count": 0}',
            probes=(Probe("vocabulary", "categories probe budget exhausted", "inconclusive", False),),
        ),
    ),
    SabotageFixture(
        id="d-long-silent-geometry",
        expected_class="D",
        expected_subtype=None,
        source="experiments/arm-a/notes/findings.md and docs/plan.md: division geometry can be correct but silent for 10-20 minutes",
        call=_call(
            argv=["boundary", "Cambridge, MA", "--geometry"],
            outcome="degenerate",
            recovery="n/a",
            evidence="right route but no progress for a long-running operation",
            duration_s=1182.0,
        ),
    ),
    SabotageFixture(
        id="e-quota-attempt-level",
        expected_class="E",
        expected_subtype=None,
        source="experiments/arm-a/notes/findings.md F10: Claude session limit is environment failure",
        call=_call(
            argv=[],
            outcome="error",
            blame="environment",
            recovery="unguided",
            evidence="Claude session limit before usable measurement",
            stderr_head="You've hit your session limit",
        ),
    ),
    SabotageFixture(
        id="f-ignored-guided-hint",
        expected_class="F",
        expected_subtype=None,
        source="experiments/arm-a/HANDOVER.md C1: hint fired and was ignored once",
        call=_call(
            argv=["categories", "-t", "place", "--top", "300"],
            outcome="empty",
            blame="agent",
            recovery="guided",
            evidence="tool had offered bus_station; agent searched taxonomy instead of using it next",
        ),
    ),
)
