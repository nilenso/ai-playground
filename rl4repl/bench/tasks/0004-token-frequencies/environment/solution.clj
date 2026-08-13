(ns rl4repl.solution)

(defn token-frequencies
  "Returns a map from each token to its number of occurrences."
  [tokens]
  (reduce (fn [counts token]
            (update counts token inc))
          {}
          tokens))
