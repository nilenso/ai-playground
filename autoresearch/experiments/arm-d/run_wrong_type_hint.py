#!/usr/bin/env python3
"""Run Arm D wrong-type hint paired subset.

This is intentionally small: beach-accessibility-malta and
residential-share-cambridge, two repeats each, against the Arm D botmap candidate.
"""

from __future__ import annotations

import json
from pathlib import Path
from time import monotonic
from datetime import datetime, timezone

from autoresearch import config, runner
from autoresearch.agenteval.analyze import write_summary
from autoresearch.agenteval.enrich import enrich_run
from autoresearch.questions import load

CANDIDATE_SHA = "9ba1187"
BOTMAP_REPO = Path("/Users/priyangapkini/workspace/ar-d/botmap-wrong-type-hint")
RUN_DIR = config.ROOT / "experiments" / "runs" / f"after-wrong-type-hint-tool-{CANDIDATE_SHA}"
QUESTION_IDS = {"beach-accessibility-malta", "residential-share-cambridge"}
REPEATS = 2


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def append_progress(event: dict) -> None:
    progress = RUN_DIR / "progress.jsonl"
    with progress.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")


def main() -> None:
    config.load_env()
    selected = [q for q in load() if q.id in QUESTION_IDS]
    selected.sort(key=lambda q: q.id)
    total = len(selected) * REPEATS
    attempts_done = 0
    completed = 0
    ok = 0
    botmap_calls = 0
    cost_usd = 0.0
    started = monotonic()

    RUN_DIR.mkdir(parents=True, exist_ok=True)
    write_json(RUN_DIR / "metadata.json", {
        "property": "if same filter has rows under another feature type, name the type",
        "lever": "tool",
        "candidate_sha": CANDIDATE_SHA,
        "botmap_repo": str(BOTMAP_REPO),
        "questions": [q.id for q in selected],
        "repeats": REPEATS,
        "before_source": "experiments/runs/agenteval-measurement-3009509/agenteval-summary-with-retries.json",
        "started": datetime.now(timezone.utc).isoformat(),
    })

    def current_summary(finished: bool = False) -> dict:
        return {
            "attempts_done": attempts_done,
            "total": total,
            "completed": completed,
            "ok": ok,
            "botmap_calls": botmap_calls,
            "cost_usd": cost_usd,
            "minutes": round((monotonic() - started) / 60, 1),
            "finished": datetime.now(timezone.utc).isoformat() if finished else None,
        }

    write_json(RUN_DIR / "summary.json", current_summary())

    for question in selected:
        for repeat in range(1, REPEATS + 1):
            attempt_name = f"{question.id}__r{repeat}"
            print(f"[arm-d wrong-type] {attempts_done + 1}/{total} {attempt_name}", flush=True)
            attempt = runner.ask(question, BOTMAP_REPO, repeat, keep_dir=RUN_DIR / "attempts")
            attempts_done += 1
            completed += int(attempt.completed)
            ok += int(attempt.ok)
            botmap_calls += len(attempt.calls)
            cost_usd += attempt.transcript.usage.cost_usd
            append_progress({
                "attempt": attempt_name,
                "completed": attempt.completed,
                "ok": attempt.ok,
                "botmap_calls": len(attempt.calls),
                "cost_usd": attempt.transcript.usage.cost_usd,
                "time": datetime.now(timezone.utc).isoformat(),
            })
            write_json(RUN_DIR / "summary.json", current_summary())

    print("[arm-d wrong-type] enriching record-v2 probes", flush=True)
    enrichment = enrich_run(RUN_DIR, BOTMAP_REPO)
    write_json(RUN_DIR / "enrichment-summary.json", enrichment)
    write_summary(RUN_DIR)
    write_json(RUN_DIR / "summary.json", current_summary(finished=True))
    print(f"[arm-d wrong-type] done: {RUN_DIR}", flush=True)


if __name__ == "__main__":
    main()
