(ns rl4repl.solution)

(defn prefix-sums
  "Returns the nonempty prefix sums of xs as a vector."
  [xs]
  (vec (reductions + 0 xs)))
