(ns rl4repl.solution)

(defn merge-intervals
  "Merges closed intervals that overlap or touch at an endpoint."
  [intervals]
  (reduce
   (fn [merged [start end]]
     (if-let [[last-start last-end] (peek merged)]
       (if (< start last-end)
         (conj (pop merged) [last-start (max last-end end)])
         (conj merged [start end]))
       [[start end]]))
   []
   (sort-by first intervals)))
