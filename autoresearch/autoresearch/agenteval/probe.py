"""Differential probes for silent agent-evaluation failures.

Probes are deliberately pure around an injected command runner.  Production
wiring can point the runner at botmap later; tests pass static observations, so
this module never spends model quota and never touches the network by itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import shlex
from typing import Any, Callable, Iterable, Mapping, Sequence

from autoresearch.trace import Call

from .contract import Probe


CommandRunner = Callable[[tuple[str, ...]], "ProbeObservation"]


@dataclass(frozen=True)
class ProbeObservation:
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    duration_s: float = 0.0


@dataclass
class ProbeBudget:
    """Per-question probe budget and audit log."""

    max_calls: int
    used: int = 0
    log: list[dict[str, Any]] = field(default_factory=list)

    def run(self, kind: str, argv: Sequence[str], runner: CommandRunner) -> tuple[Probe, ProbeObservation | None]:
        ran = shell_join(argv)
        if self.used >= self.max_calls:
            self.log.append({"kind": kind, "argv": list(argv), "ran": False, "reason": "budget_exhausted"})
            return Probe(kind=kind, ran=ran, result="skipped: probe budget exhausted", conclusive=False), None

        self.used += 1
        self.log.append({"kind": kind, "argv": list(argv), "ran": True})
        observation = runner(tuple(argv))
        return Probe(kind=kind, ran=ran, result=describe_observation(observation), conclusive=False), observation


@dataclass(frozen=True)
class ProbeResult:
    """The probe evidence for one call.

    ``subtype`` is the class-C subtype when a probe conclusively explains a
    silent wrong result.  It stays ``c-unknown`` when probes ran but none could
    explain the empty output.
    """

    probes: tuple[Probe, ...]
    subtype: str
    evidence: str
    budget: ProbeBudget


@dataclass(frozen=True)
class TaxonomySnapshot:
    """Static knowledge a scorer may already have about value locations."""

    values_by_type_and_column: Mapping[str, Mapping[str, frozenset[str]]]

    def types(self) -> tuple[str, ...]:
        return tuple(self.values_by_type_and_column)

    def has_value(self, value: str) -> bool:
        return any(value in values for columns in self.values_by_type_and_column.values() for values in columns.values())

    def columns_for(self, type_name: str, value: str) -> tuple[str, ...]:
        columns = self.values_by_type_and_column.get(type_name, {})
        return tuple(column for column, values in columns.items() if value in values)


DEFAULT_TYPES = ("place", "building", "land", "land_use", "segment", "infrastructure", "address")
VERB_TYPES = {
    "places": "place",
    "place": "place",
    "buildings": "building",
    "building": "building",
    "landuse": "land_use",
    "roads": "segment",
    "road": "segment",
    "segments": "segment",
    "infrastructure": "infrastructure",
    "addresses": "address",
    "address": "address",
}
COLUMN_SWAPS = {
    "class": ("subtype", "subclass"),
    "categories.primary": ("subtype", "categories.alternate", "class"),
    "subtype": ("class", "subclass"),
    "subclass": ("class", "subtype"),
}


_KIND_TO_SUBTYPE = {
    "vocabulary": "c-vocabulary",
    "column_swap": "c-wrong-column",
    "type_sweep": "c-wrong-type",
    "argv_echo": "c-dropped-input",
    "limit_raise": "c-truncated",
    "entity_check": "c-wrong-entity",
}


def probe_empty(
    call: Call,
    runner: CommandRunner,
    *,
    budget: ProbeBudget | None = None,
    taxonomy: TaxonomySnapshot | None = None,
) -> ProbeResult:
    """Run the probes relevant to an empty call.

    The runner is injected to keep this module side-effect free.  Every probe
    records inconclusive evidence; a conclusive probe stops further probing so
    the first explanation remains attributable and budget-bounded.
    """
    active_budget = budget or ProbeBudget(max_calls=8)
    probes: list[Probe] = []

    for probe in _empty_probe_sequence(call, runner, active_budget, taxonomy):
        probes.append(probe)
        if probe.conclusive:
            subtype = _KIND_TO_SUBTYPE[probe.kind]
            return ProbeResult(tuple(probes), subtype, probe.result, active_budget)
        if probe.result == "skipped: probe budget exhausted":
            break

    evidence = "empty result remained unexplained by differential probes"
    return ProbeResult(tuple(probes), "c-unknown", evidence, active_budget)


def probe_call(
    call: Call,
    runner: CommandRunner,
    *,
    budget: ProbeBudget | None = None,
    taxonomy: TaxonomySnapshot | None = None,
) -> ProbeResult:
    """Run probes that apply to this call, empty or not."""
    if is_empty_result(call):
        return probe_empty(call, runner, budget=budget, taxonomy=taxonomy)

    active_budget = budget or ProbeBudget(max_calls=8)
    probes: list[Probe] = []
    for make_probe in (
        lambda: _probe_limit_raise(call, runner, active_budget),
        lambda: _probe_entity_check(call, runner, active_budget),
    ):
        probe = make_probe()
        if probe is not None:
            probes.append(probe)
            if probe.conclusive:
                return ProbeResult(tuple(probes), _KIND_TO_SUBTYPE[probe.kind], probe.result, active_budget)
            if probe.result == "skipped: probe budget exhausted":
                break
    return ProbeResult(tuple(probes), "c-unknown", "no conclusive probe fired", active_budget)


def _empty_probe_sequence(
    call: Call,
    runner: CommandRunner,
    budget: ProbeBudget,
    taxonomy: TaxonomySnapshot | None,
) -> Iterable[Probe]:
    for make_probe in (
        lambda: _probe_argv_echo(call),
        lambda: _probe_vocabulary(call, taxonomy),
        lambda: _probe_vocabulary_cli(call, runner, budget),
        lambda: _probe_column_swap(call, runner, budget, taxonomy),
        lambda: _probe_entity_check(call, runner, budget),
        lambda: _probe_type_sweep(call, runner, budget, taxonomy),
    ):
        probe = make_probe()
        if probe is not None:
            yield probe


def _probe_vocabulary(call: Call, taxonomy: TaxonomySnapshot | None) -> Probe | None:
    filters = value_filters(call.argv)
    if taxonomy is None or not filters:
        return None

    missing = sorted({value for _, value in filters if not taxonomy.has_value(value)})
    if missing:
        values = ", ".join(missing)
        return Probe(
            kind="vocabulary",
            ran=f"taxonomy lookup for {values}",
            result=f"{values} absent from published taxonomy at all known levels",
            conclusive=True,
        )
    checked = ", ".join(sorted({value for _, value in filters}))
    return Probe(
        kind="vocabulary",
        ran=f"taxonomy lookup for {checked}",
        result=f"{checked} exists somewhere in the published taxonomy; vocabulary alone is not explanatory",
        conclusive=False,
    )


def _probe_vocabulary_cli(call: Call, runner: CommandRunner, budget: ProbeBudget) -> Probe | None:
    filters = [(column, value) for column, value in value_filters(call.argv) if column == "categories.primary"]
    if not filters or feature_type(call.argv) != "place":
        return None
    location = location_args(call.argv)
    if not location:
        return None
    argv = ("--json", "categories", "-t", "place", *location, "--top", "5000")
    probe, observation = budget.run("vocabulary", argv, runner)
    if observation is None:
        return probe
    values = category_values(observation.stdout)
    if not values:
        return Probe("vocabulary", probe.ran, "category vocabulary probe returned no values", False)
    missing = [value for _, value in filters if value not in values]
    if missing:
        return Probe(
            "vocabulary",
            probe.ran,
            f"{', '.join(missing)} absent from categories.primary listing of {len(values)} values",
            True,
        )
    return Probe("vocabulary", probe.ran, "filtered value appears in categories.primary listing", False)


def _probe_column_swap(
    call: Call,
    runner: CommandRunner,
    budget: ProbeBudget,
    taxonomy: TaxonomySnapshot | None,
) -> Probe | None:
    filters = value_filters(call.argv)
    type_name = feature_type(call.argv)
    for column, value in filters:
        candidates = COLUMN_SWAPS.get(column, ())
        if taxonomy is not None:
            present_columns = set(taxonomy.columns_for(type_name, value))
            candidates = tuple(candidate for candidate in candidates if candidate in present_columns)
        for replacement in candidates:
            argv = replace_filter(call.argv, column, value, replacement)
            if argv == tuple(call.argv):
                continue
            probe, observation = budget.run("column_swap", argv, runner)
            if observation is None:
                return probe
            count = result_count(observation.stdout)
            if observation.exit_code == 0 and count > 0:
                return Probe(
                    kind="column_swap",
                    ran=probe.ran,
                    result=(
                        f"{column}={value} returned 0; {replacement}={value} returned {count}. "
                        f"The value exists in a different column."
                    ),
                    conclusive=True,
                )
            return Probe(
                kind="column_swap",
                ran=probe.ran,
                result=f"{replacement}={value} returned {count}; column swap inconclusive",
                conclusive=False,
            )
    return None


def _probe_type_sweep(
    call: Call,
    runner: CommandRunner,
    budget: ProbeBudget,
    taxonomy: TaxonomySnapshot | None,
) -> Probe | None:
    filters = value_filters(call.argv)
    if not filters:
        return None
    original_type = feature_type(call.argv)
    types = taxonomy.types() if taxonomy is not None else DEFAULT_TYPES
    location = location_args(call.argv)
    where = [f"{column}={value}" for column, value in filters]

    for candidate_type in types:
        if candidate_type == original_type:
            continue
        argv = ["count", "-t", candidate_type, *location]
        for expression in where:
            argv.extend(["--where", expression])
        probe, observation = budget.run("type_sweep", argv, runner)
        if observation is None:
            return probe
        count = result_count(observation.stdout)
        if observation.exit_code == 0 and count > 0:
            return Probe(
                kind="type_sweep",
                ran=probe.ran,
                result=f"{original_type} returned 0; {candidate_type} returned {count} for the same filter",
                conclusive=True,
            )
    return Probe(
        kind="type_sweep",
        ran=f"type sweep over {', '.join(t for t in types if t != original_type)}",
        result="same filter did not produce results under other feature types",
        conclusive=False,
    )


def _probe_limit_raise(call: Call, runner: CommandRunner, budget: ProbeBudget) -> Probe | None:
    limit = explicit_limit(call.argv)
    if limit is None:
        return None
    current_length = result_length(call.stdout)
    if current_length != limit:
        return None

    raised = max(limit * 10, limit + 100)
    argv = replace_option_value(call.argv, "--top", str(raised))
    argv = replace_option_value(argv, "--limit", str(raised))
    argv = replace_option_value(argv, "-n", str(raised))
    probe, observation = budget.run("limit_raise", argv, runner)
    if observation is None:
        return probe
    raised_length = result_length(observation.stdout)
    if observation.exit_code == 0 and raised_length > current_length:
        return Probe(
            kind="limit_raise",
            ran=probe.ran,
            result=f"original output length equalled limit {limit}; raised limit returned {raised_length} rows",
            conclusive=True,
        )
    return Probe(
        kind="limit_raise",
        ran=probe.ran,
        result=f"raised limit returned {raised_length} rows; truncation inconclusive",
        conclusive=False,
    )


def _probe_argv_echo(call: Call) -> Probe | None:
    repeated = repeated_value_flags(call.argv)
    if not repeated:
        return None

    echoed = echoed_filter_count(call.stdout)
    expected = sum(len(values) for values in repeated.values())
    if echoed is not None and echoed < expected:
        detail = ", ".join(f"{flag} x{len(values)}" for flag, values in repeated.items())
        return Probe(
            kind="argv_echo",
            ran="compare repeated argv flags with JSON echo",
            result=f"argv contained repeated filters ({detail}) but output echoed only {echoed} of {expected}",
            conclusive=True,
        )
    return Probe(
        kind="argv_echo",
        ran="compare repeated argv flags with JSON echo",
        result="repeated flags were present, but output did not prove one was dropped",
        conclusive=False,
    )


def _probe_entity_check(call: Call, runner: CommandRunner, budget: ProbeBudget) -> Probe | None:
    place = place_qualifier(call.argv)
    if place is None:
        return None
    argv = ("--json", "where", place)
    probe, observation = budget.run("entity_check", argv, runner)
    if observation is None:
        return probe
    problem = entity_contradiction(place, observation.stdout)
    if problem:
        return Probe(kind="entity_check", ran=probe.ran, result=problem, conclusive=True)
    return Probe(kind="entity_check", ran=probe.ran, result="resolved entity did not contradict the place qualifier", conclusive=False)


def value_filters(argv: Sequence[str]) -> tuple[tuple[str, str], ...]:
    filters: list[tuple[str, str]] = []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--class" and i + 1 < len(argv):
            filters.append(("class", argv[i + 1]))
            i += 2
            continue
        if token == "--category" and i + 1 < len(argv):
            filters.append(("categories.primary", argv[i + 1]))
            i += 2
            continue
        if token == "--where" and i + 1 < len(argv):
            parsed = parse_filter(argv[i + 1])
            if parsed is not None:
                filters.append(parsed)
            i += 2
            continue
        i += 1
    return tuple(filters)


def parse_filter(expression: str) -> tuple[str, str] | None:
    for operator in ("=", "=="):
        if operator in expression:
            key, value = expression.split(operator, 1)
            return key.strip(), value.strip().strip("'\"")
    return None


def replace_filter(argv: Sequence[str], column: str, value: str, replacement_column: str) -> tuple[str, ...]:
    out: list[str] = []
    i = 0
    replaced = False
    while i < len(argv):
        token = argv[i]
        if token == "--class" and i + 1 < len(argv) and column == "class" and argv[i + 1] == value:
            out.extend(["--where", f"{replacement_column}={value}"])
            i += 2
            replaced = True
            continue
        if token == "--category" and i + 1 < len(argv) and column == "categories.primary" and argv[i + 1] == value:
            out.extend(["--where", f"{replacement_column}={value}"])
            i += 2
            replaced = True
            continue
        if token == "--where" and i + 1 < len(argv):
            parsed = parse_filter(argv[i + 1])
            if parsed == (column, value):
                out.extend(["--where", f"{replacement_column}={value}"])
                i += 2
                replaced = True
                continue
        out.append(token)
        i += 1
    return tuple(out) if replaced else tuple(argv)


def feature_type(argv: Sequence[str]) -> str:
    for flag in ("-t", "--type"):
        if flag in argv:
            index = argv.index(flag)
            if index + 1 < len(argv):
                return argv[index + 1]
    return VERB_TYPES.get(first_command(argv), first_command(argv))


def first_command(argv: Sequence[str]) -> str:
    for token in argv:
        if not token.startswith("-"):
            return token
    return ""


def location_args(argv: Sequence[str]) -> tuple[str, ...]:
    out: list[str] = []
    for flag in ("--in", "--bbox"):
        if flag in argv:
            index = argv.index(flag)
            if index + 1 < len(argv):
                out.extend([flag, argv[index + 1]])
    return tuple(out)


def place_qualifier(argv: Sequence[str]) -> str | None:
    if "--in" in argv:
        index = argv.index("--in")
        if index + 1 < len(argv):
            return argv[index + 1]
    if first_command(argv) == "where" and len(argv) > 1:
        return argv[1]
    return None


def location_args(argv: Sequence[str]) -> tuple[str, ...]:
    for flag in ("--in", "--bbox"):
        if flag in argv:
            index = argv.index(flag)
            if index + 1 < len(argv):
                return (flag, argv[index + 1])
    return ()


def explicit_limit(argv: Sequence[str]) -> int | None:
    for flag in ("--top", "--limit", "-n"):
        if flag in argv:
            index = argv.index(flag)
            if index + 1 < len(argv):
                try:
                    return int(argv[index + 1])
                except ValueError:
                    return None
    return None


def replace_option_value(argv: Sequence[str], flag: str, value: str) -> tuple[str, ...]:
    out = list(argv)
    if flag in out:
        index = out.index(flag)
        if index + 1 < len(out):
            out[index + 1] = value
    return tuple(out)


def repeated_value_flags(argv: Sequence[str]) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token in {"--class", "--category", "--where"} and i + 1 < len(argv):
            values.setdefault(token, []).append(argv[i + 1])
            i += 2
            continue
        i += 1
    return {flag: seen for flag, seen in values.items() if len(seen) > 1}


def category_values(stdout: str) -> frozenset[str]:
    parsed = parse_json(stdout)
    if not isinstance(parsed, list):
        return frozenset()
    return frozenset(
        item["value"]
        for item in parsed
        if isinstance(item, dict) and isinstance(item.get("value"), str)
    )


def result_count(stdout: str) -> int:
    parsed = parse_json(stdout)
    if isinstance(parsed, dict):
        for key in ("count", "total", "rows"):
            if isinstance(parsed.get(key), int):
                return int(parsed[key])
        if isinstance(parsed.get("features"), list):
            return len(parsed["features"])
    if isinstance(parsed, list):
        return len(parsed)
    stripped = stdout.strip()
    if stripped.isdigit():
        return int(stripped)
    return 0


def result_length(stdout: str) -> int:
    parsed = parse_json(stdout)
    if isinstance(parsed, list):
        return len(parsed)
    if isinstance(parsed, dict) and isinstance(parsed.get("features"), list):
        return len(parsed["features"])
    return result_count(stdout)


def echoed_filter_count(stdout: str) -> int | None:
    parsed = parse_json(stdout)
    if not isinstance(parsed, dict):
        return None
    where = parsed.get("where")
    if isinstance(where, list):
        return len(where)
    return None


def is_empty_result(call: Call) -> bool:
    return call.exit_code == 0 and result_count(call.stdout) == 0


def entity_contradiction(place: str, stdout: str) -> str | None:
    parsed = parse_json(stdout)
    if not isinstance(parsed, dict):
        return None
    qualifier = trailing_qualifier(place)
    if qualifier is None:
        return None

    country = str(parsed.get("country") or "").upper()
    region = str(parsed.get("region") or "").upper()
    name = str(parsed.get("name") or "")

    if qualifier in US_STATE_CODES and country == "US":
        expected_region = f"US-{qualifier}"
        if region and region != expected_region:
            return f"qualifier {qualifier} implies {expected_region}, but resolved {name} with country {country} / region {region}"
        return None
    if qualifier in COUNTRY_CODES and country and qualifier != country:
        return f"qualifier {qualifier} implies country {qualifier}, but resolved {name} with country {country} / region {region}"
    if qualifier in US_STATE_CODES and region and region != f"US-{qualifier}":
        return f"qualifier {qualifier} implies US-{qualifier}, but resolved {name} with country {country} / region {region}"
    return None


def trailing_qualifier(place: str) -> str | None:
    parts = [part.strip() for part in place.split(",") if part.strip()]
    if len(parts) < 2:
        return None
    qualifier = parts[-1].upper()
    return qualifier if len(qualifier) == 2 and qualifier.isalpha() else None


def parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def describe_observation(observation: ProbeObservation) -> str:
    count = result_count(observation.stdout)
    if count:
        return f"exit {observation.exit_code}, count {count}"
    stderr = observation.stderr.strip().splitlines()
    suffix = f", stderr: {stderr[0][:120]}" if stderr else ""
    return f"exit {observation.exit_code}, count 0{suffix}"


def shell_join(argv: Sequence[str]) -> str:
    return "botmap " + " ".join(shlex.quote(str(part)) for part in argv)


COUNTRY_CODES = frozenset(
    {
        "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
        "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
        "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
        "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR",
        "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
        "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT",
        "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ",
        "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
        "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
        "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
        "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
    }
)
US_STATE_CODES = frozenset(
    {
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    }
)
