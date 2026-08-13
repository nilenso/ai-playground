(require '[clojure.test :refer [deftest is run-tests]])

(load-file "/workspace/solution.clj")

(deftest rotate-left-test
  (let [f (resolve 'rl4repl.solution/rotate-left)]
    (is (= [] (f [] 3)))
    (is (= [1 2 3] (f [1 2 3] 0)))
    (is (= [3 4 1 2] (f [1 2 3 4] 2)))
    (is (= [2 3 1] (f [1 2 3] 4)))
    (is (= [3 1 2] (f [1 2 3] -1)))
    (is (= [2 3 1] (f [1 2 3] -5)))
    (is (= [:a] (f [:a] -100)))))

(let [{:keys [fail error]} (run-tests)]
  (System/exit (if (zero? (+ fail error)) 0 1)))
