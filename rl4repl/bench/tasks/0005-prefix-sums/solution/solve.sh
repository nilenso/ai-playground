#!/usr/bin/env bash
set -Eeuo pipefail

python3 - <<'PY'
from pathlib import Path
path = Path("/workspace/solution.clj")
text = path.read_text()
old = '(vec (reductions + 0 xs))'
new = '(vec (rest (reductions + 0 xs)))'
if text.count(old) != 1:
    raise SystemExit(f"expected exactly one oracle target, found {text.count(old)}")
path.write_text(text.replace(old, new))
PY

clojure -M -e '(load-file "/workspace/solution.clj") (assert (= [1 3 6] (rl4repl.solution/prefix-sums [1 2 3])))'
