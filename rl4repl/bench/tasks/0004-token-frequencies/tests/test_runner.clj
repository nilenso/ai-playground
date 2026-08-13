(require '[clojure.test :refer [deftest is run-tests]])

(load-file "/workspace/solution.clj")

(deftest token-frequencies-test
  (let [f (resolve 'rl4repl.solution/token-frequencies)]
    (is (= {} (f [])))
    (is (= {:a 1} (f [:a])))
    (is (= {:a 3 :b 2} (f [:a :b :a :a :b])))
    (is (= {nil 2 false 1 true 1} (f [nil false nil true])))
    (is (= {[1] 2 [2] 1} (f [[1] [2] [1]])))))

(let [{:keys [fail error]} (run-tests)]
  (System/exit (if (zero? (+ fail error)) 0 1)))
