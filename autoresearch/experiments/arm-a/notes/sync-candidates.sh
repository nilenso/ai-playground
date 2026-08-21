#!/bin/zsh
# Keep every candidate branch honest against arm-a-base.
#
# Why this exists: committing anything to the base (a skill fix, an accepted
# winner) leaves candidate branches behind it. `git diff arm-a-base <cand>`
# then shows the base's new commits as REVERTS inside the candidate's diff.
# A 116-line revert of the verification skill once appeared inside all three
# candidates this way. A reward-hack reviewer would have seen each candidate
# tampering with its own verifier and rejected all three, correctly.
#
# Run after ANY commit to arm-a-base, and before any measurement.
set -e
BASE=arm-a-base
START=$(git rev-parse --abbrev-ref HEAD)
FAIL=0

for b in $(git for-each-ref --format='%(refname:short)' refs/heads/cand); do
  git checkout -q "$b"
  if ! git rebase -q "$BASE" >/dev/null 2>&1; then
    echo "  $b: REBASE CONFLICT — resolve by hand"; git rebase --abort 2>/dev/null; FAIL=1; continue
  fi

  # 1. empty candidate (F12): a change that was stashed, reverted or never applied
  if git diff --quiet "$BASE" "$b"; then
    echo "  $b: EMPTY — do not measure"; FAIL=1; continue
  fi

  # 2. stray files: a candidate must only touch the tool under test
  stray=$(git diff --name-only "$BASE" "$b" | grep -vE '^botmap/' || true)
  if [ -n "$stray" ]; then
    echo "  $b: TOUCHES NON-TOOL FILES:"; echo "$stray" | sed 's/^/       /'; FAIL=1; continue
  fi

  # 3. never the exam
  if git diff --name-only "$BASE" "$b" | grep -q '^evals/'; then
    echo "  $b: TOUCHES evals/ — that is the exam"; FAIL=1; continue
  fi

  echo "  $b: OK ($(git diff --shortstat "$BASE" "$b" | sed 's/^ *//'))"
done

git checkout -q "$START"
[ "$FAIL" -eq 0 ] && echo "ALL CANDIDATES CLEAN" || { echo "PROBLEMS FOUND — do not measure"; exit 1; }
