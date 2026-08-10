(require '[clojure.test :refer [deftest is run-tests]])

(load-file "/workspace/solution.clj")

(deftest merge-intervals-test
  (let [f (resolve 'rl4repl.solution/merge-intervals)]
    (is (= [] (f [])))
    (is (= [[1 2]] (f [[1 2]])))
    (is (= [[1 5]] (f [[1 3] [3 5]])))
    (is (= [[1 7] [10 12]] (f [[10 12] [2 4] [1 7]])))
    (is (= [[-5 -1] [0 0]] (f [[-3 -1] [-5 -3] [0 0]])))
    (is (= [[1 10]] (f [[1 10] [2 3] [4 8]])))
    (is (= [[1 2] [3 4]] (f [[3 4] [1 2]])))))

(let [{:keys [fail error]} (run-tests)]
  (System/exit (if (zero? (+ fail error)) 0 1)))
