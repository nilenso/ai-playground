"""Turns each arm's search into a tree you can read.

The two arms search in genuinely different shapes, and the visualiser keeps
them distinct rather than forcing one metaphor onto both:

  GEPA arms   one seed, then an iteration per proposal. Each iteration picks a
              parent, scores it on a small subsample, scores the child on the
              same subsample, and keeps the child only if it did better. Most
              children are discarded, so the tree is wide and shallow.

  Arm A       one base commit, then a branch per competing candidate, judged
              against a shared mini-batch. No lineage beyond one generation,
              because the loop re-proposes from evidence rather than mutating
              a parent.

A score of exactly 0.000 is called out rather than drawn as a very short bar.
Zero usually means the attempt never completed — a broken candidate, but just
as often quota exhaustion or a network failure wearing a candidate's clothes.
Those are the failures this project keeps mistaking for signal.
"""

from __future__ import annotations

import json
from pathlib import Path


def question_names(root: Path) -> list[str]:
    """Subsample ids index into the question bank, so we can name them."""
    qs = root / "experiments" / "questions.yaml"
    if not qs.exists():
        return []
    names = []
    for line in qs.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("- id:"):
            names.append(s.split(":", 1)[1].strip().strip('"').strip("'"))
    return names


def gepa_runs(root: Path) -> list[dict]:
    """Every GEPA run under a checkout, newest first, with its lineage."""
    runs_dir = root / "experiments" / "runs"
    if not runs_dir.exists():
        return []
    names = question_names(root)
    out = []
    for run_dir in sorted(runs_dir.iterdir(),
                          key=lambda p: p.stat().st_mtime, reverse=True):
        log = run_dir / "gepa" / "run_log.json"
        if not log.is_file():
            continue
        try:
            iters = json.loads(log.read_text())
        except Exception:
            continue

        summary = {}
        sfile = run_dir / "summary.json"
        if sfile.is_file():
            try:
                summary = json.loads(sfile.read_text())
            except Exception:
                pass

        nodes, accepted = [], 0
        for it in iters:
            task = (it.get("tasks") or [{}])[0]
            old = task.get("subsample_scores") or it.get("subsample_scores") or []
            new = task.get("new_subsample_scores") or []
            ids = it.get("subsample_ids") or []
            mo = sum(old) / len(old) if old else 0.0
            mn = sum(new) / len(new) if new else 0.0
            keep = bool(new) and mn > mo
            if keep:
                accepted += 1
            nodes.append({
                "i": it.get("i"),
                "parent": it.get("selected_program_candidate"),
                "ids": ids,
                "questions": [names[q] if q < len(names) else f"#{q}" for q in ids],
                "old": old, "new": new,
                "mean_old": mo, "mean_new": mn,
                "delta": mn - mo,
                "kept": keep,
                "child": accepted if keep else None,
                # A zero mean with non-empty scores means every attempt scored
                # nothing, which is the signature of a non-candidate failure.
                "suspect_zero": bool(new) and mn == 0.0,
            })

        out.append({
            "name": run_dir.name,
            "invalid": (run_dir / "INVALID.md").is_file(),
            "nodes": nodes,
            "n_candidates": accepted + 1,
            "summary": summary,
            "path": run_dir,
        })
    return out


def branch_tree(repo: Path, base: str, git) -> list[dict]:
    """Arm A's shape: one node per competing candidate branch."""
    if not repo.exists():
        return []
    if not git(repo, "cat-file", "-t", base).strip():
        return []
    names = [b.strip().lstrip("* ").strip()
             for b in git(repo, "branch", "--list", "cand/*").splitlines()
             if b.strip()]
    out = []
    for b in names:
        stat = git(repo, "diff", "--numstat", f"{base}..{b}")
        files, adds, dels = [], 0, 0
        for line in stat.splitlines():
            parts = line.split("\t")
            if len(parts) == 3:
                files.append(parts[2])
                adds += int(parts[0]) if parts[0].isdigit() else 0
                dels += int(parts[1]) if parts[1].isdigit() else 0
        subject = git(repo, "log", "--format=%s", "-1", b).strip()
        lever = ("prompt" if any(f.endswith("skill.md") for f in files)
                 else "tool")
        out.append({"branch": b, "subject": subject, "files": files,
                    "adds": adds, "dels": dels, "lever": lever,
                    "current": b in git(repo, "branch", "--show-current")})
    return out
