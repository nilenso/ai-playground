#!/usr/bin/env python3
"""Aggregate scored eval records into a human-readable summary.

Complements score.py (per-run records) with cross-run rollups: per-tier
outcomes, error taxonomy frequencies, download usage split by legitimacy, and
the commands agents actually constructed per question.

Usage: uv run python -m evals.analyze [--questions PATH] [--runs-dir PATH]
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

from ..questions import question_map

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_records(runs_dir: Path) -> list[dict]:
    records = []
    for rec in sorted(runs_dir.glob("*__r*/record.json")):
        try:
            records.append(json.loads(rec.read_text()))
        except json.JSONDecodeError:
            print(f"[analyze] unreadable record: {rec}")
    return records


def shim_calls(runs_dir: Path, question_id: str) -> list[list[str]]:
    """Every argv the agent invoked for a question, across repeats."""
    calls = []
    for log in sorted(runs_dir.glob(f"{question_id}__r*/shim.log")):
        for line in log.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                calls.append(json.loads(line).get("argv", []))
            except json.JSONDecodeError:
                continue
    return calls


_GLOBAL_FLAGS = {"--json", "--verbose", "--version"}


def _subcommand(argv: list[str]) -> str:
    """First non-global-flag token. argv excludes the program name."""
    for tok in argv:
        if tok in _GLOBAL_FLAGS:
            continue
        if tok.startswith("-"):
            return "(no subcommand)"
        return tok
    return "(empty)"


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "—"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--questions", type=Path, default=REPO_ROOT / "evals" / "questions-newset.yaml")
    p.add_argument("--runs-dir", type=Path, default=REPO_ROOT / "evals" / "runs")
    p.add_argument("--show-commands", action="store_true", help="Print every command per question.")
    args = p.parse_args()

    qmap = question_map(args.questions)
    records = load_records(args.runs_dir)
    if not records:
        raise SystemExit(f"[analyze] no records under {args.runs_dir}; run score.py first")

    n = len(records)
    print(f"# Eval summary — {n} runs over {len({r['question_id'] for r in records})} questions\n")

    # ---- headline -------------------------------------------------------
    completed = sum(1 for r in records if r.get("completed"))
    errored = sum(1 for r in records if r.get("cli_error_count", 0) > 0)
    recovered = sum(1 for r in records if r.get("recovered"))
    unnecessary = sum(1 for r in records if r.get("unnecessary_download"))
    legit = sum(1 for r in records if r.get("legitimate_download"))
    cost = sum(r.get("cost_usd") or 0 for r in records)
    print("## Headline")
    print(f"- completed:             {completed}/{n}  ({pct(completed, n)})")
    print(f"- runs with a CLI error: {errored}/{n}  ({pct(errored, n)})")
    print(f"- recovered after error: {recovered}/{errored if errored else 0}")
    print(f"- unnecessary download:  {unnecessary}  (agent failure)")
    print(f"- legitimate download:   {legit}  (coverage gap)")
    print(f"- total cost:            ${cost:.2f}")
    print(f"- mean commands/run:     {sum(r.get('command_count', 0) for r in records) / n:.1f}\n")

    # ---- per tier -------------------------------------------------------
    print("## By tier")
    print("| tier | runs | completed | err runs | errors | unnec. dl | legit dl | cmds/run |")
    print("|---|---|---|---|---|---|---|---|")
    by_tier = collections.defaultdict(list)
    for r in records:
        by_tier[r.get("tier", 0)].append(r)
    for tier in sorted(by_tier):
        rs = by_tier[tier]
        t = len(rs)
        print(
            f"| {tier} | {t} | {pct(sum(1 for r in rs if r.get('completed')), t)} "
            f"| {sum(1 for r in rs if r.get('cli_error_count', 0) > 0)} "
            f"| {sum(r.get('cli_error_count', 0) for r in rs)} "
            f"| {sum(1 for r in rs if r.get('unnecessary_download'))} "
            f"| {sum(1 for r in rs if r.get('legitimate_download'))} "
            f"| {sum(r.get('command_count', 0) for r in rs) / t:.1f} |"
        )

    # ---- error taxonomy -------------------------------------------------
    tax = collections.Counter()
    tax_examples: dict[str, list[str]] = collections.defaultdict(list)
    for r in records:
        for e in r.get("errors", []):
            tax[e["taxonomy"]] += 1
            if len(tax_examples[e["taxonomy"]]) < 3:
                tax_examples[e["taxonomy"]].append(" ".join(e["argv"][1:])[:110])
    print("\n## Error taxonomy")
    if not tax:
        print("_no CLI errors recorded_")
    for label, c in tax.most_common():
        print(f"\n**{label}** — {c}")
        for ex in tax_examples[label]:
            print(f"  - `{ex}`")

    # ---- worst questions ------------------------------------------------
    print("\n## Questions ranked by trouble")
    print("| question | tier | errors | unnec. dl | completed | cmds |")
    print("|---|---|---|---|---|---|")
    by_q = collections.defaultdict(list)
    for r in records:
        by_q[r["question_id"]].append(r)
    ranked = sorted(
        by_q.items(),
        key=lambda kv: (
            -sum(r.get("cli_error_count", 0) for r in kv[1]),
            -sum(1 for r in kv[1] if r.get("unnecessary_download")),
            sum(1 for r in kv[1] if r.get("completed")),
        ),
    )
    for qid, rs in ranked:
        print(
            f"| {qid} | {rs[0].get('tier')} "
            f"| {sum(r.get('cli_error_count', 0) for r in rs)} "
            f"| {sum(1 for r in rs if r.get('unnecessary_download'))} "
            f"| {sum(1 for r in rs if r.get('completed'))}/{len(rs)} "
            f"| {sum(r.get('command_count', 0) for r in rs)} |"
        )

    # ---- verb usage -----------------------------------------------------
    verbs = collections.Counter()
    for qid in by_q:
        for argv in shim_calls(args.runs_dir, qid):
            verbs[_subcommand(argv)] += 1
    print("\n## Verbs the agents actually reached for")
    for v, c in verbs.most_common(20):
        print(f"- {v}: {c}")

    if args.show_commands:
        print("\n## Every command, by question")
        for qid in sorted(by_q):
            print(f"\n### {qid}  (ideal: {qmap.get(qid, {}).get('notes', '')[:90]}…)")
            for argv in shim_calls(args.runs_dir, qid):
                print(f"  botmap {' '.join(argv)}")


if __name__ == "__main__":
    main()
