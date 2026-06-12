"""Aggregate retrieval metrics and render the per-slice scorecard.

Each slice writes two files under ``eval/results/``:

* ``sliceN.json`` — the machine-readable numbers (so the *next* slice can diff
  against them programmatically, not by eyeballing a table);
* ``sliceN.md`` — the human scorecard: overall + per-query-type, and a
  side-by-side delta vs the previous slice when its JSON is present.

Null queries carry no gold docs, so they're counted but excluded from the recall
/ MRR / NDCG means — their quality is an answer-side question (slice 6), not a
retrieval-recall one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, pstdev

from core.models import EvalExample, RetrievedChunk
from eval.retrieval import per_query_metrics
from eval.stratified import QUERY_TYPES

RESULTS_DIR = Path(__file__).parent / "results"
METRIC_ORDER = ("recall@5", "recall@10", "recall@20", "mrr", "ndcg@10")


@dataclass
class QueryEval:
    example: EvalExample
    metrics: dict[str, float] | None  # None for null_query (empty gold)


def evaluate_retrieval(
    examples: list[EvalExample],
    retrieve,
    ks=(5, 10, 20),
) -> list[QueryEval]:
    """Run ``retrieve(query, k)`` for each example and score it."""
    fetch_k = max(ks)
    out: list[QueryEval] = []
    for ex in examples:
        hits: list[RetrievedChunk] = retrieve(ex.query, fetch_k)
        out.append(QueryEval(example=ex, metrics=per_query_metrics(hits, ex.gold_doc_ids, ks)))
    return out


def _summarise(rows: list[QueryEval]) -> dict:
    scored = [r.metrics for r in rows if r.metrics is not None]
    summary: dict = {"n": len(rows), "n_scored": len(scored)}
    if not scored:
        return summary
    for m in METRIC_ORDER:
        vals = [s[m] for s in scored if m in s]
        summary[m] = {"mean": mean(vals), "std": pstdev(vals) if len(vals) > 1 else 0.0}
    return summary


def aggregate(rows: list[QueryEval]) -> dict:
    by_type = {
        qt: _summarise([r for r in rows if r.example.question_type == qt])
        for qt in QUERY_TYPES
    }
    answerable = [r for r in rows if r.example.question_type != "null_query"]
    return {"overall_answerable": _summarise(answerable), "by_type": by_type}


# --- rendering -----------------------------------------------------------


def _fmt(summary: dict, metric: str) -> str:
    cell = summary.get(metric)
    if not isinstance(cell, dict):
        return "—"
    return f"{cell['mean']:.3f}"


def _metric_table(title: str, rows: list[tuple[str, dict]]) -> str:
    head = "| " + title + " | n | " + " | ".join(METRIC_ORDER) + " |"
    sep = "|" + "---|" * (len(METRIC_ORDER) + 2)
    lines = [head, sep]
    for label, summary in rows:
        cells = [_fmt(summary, m) for m in METRIC_ORDER]
        lines.append(f"| {label} | {summary.get('n', 0)} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _delta_table(curr: dict, prev: dict) -> str:
    head = "| metric | prev | curr | Δ |"
    lines = [head, "|---|---|---|---|"]
    for m in METRIC_ORDER:
        c = curr["overall_answerable"].get(m)
        p = prev.get("metrics", {}).get("overall_answerable", {}).get(m)
        if not isinstance(c, dict) or not isinstance(p, dict):
            continue
        d = c["mean"] - p["mean"]
        lines.append(f"| {m} | {p['mean']:.3f} | {c['mean']:.3f} | {d:+.3f} |")
    return "\n".join(lines)


def render_markdown(payload: dict, prev: dict | None) -> str:
    agg = payload["metrics"]
    parts: list[str] = []
    n = payload["slice"]
    parts.append(f"# Slice {n} — retrieval eval ({payload['stage']})\n")
    parts.append(
        f"_Generated {payload['timestamp']}_ · corpus **{payload['corpus_docs']} docs / "
        f"{payload['corpus_chunks']} chunks** · eval **{payload['eval_size']} queries** "
        f"({payload['per_type']}/type) · embedder `{payload['embedder']}` (dim "
        f"{payload['dim']})\n"
    )

    parts.append("## Overall (answerable queries)\n")
    parts.append(_metric_table("scope", [("answerable", agg["overall_answerable"])]))

    parts.append("\n## By query type\n")
    type_rows = [(qt, agg["by_type"][qt]) for qt in QUERY_TYPES]
    parts.append(_metric_table("query type", type_rows))
    parts.append(
        "\n> `null_query` has no gold documents (the right answer is "
        '"Insufficient information"), so retrieval recall/MRR/NDCG are undefined '
        "for it — its quality is measured on the answer side in slice 6."
    )

    lat = payload.get("reranker_latency_ms")
    if lat:
        device = lat.get("device", "cpu")
        parts.append(
            f"\n## Reranker latency (`{lat['model']}`)\n\n"
            f"Per-query cross-encoder scoring over {payload.get('candidate_k', 50)} "
            f"candidates (n={lat['n']}): **median {lat['median']:.0f} ms**, "
            f"**p95 {lat['p95']:.0f} ms** ({device})."
        )

    if prev is not None:
        parts.append(f"\n## Delta vs slice {prev['slice']} ({prev['stage']})\n")
        parts.append(_delta_table(agg, prev))

    return "\n".join(parts) + "\n"


def write_slice(payload: dict, prev_slice: int | None = None) -> tuple[Path, Path]:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    prev = None
    if prev_slice is not None:
        prev_path = RESULTS_DIR / f"slice{prev_slice}.json"
        if prev_path.exists():
            prev = json.loads(prev_path.read_text())

    md = render_markdown(payload, prev)
    json_path = RESULTS_DIR / f"slice{payload['slice']}.json"
    md_path = RESULTS_DIR / f"slice{payload['slice']}.md"
    json_path.write_text(json.dumps(payload, indent=2))
    md_path.write_text(md)
    return json_path, md_path
