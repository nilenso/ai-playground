#!/usr/bin/env bash
set -Eeuo pipefail

mkdir -p /logs/verifier

set +e
clojure -M /tests/test_runner.clj
status=$?
set -e

if [[ $status -eq 0 ]]; then
  printf '1\n' > /logs/verifier/reward.txt
else
  printf '0\n' > /logs/verifier/reward.txt
fi

# Harbor reads reward.txt, so verifier execution itself should succeed.
exit 0
