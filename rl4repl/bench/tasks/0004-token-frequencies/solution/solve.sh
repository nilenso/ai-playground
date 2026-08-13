#!/usr/bin/env bash
set -Eeuo pipefail

python3 - <<'PY'
from pathlib import Path
path = Path("/workspace/solution.clj")
text = path.read_text()
old = '(update counts token inc)'
new = '(update counts token (fnil inc 0))'
if text.count(old) != 1:
    raise SystemExit(f"expected exactly one oracle target, found {text.count(old)}")
path.write_text(text.replace(old, new))
PY

clojure -M -e '(load-file "/workspace/solution.clj") (assert (= {:a 2 :b 1} (rl4repl.solution/token-frequencies [:a :b :a])))'
