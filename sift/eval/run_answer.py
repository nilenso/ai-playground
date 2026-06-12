"""Slice 6 — full answer-quality eval over the agentic pipeline.

Runs the real agent (retrieve → cite → answer) on the stratified set, then scores
three families side by side so they can be compared (PLAN.md learning #7: high
retrieval + high faithfulness can still sit on top of a wrong answer):

* retrieval — recall@10 / MRR / NDCG@10 (direct retrieve, comparable to slices 2-5)
* Ragas answer quality — context_precision/recall, faithfulness, answer_relevancy,
  factual_correctness (OpenAI judge)
* citation — citation_precision / citation_coverage (Sonnet judge) + an IDK rate
  for the null bucket

Each numeric cell carries a 95% bootstrap CI, broken out by query_type. The
agentic eval is expensive (Opus per query), so ``--per-type`` defaults small and
the exact sample size is recorded in the scorecard — small n is *why* the CIs
matter.

    python -m eval.run_answer --slice 6 --stage multiquery --per-type 5
    python -m eval.run_answer --slice 6 --stage rerank --per-type 8 --no-ragas
"""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone

from apps.stack import RERANK_TOP_N, DEFAULT_PERSIST_DIR, STAGES, build_embedder, build_retriever, build_source, build_store
from agent.loop import run_agent
from core.models import EvalExample, RetrievedChunk
from eval.citation import JUDGE_MODEL as CITATION_JUDGE, judge_citations
from eval.faithfulness import JUDGE_MODEL as FAITH_JUDGE, faithfulness
from eval.report import RESULTS_DIR
from eval.retrieval import per_query_metrics
from eval.stats import bootstrap_ci
from eval.stratified import QUERY_TYPES, build_stratified_eval

_IDK_MARKERS = ("insufficient", "i don't know", "i do not know", "cannot find",
                "could not find", "no information", "not contain", "unable to find",
                "don't have", "no relevant")


def _looks_like_idk(answer: str) -> bool:
    a = answer.lower()
    return any(m in a for m in _IDK_MARKERS)


