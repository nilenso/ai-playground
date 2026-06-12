"""Stratified eval-set builder — balance across the four MultiHopRAG query types.

An unstratified random sample under-represents ``null_query`` (301 of 2,556 rows,
~12%), and the null bucket is the one that catches hallucination — the "Honest I
don't know" story. So we sample an equal number per type and fix the seed, so the
*same* 100 queries are scored at every slice and the before/after deltas are real
deltas, not sampling noise.
"""

from __future__ import annotations

import random

from core.models import EvalExample

QUERY_TYPES = (
    "inference_query",
    "comparison_query",
    "temporal_query",
    "null_query",
)


def build_stratified_eval(
    examples: list[EvalExample],
    per_type: int = 25,
    seed: int = 42,
) -> list[EvalExample]:
    """Return ``per_type`` examples for each query type (default 25×4 = 100).

    Deterministic: a fixed-seed shuffle within each type, then take the first
    ``per_type``. Raises if a type has too few examples to fill its quota.
    """
    by_type: dict[str, list[EvalExample]] = {t: [] for t in QUERY_TYPES}
    for ex in examples:
        if ex.question_type in by_type:
            by_type[ex.question_type].append(ex)

    rng = random.Random(seed)
    selected: list[EvalExample] = []
    for qtype in QUERY_TYPES:
        pool = by_type[qtype]
        if len(pool) < per_type:
            raise ValueError(
                f"{qtype}: need {per_type} examples, only {len(pool)} available"
            )
        # Sort by query for a stable starting order, then shuffle with the seed.
        pool = sorted(pool, key=lambda e: e.query)
        rng.shuffle(pool)
        selected.extend(pool[:per_type])
    return selected
