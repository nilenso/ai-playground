"""Calibrate the custom citation judge against human grades (PLAN.md learning #8).

An LLM judge is only worth trusting if it tracks a human. This reads a small
hand-graded set (``eval/calibration.json``), re-runs the *same* Sonnet citation
judge the scorecard uses on those exact items, and reports how far the judge lands
from the human grade — mean absolute error and Pearson correlation for
citation_precision and citation_coverage. Wide disagreement here means the slice-6
citation numbers should be read with suspicion.

    python -m eval.calibrate            # judge vs human (needs ANTHROPIC_API_KEY)
    python -m eval.calibrate --offline  # just show the committed set + human grades

The committed set is 8 items grounded in **real corpus passages** (the cited text
is verbatim chunk text from the index), authored to exercise the judge across the
cases that matter: fully-supported, wrong/decorative citation, missing citation
(partial coverage), partially-supported multi-citation, correct abstention, and a
confident uncited assertion. ``eval.build_calibration`` can instead capture live
agent outputs to grade, once API credits are available.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from core.models import Citation

CALIBRATION_PATH = Path(__file__).parent / "calibration.json"


def _pearson(xs: list, ys: list) -> float | None:
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(pairs)
    if n < 2:
        return None
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x, _ in pairs) ** 0.5
    vy = sum((y - my) ** 2 for _, y in pairs) ** 0.5
    return cov / (vx * vy) if vx and vy else None


def _mae(judge: list, human: list) -> float | None:
    pairs = [(j, h) for j, h in zip(judge, human) if j is not None and h is not None]
    return sum(abs(j - h) for j, h in pairs) / len(pairs) if pairs else None


def _fmt(v) -> str:
    return "—" if v is None else f"{v:.2f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Calibrate the citation judge vs human grades")
    parser.add_argument("--offline", action="store_true",
                        help="show the committed set + human grades without calling the judge")
    args = parser.parse_args(argv)

    items = json.loads(CALIBRATION_PATH.read_text())
    print(f"calibration set: {len(items)} human-graded items"
          f"{' (offline — judge not run)' if args.offline else ''}\n")

    rows = [{"query": it["query"][:46],
             "h_prec": it["human"]["citation_precision"],
             "h_cov": it["human"]["citation_coverage"],
             "j_prec": None, "j_cov": None} for it in items]

    if not args.offline:
        import anthropic

        from eval.citation import judge_citations
        client = anthropic.Anthropic()
        for it, row in zip(items, rows):
            citations = [
                Citation(
                    cited_text=c["cited_text"],
                    chunk_id=c.get("chunk_id"),
                    doc_id=(c.get("chunk_id") or "").split("::")[0] or None,
                    title=c.get("title"),
                )
                for c in it.get("citations", [])
            ]
            cj = judge_citations(client, it["query"], it["answer"], citations)
            row["j_prec"] = cj.citation_precision
            row["j_cov"] = cj.citation_coverage

    hdr = f"{'query':48s} {'h_prec':>7} {'j_prec':>7} {'h_cov':>7} {'j_cov':>7}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(f"{r['query']:48s} {_fmt(r['h_prec']):>7} {_fmt(r['j_prec']):>7} "
              f"{_fmt(r['h_cov']):>7} {_fmt(r['j_cov']):>7}")

    if args.offline:
        graded_p = [r["h_prec"] for r in rows if r["h_prec"] is not None]
        graded_c = [r["h_cov"] for r in rows if r["h_cov"] is not None]
        print(f"\nhuman grades: citation_precision on {len(graded_p)} items "
              f"(mean {sum(graded_p)/len(graded_p):.2f}), citation_coverage on "
              f"{len(graded_c)} items (mean {sum(graded_c)/len(graded_c):.2f}).")
        print("run without --offline (needs API credits) to report judge-vs-human "
              "MAE + Pearson r.")
        return 0

    print()
    for label, hk, jk in [("citation_precision", "h_prec", "j_prec"),
                          ("citation_coverage", "h_cov", "j_cov")]:
        h = [r[hk] for r in rows]
        j = [r[jk] for r in rows]
        mae = _mae(j, h)
        rr = _pearson(j, h)
        print(f"{label:20s} MAE={_fmt(mae) if mae is not None else 'n/a':>5}  "
              f"Pearson r={f'{rr:.3f}' if rr is not None else 'n/a'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
