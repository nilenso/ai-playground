#!/bin/zsh
# Round 1 screening. Run ONLY after an explicit RELEASED message.
# 15 runs total: 3 candidates x 5 mini-batch questions x 1 repeat.
set -e
cd /Users/priyangapkini/workspace/ar-a/botmap

# Refuse to run if the global skill is back -- C2 is a prompt-lever candidate
# and would be silently shadowed (F7), scoring as "no effect" while untested.
if [ -d ~/.claude/skills/botmap ]; then
  echo "ABORT: ~/.claude/skills/botmap exists again. C2 would be shadowed (F7)."
  echo "       Move it aside before measuring, or C2's result is void, not negative."
  exit 1
fi

./notes/sync-candidates.sh   # F12/rebase guard: no empty or polluted candidates

for b in cand/count-zero-hint cand/skill-bus-station cand/count-flag-parity; do
  slug=${b#cand/}
  echo "======== $b ========"
  git checkout -q "$b"
  uv run botmap --help >/dev/null || { echo "  $b does not start -- skipping"; continue; }
  uv run python /tmp/ar-a/run_evals.py "evals/runs/r1-$slug" \
      "coffee-brooklyn-count,where-boston,tall-buildings-manhattan,busstops-coffee-williamsburg,hardware-near-bikepaths-alameda" \
      1 sonnet
  uv run python -m evals.score --runs-dir "evals/runs/r1-$slug" >/dev/null 2>&1

  # F10 guard: a quota death scores identically to a broken candidate.
  q=$(grep -l "hit your session limit" evals/runs/r1-$slug/*__r*/transcript.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [ "$q" -gt 0 ]; then
    echo "  QUOTA DEATH in $q run(s) -- results for $b are VOID, not negative. STOPPING."
    git checkout -q arm-a-base
    exit 1
  fi
  echo "  captured $(ls evals/runs/r1-$slug | wc -l | tr -d ' ')/5, no quota deaths"
done
git checkout -q arm-a-base
echo "ROUND 1 SCREENING COMPLETE"
