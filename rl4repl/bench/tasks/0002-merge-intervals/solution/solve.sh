#!/usr/bin/env bash
set -Eeuo pipefail

grep -q '(if (< start last-end)' /workspace/solution.clj
sed -i 's/(if (< start last-end)/(if (<= start last-end)/' /workspace/solution.clj

clojure -M -e '(load-file "/workspace/solution.clj") (assert (= [[1 5]] (rl4repl.solution/merge-intervals [[1 3] [3 5]])))'
