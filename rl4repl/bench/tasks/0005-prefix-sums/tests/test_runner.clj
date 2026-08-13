(require '[clojure.test :refer [deftest is run-tests]])

(load-file "/workspace/solution.clj")

(deftest prefix-sums-test
  (let [f (resolve 'rl4repl.solution/prefix-sums)]
    (is (= [] (f [])))
    (is (= [5] (f [5])))
    (is (= [1 3 6 10] (f [1 2 3 4])))
    (is (= [-2 1 0] (f [-2 3 -1])))
    (is (= [0 0 4] (f [0 0 4])))))

(let [{:keys [fail error]} (run-tests)]
  (System/exit (if (zero? (+ fail error)) 0 1)))
