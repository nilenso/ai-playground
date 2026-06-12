"""MultiHopRAG app — answer one question against the full corpus, with citations.

    python -m apps.index                                   # build the index once
    python -m apps.multihop_rag "Which company acquired Activision?"
    python -m apps.multihop_rag --stage rerank "..."       # use a fuller pipeline

This is the composition root for the *interactive* path: it reads the persistent
Qdrant index (built by ``apps.index``), hands a ``Retriever`` to the agent, prints
the cited answer, then runs the one-example eval shell (recall@5 + faithfulness).
Indexing is a separate entry point, so the demo never re-embeds the corpus.
"""

from __future__ import annotations

import argparse
import os
import sys

import anthropic

from apps.stack import (
    DEFAULT_PERSIST_DIR,
    STAGES,
    build_embedder,
    build_retriever,
    build_source,
    build_store,
)
from agent.loop import run_agent
from eval.harness import evaluate_example, print_eval


def build_stack(stage: str, persist_dir: str, client):
    source = build_source()
    embedder, name = build_embedder()
    store = build_store(embedder.dim, stage=stage, persist_dir=persist_dir)
    if store.count() == 0:
        print(
            f"index at {persist_dir} is empty — run `python -m apps.index "
            f"--stage {stage}` first.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    retriever = build_retriever(stage, embedder, store, client=client)
    print(
        f"stage={stage} | embedder={name} (dim={embedder.dim}) "
        f"| store={persist_dir} ({store.count()} points)"
    )
    return source, retriever


def _print_answer(question: str, result) -> None:
    print(f"\n=== Question ===\n{question}")
    print(f"\n=== Answer ({result.turns} turn(s)"
          f"{', hit turn cap' if result.stopped_on_cap else ''}) ===")
    print(result.answer or "(no answer)")
    if result.searches:
        print("\nsearches issued: " + " | ".join(repr(s) for s in result.searches))
    print(f"\n=== Citations ({len(result.citations)}) ===")
    if not result.citations:
        print("(none)")
    for i, cit in enumerate(result.citations, 1):
        snippet = cit.cited_text.strip().replace("\n", " ")
        if len(snippet) > 140:
            snippet = snippet[:137] + "..."
        print(f"[{i}] chunk_id={cit.chunk_id}  (doc={cit.doc_id}, title={cit.title!r})")
        print(f'    "{snippet}"')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MultiHopRAG cited-answer demo")
    parser.add_argument("question", nargs="?", help="question to answer")
    parser.add_argument("--stage", choices=STAGES, default="dense")
    parser.add_argument("--persist-dir", default=DEFAULT_PERSIST_DIR)
    parser.add_argument("--k", type=int, default=5, help="top-k chunks per search")
    parser.add_argument("--no-eval", action="store_true", help="skip the eval shell")
    args = parser.parse_args(argv)

    if not os.getenv("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 2

    client = anthropic.Anthropic()
    source, retriever = build_stack(args.stage, args.persist_dir, client)

    if args.question:
        result = run_agent(client, retriever, args.question, k=args.k)
        _print_answer(args.question, result)

    if not args.no_eval:
        examples = source.get_eval_set()
        if examples:
            print_eval(evaluate_example(client, retriever, examples[0], k=args.k))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
