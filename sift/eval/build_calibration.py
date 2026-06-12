"""Capture real agent outputs for the citation-judge calibration set.

Runs the agent on a fixed, type-spanning set of MultiHopRAG queries and writes
each (query, answer, citations[cited_text, chunk_id, title]) to a JSON. A human
then fills in the `human` grade for each item (citation_precision / coverage) by
reading the cited passages, producing `eval/calibration.json`, which
`eval.calibrate` scores the Sonnet judge against.

    python -m eval.build_calibration --out /tmp/calib_raw.json -n 8
"""

from __future__ import annotations

import argparse
import json

import anthropic

from apps.stack import DEFAULT_PERSIST_DIR, build_embedder, build_retriever, build_source, build_store
from agent.loop import run_agent
from eval.stratified import QUERY_TYPES, build_stratified_eval


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/calib_raw.json")
    parser.add_argument("--per-type", type=int, default=2)
    parser.add_argument("--persist-dir", default=DEFAULT_PERSIST_DIR)
    args = parser.parse_args(argv)

    client = anthropic.Anthropic()
    source = build_source()
    embedder, _ = build_embedder()
    store = build_store(embedder.dim, stage="multiquery", persist_dir=args.persist_dir)
    retriever = build_retriever("multiquery", embedder, store, client=client)

    # Deterministic, type-spanning pick from the held-out tail of the eval set
    # (per_type=25 selects the scored set; take from the END so calibration items
    # don't overlap the slice-6 scored queries).
    full = build_stratified_eval(source.get_eval_set(), per_type=25)
    by_type = {qt: [e for e in full if e.question_type == qt] for qt in QUERY_TYPES}
    picks = []
    for qt in QUERY_TYPES:
        picks.extend(by_type[qt][-args.per_type:])

    items = []
    for ex in picks:
        r = run_agent(client, retriever, ex.query, k=8, max_turns=6)
        items.append({
            "query": ex.query,
            "question_type": ex.question_type,
            "reference": ex.answer,
            "answer": r.answer,
            "citations": [
                {"cited_text": c.cited_text, "chunk_id": c.chunk_id, "title": c.title}
                for c in r.citations
            ],
            "human": {"citation_precision": None, "citation_coverage": None, "note": ""},
        })
        print(f"[{ex.question_type}] {len(r.citations)} cites | {ex.query[:55]}")

    with open(args.out, "w") as f:
        json.dump(items, f, indent=2)
    print(f"\nwrote {len(items)} items to {args.out} — fill in the `human` grades")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
