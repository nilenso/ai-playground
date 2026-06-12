"""Slice-5 smoke test — show the agent decomposing multi-hop queries.

Runs the full agent (multi-query retriever) on a few known multi-hop MultiHopRAG
questions and prints the distinct searches it issued, to verify the tightened
prompt makes it chase *missing sub-facts* with narrower follow-ups rather than
re-asking the original question. Writes a committed artifact at
``eval/results/slice5_agent_smoke.md``.

    python -m apps.smoke_multihop          # picks 3 multi-hop queries
    python -m apps.smoke_multihop -n 5
"""

from __future__ import annotations

import argparse
from pathlib import Path

import anthropic

from apps.stack import (
    DEFAULT_PERSIST_DIR,
    build_embedder,
    build_retriever,
    build_source,
    build_store,
)
from agent.loop import run_agent
from eval.stratified import build_stratified_eval

OUT = Path(__file__).parent.parent / "eval" / "results" / "slice5_agent_smoke.md"


def pick_multihop(source, n: int):
    """Multi-hop = answerable queries whose gold spans ≥2 documents."""
    examples = build_stratified_eval(source.get_eval_set(), per_type=25)
    multihop = [e for e in examples
                if e.question_type in ("inference_query", "comparison_query")
                and len(e.gold_doc_ids) >= 2]
    return multihop[:n]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-n", type=int, default=3)
    parser.add_argument("--persist-dir", default=DEFAULT_PERSIST_DIR)
    args = parser.parse_args(argv)

    client = anthropic.Anthropic()
    source = build_source()
    embedder, _ = build_embedder()
    store = build_store(embedder.dim, stage="multiquery", persist_dir=args.persist_dir)
    retriever = build_retriever("multiquery", embedder, store, client=client)

    queries = pick_multihop(source, args.n)
    lines = ["# Slice 5 — agent multi-hop smoke test\n",
             "Full agent (multi-query retriever) on multi-hop MultiHopRAG queries. "
             "Each row is a distinct search the agent issued via `search_knowledge_base` "
             "— the tightened prompt should make follow-ups target *missing sub-facts*, "
             "not rephrase the question.\n"]

    for i, ex in enumerate(queries, 1):
        result = run_agent(client, retriever, ex.query, k=8, max_turns=6)
        print(f"[{i}] {ex.query}")
        for s in result.searches:
            print(f"     search: {s}")
        lines.append(f"\n## {i}. {ex.query}\n")
        lines.append(f"*gold docs: {', '.join(ex.gold_doc_ids)} · "
                     f"{result.turns} turns · {len(result.searches)} searches*\n")
        lines.append("Searches issued (in order):\n")
        for j, s in enumerate(result.searches, 1):
            lines.append(f"{j}. `{s}`")
        ans = result.answer.replace("\n", " ")
        lines.append(f"\n**Answer:** {ans[:400]}")
        lines.append(f"\n**Citations:** {len(result.citations)} "
                     f"→ {', '.join(sorted({c.doc_id for c in result.citations if c.doc_id}))}")

    OUT.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
