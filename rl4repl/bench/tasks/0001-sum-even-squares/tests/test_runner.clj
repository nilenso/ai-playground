(require '[clojure.test :refer [deftest is run-tests]])

(load-file "/workspace/solution.clj")

(deftest sum-even-squares-test
  (let [f (resolve 'rl4repl.solution/sum-even-squares)]
    (is (= 0 (f [])))
    (is (= 0 (f [1 3 5])))
    (is (= 20 (f [1 2 3 4])))
    (is (= 104 (f [-2 5 10])))
    (is (= 8 (f [-2 -2])))))

(let [{:keys [fail error]} (run-tests)]
  (System/exit (if (zero? (+ fail error)) 0 1)))
