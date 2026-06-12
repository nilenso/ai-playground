"""Index the MultiHopRAG corpus into persistent Qdrant — a standalone entry point.

    python -m apps.index                 # dense index at ./qdrant_db (idempotent)
    python -m apps.index --stage hybrid  # dense + sparse BM25 (slice 3+)
    python -m apps.index --rebuild       # recreate the collection from scratch

Indexing is deliberately separate from evaluation (slice-2 acceptance criterion):
re-running this over an unchanged corpus re-embeds nothing, and the eval harness
reads whatever is already on disk without ever re-indexing.
"""

from __future__ import annotations

import argparse
import time

from apps.stack import (
    DEFAULT_PERSIST_DIR,
    STAGES,
    build_embedder,
    build_sparse_embedder,
    build_source,
    build_store,
    index_corpus,
    _stage_is_hybrid,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Index MultiHopRAG into Qdrant")
    parser.add_argument("--stage", choices=STAGES, default="dense")
    parser.add_argument("--persist-dir", default=DEFAULT_PERSIST_DIR)
    parser.add_argument("--rebuild", action="store_true", help="recreate the collection")
    parser.add_argument("--limit", type=int, default=None, help="cap docs (smoke test)")
    args = parser.parse_args(argv)

    source = build_source(limit=args.limit)
    embedder, name = build_embedder()
    store = build_store(
        embedder.dim, stage=args.stage, persist_dir=args.persist_dir, recreate=args.rebuild
    )
    sparse = build_sparse_embedder() if _stage_is_hybrid(args.stage) else None

    print(f"indexing | stage={args.stage} | embedder={name} (dim={embedder.dim}) "
          f"| store={args.persist_dir} | already present={store.count()} points")
    t0 = time.perf_counter()
    stats = index_corpus(source, embedder, store, sparse_embedder=sparse)
    dt = time.perf_counter() - t0

    print(
        f"done in {dt:.1f}s | docs={stats.documents} chunks={stats.chunks} "
        f"embedded={stats.embedded} skipped(present)={stats.skipped} "
        f"| total points now={store.count()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
