(ns rl4repl.solution)

(defn sum-even-squares
  "Returns the sum of the squares of the even integers in xs."
  [xs]
  (->> xs
       (filter odd?)
       (map #(* % %))
       (reduce + 0)))
