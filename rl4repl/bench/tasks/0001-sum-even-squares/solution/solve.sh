#!/usr/bin/env bash
set -Eeuo pipefail

grep -q '(filter odd?)' /workspace/solution.clj
sed -i 's/(filter odd?)/(filter even?)/' /workspace/solution.clj

clojure -M -e '(load-file "/workspace/solution.clj") (assert (= 20 (rl4repl.solution/sum-even-squares [1 2 3 4])))'
