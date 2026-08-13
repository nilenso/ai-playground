(ns rl4repl.solution)

(defn rotate-left
  "Rotates vector xs left by n positions. Negative n rotates right."
  [xs n]
  (if (empty? xs)
    []
    (let [k (rem n (count xs))]
      (vec (concat (drop k xs) (take k xs))))))
