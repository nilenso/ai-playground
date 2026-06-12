"""Run the stratified retrieval eval against an already-built index.

    python -m eval.run_retrieval --slice 2 --stage dense
    python -m eval.run_retrieval --slice 3 --stage hybrid --prev-slice 2
    python -m eval.run_retrieval --slice 4 --stage rerank --prev-slice 3

Reads the persistent Qdrant index (built by ``apps.index``), scores the same
100-query stratified set with ``recall@{5,10,20}`` / MRR / NDCG@10, and writes
``eval/results/sliceN.{json,md}`` — the latter with a delta table vs the previous
slice. The eval never re-indexes; indexing is a separate entry point.
"""

from __future__ import annotations

import argparse
import time
from datetime import datetime, timezone

from apps.stack import (
    CANDIDATE_K,
    DEFAULT_PERSIST_DIR,
    STAGES,
    build_embedder,
    build_retriever,
    build_source,
    build_store,
)
from eval.report import aggregate, evaluate_retrieval, write_slice
from eval.stratified import build_stratified_eval


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stratified retrieval eval")
    parser.add_argument("--slice", type=int, required=True)
    parser.add_argument("--stage", choices=STAGES, default="dense")
    parser.add_argument("--persist-dir", default=DEFAULT_PERSIST_DIR)
    parser.add_argument("--per-type", type=int, default=25)
    parser.add_argument("--prev-slice", type=int, default=None)
    parser.add_argument("--client", action="store_true",
                        help="construct an Anthropic client (needed for multiquery)")
    args = parser.parse_args(argv)

    client = None
    if args.client or args.stage == "multiquery":
        import anthropic

        client = anthropic.Anthropic()

    source = build_source()
    embedder, name = build_embedder()
    store = build_store(embedder.dim, stage=args.stage, persist_dir=args.persist_dir)
    if store.count() == 0:
        raise SystemExit(
            f"index at {args.persist_dir} is empty — run `python -m apps.index "
            f"--stage {args.stage}` first"
        )
    retriever = build_retriever(args.stage, embedder, store, client=client)

    examples = build_stratified_eval(source.get_eval_set(), per_type=args.per_type)
    print(f"scoring {len(examples)} queries | stage={args.stage} | points={store.count()}")

    t0 = time.perf_counter()
    rows = evaluate_retrieval(examples, retriever.retrieve)
    dt = time.perf_counter() - t0
    agg = aggregate(rows)

    # Reranker latency (slice 4 AC): median + p95 per query, if a reranker ran.
    reranker = getattr(retriever, "reranker", None) or getattr(
        getattr(retriever, "inner", None), "reranker", None
    )
    rerank_latency = None
    if reranker is not None and getattr(reranker, "latencies_ms", None):
        lat = sorted(reranker.latencies_ms)
        rerank_latency = {
            "model": getattr(reranker, "model_name", "?"),
            "device": getattr(reranker, "device", None) or "cpu",
            "median": lat[len(lat) // 2],
            "p95": lat[min(len(lat) - 1, int(0.95 * len(lat)))],
            "n": len(lat),
        }

    payload = {
        "slice": args.slice,
        "stage": args.stage,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "corpus_docs": sum(1 for _ in source.iter_documents()),
        "corpus_chunks": store.count(),
        "eval_size": len(examples),
        "per_type": args.per_type,
        "embedder": name,
        "dim": embedder.dim,
        "elapsed_s": round(dt, 1),
        "candidate_k": CANDIDATE_K,
        "reranker_latency_ms": rerank_latency,
        "metrics": agg,
    }
    json_path, md_path = write_slice(payload, prev_slice=args.prev_slice)

    o = agg["overall_answerable"]
    print(f"done in {dt:.1f}s | "
          + " ".join(f"{m}={o[m]['mean']:.3f}" for m in ("recall@10", "mrr", "ndcg@10") if m in o))
    print(f"wrote {md_path} and {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
