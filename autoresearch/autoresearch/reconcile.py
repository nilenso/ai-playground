"""Check a shared baseline was scored by the same rules this branch uses.

One baseline is measured once and reused by every arm, which saves an hour and
about $15. The catch is that the file stores a *computed* number, `correctness`,
and two branches can compute it differently from identical raw attempts.

Here they differ in exactly one way. This branch files a curl timeout as
`network_failure` and keeps it out of the error list; the branch that measures
the baseline files it as `traceback`, which counts. On a clean link the two
agree exactly. Through a bad minute they do not.

That number never enters the objective -- it is used only to build the sentence
"Correctness X vs Y before the change (better/worse/unchanged)". But that
sentence is not inert: it is the prose GEPA reads and reasons from, and the
whole premise of this harness is that the write-up matters more than the
number. So a figure produced under rules this branch would not have used does
influence the search, just through the text rather than the arithmetic.

Re-measuring to fix a feedback string would cost an hour and $15. Recomputing
it from the attempts the run already kept costs nothing.

    python -m autoresearch.reconcile BASELINE.json RUN/attempts
    python -m autoresearch.reconcile BASELINE.json RUN/attempts --apply

Reads by default. `--apply` rewrites only `correctness`, only for the questions
that diverge, and records what it changed inside the file.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import questions as qmod, score
from .noise_floor import load_attempts


def recompute(attempts_dir: Path, question) -> float | None:
    """This branch's correctness for one question, from the raw attempts.

    Filtered the way the baseline filters, not the way the evaluator does. The
    question here is narrow -- "what would this number have been under our
    rules" -- so everything else must be held identical, including which
    attempts count.
    """
    attempts = load_attempts(attempts_dir, question)
    usable = [a for a in attempts if a.ok]
    return score.correctness(usable) if usable else None


def check(baseline_path: Path, attempts_dir: Path,
          bank=None) -> dict[str, object]:
    bank = bank if bank is not None else qmod.load()
    raw = json.loads(baseline_path.read_text(encoding="utf-8"))
    stored = raw.get("questions", {})

    agree: list[str] = []
    diverge: dict[str, dict[str, float]] = {}
    unchecked: dict[str, str] = {}

    for q in bank:
        if q.id not in stored:
            continue  # the baseline skipped it; nothing to reconcile
        mine = recompute(attempts_dir, q)
        if mine is None:
            # No attempts kept, so we cannot say. Named rather than assumed
            # equal: silently treating unknown as agreement is how this class
            # of defect survives.
            unchecked[q.id] = "no usable attempts retained"
            continue
        theirs = stored[q.id].get("correctness")
        if theirs is not None and abs(theirs - mine) < 1e-9:
            agree.append(q.id)
        else:
            diverge[q.id] = {"stored": theirs, "ours": mine}

    return {"agree": agree, "diverge": diverge, "unchecked": unchecked,
            "baseline": str(baseline_path)}


def apply(baseline_path: Path, result: dict[str, object]) -> int:
    """Overwrite only the disputed `correctness` values, and say so in the file.

    Tokens and duration stay exactly as measured -- they are raw readings and
    carry no scoring rules at all. Only the computed number changes.

    The audit record goes at the top level, where an older reader will ignore
    it. Adding it per question would break `Reading(**v)`, which is the same
    trap we already agreed not to walk into with the release field.
    """
    diverge = result["diverge"]
    if not diverge:
        return 0
    raw = json.loads(baseline_path.read_text(encoding="utf-8"))
    for qid, pair in diverge.items():
        raw["questions"][qid]["correctness"] = pair["ours"]
    raw.setdefault("correctness_overrides", {}).update({
        qid: {"was": pair["stored"], "now": pair["ours"],
              "why": "recomputed under this branch's taxonomy; the measuring "
                     "branch counts a network timeout as a tool error and this "
                     "one does not"}
        for qid, pair in diverge.items()
    })
    baseline_path.write_text(json.dumps(raw, indent=2))
    return len(diverge)


def render(result: dict[str, object]) -> str:
    agree, diverge = result["agree"], result["diverge"]
    unchecked = result["unchecked"]
    out = [f"BASELINE RECONCILIATION — {result['baseline']}",
           f"  {len(agree)} question(s) agree with this branch's rules"]
    if diverge:
        out.append(f"  {len(diverge)} DIVERGE:")
        for qid, pair in sorted(diverge.items()):
            stored = "none" if pair["stored"] is None else f"{pair['stored']:.3f}"
            out.append(f"    {qid:<34} stored {stored}  ours {pair['ours']:.3f}")
        out += ["",
                "  Re-run with --apply to take this branch's numbers for those",
                "  questions. Tokens and duration are raw measurements and are",
                "  left untouched; only the computed figure changes."]
    else:
        out.append("  none diverge — the shared baseline is usable as measured.")
    if unchecked:
        out += [f"  {len(unchecked)} could not be checked:"]
        out += [f"    {qid}: {why}" for qid, why in sorted(unchecked.items())]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("baseline", type=Path, help="the baseline JSON to check")
    ap.add_argument("attempts", type=Path, help="the run's attempts/ directory")
    ap.add_argument("--apply", action="store_true",
                    help="rewrite the diverging correctness values in place")
    args = ap.parse_args()

    if not args.baseline.exists():
        raise SystemExit(f"no baseline at {args.baseline}")
    if not args.attempts.is_dir():
        raise SystemExit(f"not a directory: {args.attempts}")

    result = check(args.baseline, args.attempts)
    print(render(result))
    if args.apply:
        changed = apply(args.baseline, result)
        print(f"\nrewrote {changed} correctness value(s); "
              f"recorded under 'correctness_overrides'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
