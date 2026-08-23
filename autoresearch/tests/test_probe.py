from __future__ import annotations

import json

from autoresearch.agenteval.probe import (
    ProbeBudget,
    ProbeObservation,
    TaxonomySnapshot,
    entity_contradiction,
    probe_call,
    probe_empty,
)
from autoresearch.trace import Call


def call(argv, stdout=None, stderr="", exit_code=0):
    if stdout is None:
        stdout = json.dumps({"count": 0})
    return Call(list(argv), exit_code, stdout, stderr, 1.0)


def observation(count: int):
    return ProbeObservation(stdout=json.dumps({"count": count}))


def list_observation(length: int):
    return ProbeObservation(stdout=json.dumps([{"value": str(i), "count": 1} for i in range(length)]))


def runner_from(mapping):
    calls = []

    def run(argv):
        calls.append(tuple(argv))
        return mapping.get(tuple(argv), observation(0))

    run.calls = calls
    return run


def taxonomy():
    return TaxonomySnapshot(
        {
            "land_use": {
                "class": frozenset({"residential", "commercial"}),
                "subtype": frozenset({"residential", "commercial", "recreation"}),
            },
            "segment": {
                "class": frozenset({"footway"}),
                "subclass": frozenset({"sidewalk"}),
            },
            "land": {"class": frozenset({"beach"})},
            "place": {"categories.primary": frozenset({"bus_station", "coffee_shop"})},
        }
    )


def test_recorded_class_recreation_case_produces_wrong_column_evidence():
    # Static fixture from experiments/proposals.json and findings.md:
    # Williamsburg land_use recreation returned 0 as class, 86 as subtype.
    original = call(["landuse", "--in", "Williamsburg, NY", "--class", "recreation"])
    run = runner_from(
        {
            ("landuse", "--in", "Williamsburg, NY", "--where", "subtype=recreation"): observation(86),
        }
    )

    result = probe_empty(original, run, taxonomy=taxonomy())

    assert result.subtype == "c-wrong-column"
    assert "class=recreation returned 0" in result.evidence
    assert "subtype=recreation returned 86" in result.evidence
    assert result.probes[-1].kind == "column_swap"
    assert result.probes[-1].conclusive


def test_vocabulary_probe_concludes_absent_value_without_cli_call():
    original = call(["count", "-t", "place", "--where", "categories.primary=bus_stop"])
    run = runner_from({})

    result = probe_empty(original, run, taxonomy=taxonomy())

    assert result.subtype == "c-vocabulary"
    assert "bus_stop absent" in result.evidence
    assert run.calls == []


def test_cli_vocabulary_probe_checks_categories_listing_when_taxonomy_missing():
    original = call(["--json", "count", "-t", "place", "--in", "Cambridge, MA", "--where", "categories.primary=bus_stop"])
    run = runner_from({
        ("--json", "categories", "-t", "place", "--in", "Cambridge, MA", "--top", "5000"):
            ProbeObservation(stdout=json.dumps([{"value": "bus_station", "count": 3}]))
    })

    result = probe_empty(original, run)

    assert result.subtype == "c-vocabulary"
    assert "bus_stop absent" in result.evidence
    assert run.calls == [("--json", "categories", "-t", "place", "--in", "Cambridge, MA", "--top", "5000")]


def test_type_sweep_finds_same_filter_under_another_type():
    original = call(["count", "-t", "land_use", "--in", "Malta", "--where", "class=beach"])
    run = runner_from(
        {
            ("count", "-t", "land", "--in", "Malta", "--where", "class=beach"): observation(67),
        }
    )

    result = probe_empty(original, run, taxonomy=taxonomy())

    assert result.subtype == "c-wrong-type"
    assert "land_use returned 0" in result.evidence
    assert "land returned 67" in result.evidence


def test_limit_raise_detects_silent_truncation():
    original = call(
        ["categories", "-t", "place", "--top", "2"],
        stdout=json.dumps([{"value": "restaurant"}, {"value": "bar"}]),
    )
    run = runner_from({("categories", "-t", "place", "--top", "102"): list_observation(5)})

    result = probe_call(original, run)

    assert result.subtype == "c-truncated"
    assert "equalled limit 2" in result.evidence
    assert "returned 5 rows" in result.evidence


def test_argv_echo_detects_repeated_flag_dropped_by_output_echo():
    original = call(
        ["count", "-t", "road", "--class", "trunk", "--class", "primary"],
        stdout=json.dumps({"count": 0, "where": [{"key": "class", "op": "=", "value": "primary"}]}),
    )
    run = runner_from({})

    result = probe_empty(original, run)

    assert result.subtype == "c-dropped-input"
    assert "repeated filters" in result.evidence
    assert "only 1 of 2" in result.evidence
    assert run.calls == []


def test_entity_check_detects_qualifier_region_contradiction():
    original = call(["count", "-t", "place", "--in", "Reykjavik, IS", "--where", "categories.primary=hotel"])
    run = runner_from(
        {
            ("--json", "where", "Reykjavik, IS"): ProbeObservation(
                stdout=json.dumps({"name": "Is", "country": "ES", "region": "ES-AS"})
            )
        }
    )

    result = probe_empty(original, run)

    assert result.subtype == "c-wrong-entity"
    assert "qualifier IS implies country IS" in result.evidence
    assert "country ES" in result.evidence


def test_inconclusive_probes_are_recorded_as_c_unknown():
    original = call(["count", "-t", "place", "--where", "categories.primary=coffee_shop"])
    run = runner_from({})

    result = probe_empty(original, run, taxonomy=taxonomy())

    assert result.subtype == "c-unknown"
    assert result.probes
    assert all(not probe.conclusive for probe in result.probes)


def test_budget_exhaustion_records_skipped_inconclusive_probe():
    original = call(["count", "-t", "land_use", "--where", "class=beach"])
    budget = ProbeBudget(max_calls=0)
    run = runner_from({})

    result = probe_empty(original, run, budget=budget)

    assert result.subtype == "c-unknown"
    assert result.probes[0].result == "skipped: probe budget exhausted"
    assert result.probes[0].conclusive is False
    assert budget.log == [
        {
            "kind": "column_swap",
            "argv": ["count", "-t", "land_use", "--where", "subtype=beach"],
            "ran": False,
            "reason": "budget_exhausted",
        }
    ]


def test_budget_log_records_mocked_cli_probe_calls():
    original = call(["landuse", "--class", "recreation"])
    budget = ProbeBudget(max_calls=3)
    run = runner_from({("landuse", "--where", "subtype=recreation"): observation(86)})

    result = probe_empty(original, run, budget=budget, taxonomy=taxonomy())

    assert result.subtype == "c-wrong-column"
    assert budget.used == 1
    assert budget.log == [
        {"kind": "column_swap", "argv": ["landuse", "--where", "subtype=recreation"], "ran": True}
    ]


def test_entity_probe_accepts_us_state_abbreviations_that_are_also_country_codes():
    cambridge = json.dumps({"name": "Cambridge", "country": "US", "region": "US-MA"})
    malta_montana = json.dumps({"name": "Malta", "country": "US", "region": "US-MT"})

    assert entity_contradiction("Cambridge, MA", cambridge) is None
    assert entity_contradiction("Malta, MT", malta_montana) is None


def test_entity_probe_still_flags_wrong_us_state_resolution():
    resolved = json.dumps({"name": "Cambridge", "country": "US", "region": "US-MD"})

    problem = entity_contradiction("Cambridge, MA", resolved)

    assert problem is not None
    assert "US-MA" in problem