def _tokens(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", s.lower())


def _answer_match(gold: str, answer: str) -> float | None:
    """1.0 if the (terse) gold answer appears as a contiguous token run in the
    agent's answer. MultiHopRAG golds are 1-2 words, so this catches correctness
    that Ragas `factual_correctness` can't decompose from a one-word reference."""
    g, a = _tokens(gold), _tokens(answer)
    if not g:
        return None
    return 1.0 if any(a[i:i + len(g)] == g for i in range(len(a) - len(g) + 1)) else 0.0


def _agent_contexts(retrieved: list[RetrievedChunk]) -> list[str]:
    return [rc.chunk.text for rc in retrieved]


def evaluate_one(client, retriever, ex: EvalExample, *, k: int, max_turns: int) -> dict:
    # Direct retrieve → retrieval metrics, comparable to the slice 2-5 harness.
    direct = retriever.retrieve(ex.query, k=max(20, k))
    retrieval = per_query_metrics(direct, ex.gold_doc_ids)  # None for null

    result = run_agent(client, retriever, ex.query, k=k, max_turns=max_turns)
    contexts = _agent_contexts(result.retrieved)

    faith, faith_reason = faithfulness(client, ex.query, result.answer, result.retrieved)
    cites = judge_citations(client, ex.query, result.answer, result.citations)
    abstained = _looks_like_idk(result.answer)
    # answer_match only for answerable queries (null gold is the IDK string).
    answer_match = None if ex.question_type == "null_query" else _answer_match(ex.answer, result.answer)

    return {
        "query": ex.query,
        "question_type": ex.question_type,
        "answer": result.answer,
        "reference": ex.answer,
        "contexts": contexts,
        "n_citations": len(result.citations),
        "retrieval": retrieval,
        "faithfulness": faith,
        "faithfulness_reason": faith_reason,
        "citation_precision": cites.citation_precision,
        "citation_coverage": cites.citation_coverage,
        "answer_match": answer_match,
        "abstained": abstained,
        "turns": result.turns,
    }


def _ci_by_type(records: list[dict], key: str, *, only_answerable=False) -> dict:
    out = {}
    for qt in QUERY_TYPES:
        if only_answerable and qt == "null_query":
            continue
        vals = [r[key] for r in records if r["question_type"] == qt and r.get(key) is not None]
        out[qt] = bootstrap_ci(vals)
    pool = [r[key] for r in records
            if r.get(key) is not None and (not only_answerable or r["question_type"] != "null_query")]
    out["overall"] = bootstrap_ci(pool)
    return out


def _retrieval_ci_by_type(records: list[dict], metric: str) -> dict:
    out = {}
    for qt in QUERY_TYPES:
        vals = [r["retrieval"][metric] for r in records
                if r["question_type"] == qt and r.get("retrieval")]
        out[qt] = bootstrap_ci(vals)
    pool = [r["retrieval"][metric] for r in records if r.get("retrieval")]
    out["overall"] = bootstrap_ci(pool)
    return out


def aggregate_answers(records: list[dict], with_ragas: bool) -> dict:
    agg: dict = {
        "retrieval": {m: _retrieval_ci_by_type(records, m)
                      for m in ("recall@10", "mrr", "ndcg@10")},
        "citation_precision": _ci_by_type(records, "citation_precision"),
        "citation_coverage": _ci_by_type(records, "citation_coverage"),
        "faithfulness": _ci_by_type(records, "faithfulness"),
        "answer_match": _ci_by_type(records, "answer_match", only_answerable=True),
    }
    # IDK rate: fraction abstaining, per type (we *want* this high for null).
    agg["idk_rate"] = {
        qt: bootstrap_ci([1.0 if r["abstained"] else 0.0
                          for r in records if r["question_type"] == qt])
        for qt in QUERY_TYPES
    }
    agg["idk_rate"]["overall"] = bootstrap_ci([1.0 if r["abstained"] else 0.0 for r in records])
    if with_ragas:
        for m in ("context_precision", "context_recall", "faithfulness_ragas",
                  "answer_relevancy", "factual_correctness"):
            agg[m] = _ci_by_type(records, m)
    return agg


def _fmt_ci(cell: dict) -> str:
    if cell is None or cell.get("mean") is None:
        return "—"
    if cell.get("lo") is None:
        return f"{cell['mean']:.2f} (n={cell['n']})"
    return f"{cell['mean']:.2f} [{cell['lo']:.2f},{cell['hi']:.2f}]"


def _family_table(title: str, metric_rows: list[tuple[str, dict]]) -> str:
    cols = ["overall", *QUERY_TYPES]
    head = f"| {title} | " + " | ".join(c.replace('_query', '') for c in cols) + " |"
    sep = "|" + "---|" * (len(cols) + 1)
    lines = [head, sep]
    for label, by_type in metric_rows:
        cells = [_fmt_ci(by_type.get(c)) for c in cols]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def render(payload: dict) -> str:
    agg = payload["metrics"]
    p = [f"# Slice {payload['slice']} — answer-quality scorecard ({payload['stage']})\n"]
    p.append(
        f"_Generated {payload['timestamp']}_ · agent `{payload['agent_model']}` · "
        f"Ragas judge `{payload['ragas_model'] or 'n/a'}` · citation judge "
        f"`{payload['citation_model']}` · faithfulness judge `{payload['faith_model']}`\n"
    )
    attempted = payload.get("attempted", payload["eval_size"])
    scope = (f"**{payload['eval_size']} of {attempted} queries** "
             f"({payload['per_type']}/type target)" if payload['eval_size'] != attempted
             else f"**{payload['eval_size']} queries** ({payload['per_type']}/type)")
    p.append(
        f"Eval: {scope} over the {payload['corpus_chunks']}-chunk corpus. Cells show "
        f"mean with a 95% bootstrap CI; small n is why the intervals are wide — read "
        f"overlaps, not point estimates.\n"
    )
    if payload.get("aborted"):
        p.append(
            f"> ⚠️ **Run truncated** after {payload['eval_size']}/{attempted} queries by an "
            f"API error (`{payload['aborted']}`). Numbers below are over the completed "
            f"queries only; re-run `python -m eval.run_answer --slice {payload['slice']} "
            f"--stage {payload['stage']} --per-type {payload['per_type']}` to finish.\n"
        )

    p.append("## Retrieval (direct retrieve, answerable only)\n")
    p.append(_family_table("metric", [(m, agg["retrieval"][m])
                                      for m in ("recall@10", "mrr", "ndcg@10")]))

    if "context_precision" in agg:
        p.append("\n## Ragas answer quality\n")
        rows = [("context_precision", agg["context_precision"]),
                ("context_recall", agg["context_recall"]),
                ("faithfulness", agg["faithfulness_ragas"]),
                ("answer_relevancy", agg["answer_relevancy"]),
                ("factual_correctness", agg["factual_correctness"])]
        p.append(_family_table("metric", rows))

    p.append("\n## Citations, correctness & honesty (custom judges)\n")
    p.append(_family_table("metric", [
        ("citation_precision", agg["citation_precision"]),
        ("citation_coverage", agg["citation_coverage"]),
        ("faithfulness (Haiku)", agg["faithfulness"]),
        ("answer_match", agg["answer_match"]),
        ("idk_rate", agg["idk_rate"]),
    ]))
    p.append(
        "\n> `idk_rate` is the fraction of answers that abstain — should be **high** for "
        "`null_query` (the honest-IDK story) and low elsewhere. `answer_match` (terse "
        "gold appears in the answer) stands in for Ragas `factual_correctness`, which is "
        "undefined here because the gold answers are 1-2 words and can't be decomposed "
        "into claims. citation_precision/coverage are `None` only when an answer emits no "
        "citations at all."
    )
    return "\n".join(p) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Answer-quality eval (slice 6)")
    parser.add_argument("--slice", type=int, default=6)
    parser.add_argument("--stage", choices=STAGES, default="multiquery")
    parser.add_argument("--persist-dir", default=DEFAULT_PERSIST_DIR)
    parser.add_argument("--per-type", type=int, default=5)
    parser.add_argument("--k", type=int, default=RERANK_TOP_N)
    parser.add_argument("--max-turns", type=int, default=6)
    parser.add_argument("--no-ragas", action="store_true")
    parser.add_argument("--records-out", default=None, help="dump raw per-query records")
    args = parser.parse_args(argv)

    import anthropic

    client = anthropic.Anthropic()
    source = build_source()
    embedder, ename = build_embedder()
    store = build_store(embedder.dim, stage=args.stage, persist_dir=args.persist_dir)
    if store.count() == 0:
        raise SystemExit(f"empty index — run `python -m apps.index --stage {args.stage}`")
    retriever = build_retriever(args.stage, embedder, store, client=client)

    examples = build_stratified_eval(source.get_eval_set(), per_type=args.per_type)
    print(f"answer-eval: {len(examples)} queries | stage={args.stage} | "
          f"ragas={'off' if args.no_ragas else 'on'}")

    # Checkpoint completed records to disk as we go, so an API failure partway
    # through (rate limit, credit exhaustion) never loses finished work — the run
    # that hit "credit balance too low" at 16/24 is exactly why this exists.
    from pathlib import Path
    ckpt = Path(args.records_out) if args.records_out else (RESULTS_DIR / f"slice{args.slice}.records.json")
    ckpt.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.perf_counter()
    records: list[dict] = []
    aborted = None
    for i, ex in enumerate(examples, 1):
        try:
            rec = evaluate_one(client, retriever, ex, k=args.k, max_turns=args.max_turns)
        except Exception as e:  # noqa: BLE001 - keep partial progress on any API error
            msg = f"{type(e).__name__}: {str(e)[:140]}"
            print(f"  [{i}/{len(examples)}] FAILED {ex.question_type}: {msg}")
            # Auth / credit / quota errors fail every subsequent call — stop and
            # score what we have rather than spinning through the rest.
            if any(s in str(e).lower() for s in
                   ("credit balance", "authentication", "quota", "permission")):
                aborted = msg
                break
            continue
        records.append(rec)
        ckpt.write_text(json.dumps(records, indent=2))  # checkpoint
        print(f"  [{i}/{len(examples)}] {ex.question_type:17s} "
              f"faith={rec['faithfulness']:.2f} cites={rec['n_citations']} "
              f"{'IDK' if rec['abstained'] else '   '} {ex.query[:50]}")

    if not records:
        raise SystemExit(f"no examples completed (aborted: {aborted}); nothing to score")
    if aborted:
        print(f"!! run truncated by API error after {len(records)}/{len(examples)}: {aborted}")
        print(f"   scoring the {len(records)} completed records; re-run to finish.")

    with_ragas = not args.no_ragas
    if with_ragas:
        try:
            from eval.ragas_runner import RAGAS_JUDGE_MODEL, score_samples

            print("running Ragas suite...")
            samples = [{"question": r["query"], "contexts": r["contexts"],
                        "answer": r["answer"], "reference": r["reference"]} for r in records]
            ragas_scores = score_samples(samples)
            for r, rs in zip(records, ragas_scores):
                r["context_precision"] = rs.get("context_precision")
                r["context_recall"] = rs.get("context_recall")
                r["faithfulness_ragas"] = rs.get("faithfulness")
                r["answer_relevancy"] = rs.get("answer_relevancy")
                r["factual_correctness"] = rs.get("factual_correctness")
            ragas_model = RAGAS_JUDGE_MODEL
        except Exception as e:  # noqa: BLE001 - don't lose the agent-side scorecard
            print(f"!! Ragas failed ({type(e).__name__}: {str(e)[:100]}); "
                  f"writing scorecard without Ragas.")
            with_ragas = False
            ragas_model = None
    else:
        ragas_model = None

    agg = aggregate_answers(records, with_ragas)
    dt = time.perf_counter() - t0

    payload = {
        "slice": args.slice,
        "stage": args.stage,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "agent_model": "claude-opus-4-8",
        "ragas_model": ragas_model,
        "citation_model": CITATION_JUDGE,
        "faith_model": FAITH_JUDGE,
        "embedder": ename,
        "corpus_chunks": store.count(),
        "eval_size": len(records),
        "attempted": len(examples),
        "per_type": args.per_type,
        "aborted": aborted,
        "elapsed_s": round(dt, 1),
        "metrics": agg,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"slice{args.slice}.json").write_text(json.dumps(payload, indent=2))
    (RESULTS_DIR / f"slice{args.slice}.md").write_text(render(payload))

    print(f"done in {dt:.0f}s | scored {len(records)}/{len(examples)} "
          f"| wrote eval/results/slice{args.slice}.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
