(ns atomist.goals-t
  (:require-macros [cljs.core.async.macros :refer [go]])
  (:require [clojure.data]
            [atomist.json :as json]
            [atomist.cljs-log :as log]
            [atomist.deps :as deps]
            [atomist.promise :refer [from-promise]]
            [cljs.pprint :refer [pprint]]
            [cljs.core.async :refer [chan <! >!]]
            [cljs.test :refer-macros [deftest testing is run-tests async] :refer [report testing-vars-str empty-env get-current-env]]
            [goog.string :as gstring]
            [goog.string.format]
            [atomist.goals :refer [get-options with-project-goals with-new-goal check-library-goals broadcast message]]))

(defn success-promise [m]
  (js/Promise. (fn [resolve] (resolve (clj->js m)))))

(defn failure-promise [e]
  (js/Promise. (fn [resolve error] (error (clj->js e)))))

(deftest empty-broadcast-tests
  (let [callback (atom 0)
        data {:Repo []}]
    (async done
      (go
       (done
        (is (= []
               (<! (broadcast
                    (fn [fp-name]
                      (is (= "npm-project-deps" fp-name))
                      (js/Promise.
                       (fn [resolve reject]
                         (resolve (clj->js data)))))
                    {:name "npm-test" :version "v2" :fp "npm-project-deps"}
                    (fn [owner name channel]
                      (swap! callback inc)
                      (success-promise {:done (str owner name channel)}))))))
        (is (= 0 @callback) "broadcast method should broadcast to one repo"))))))

(deftest broadcast-tests
  (testing "two repos but only one that requires a change"
    (let [callback (atom 0)
          data {:Repo [{:branches [{:commit {:fingerprints [{:name "npm-project-deps"
                                                             :data (json/json-str [["npm-test" "v1"]])}]}}]
                        :channels [{:id "ANBD24ZEC_CBVS0MT4N" :name "npm-test"}]
                        :name "npm-test"
                        :owner "slimslender"}
                       {:branches [{:commit {:fingerprints [{:name "npm-project-deps"
                                                             :data (json/json-str [["npm-test" "v2"]])}]}}]
                        :channels [{:id "ANBD24ZEC_CBW9RPH33" :name "npm1-test"}]
                        :name "npm1-test"
                        :owner "slimslender"}]}]
      (async done
        (go
         (done
          (is (= [{:done "slimslendernpm-testnpm-test"}]
                 (<! (broadcast
                      (fn [fp-name]
                        (is (= "npm-project-deps" fp-name))
                        (js/Promise.
                         (fn [resolve reject]
                           (resolve (clj->js data)))))
                      {:name "npm-test" :version "v2" :fp "npm-project-deps"}
                      (fn [owner name channel]
                        (swap! callback inc)
                        (is (= "slimslender" owner))
                        (is (= "npm-test" name))
                        (is (= "npm-test" channel))
                        (success-promise {:done (str owner name channel)}))))))
          (is (= 1 @callback) "broadcast method should broadcast to one repo")))))))

(deftest options-tests
  (is (= "Current library targets:\n*a:a*" (message {:a "a"})))
  (is (= "Current library targets:\n*a:a*\n*b:b*" (message {:a "a" :b "b"})))
  (is (= [{:text "librarya v1" :value "librarya:v1:npm-project-deps"}]
         (get-options [["librarya" "v1" "npm-project-deps"] ["a" "b" "npm-project-deps"]] {"a" "b"})))
  (is (= [{:text "librarya v1" :value "librarya:v1:npm-project-deps"}
          {:text "libraryc v2" :value "libraryc:v2:npm-project-deps"}]
         (get-options [["librarya" "v1" "crap" "npm-project-deps"] ["libraryc" "v2" "npm-project-deps"] ["a" "b"]] {"a" "b"}))))

(deftest with-project-goals-tests
  (let [goals {"librarya" "v1"}]
    (async done
           (go
             (done
              (<! (with-project-goals
                    (fn [] (js/Promise.
                            (fn [resolve reject]
                              (resolve (clj->js {:ChatTeam [{:preferences [{:name "atomist:fingerprints:clojure:project-deps" :value (json/json-str goals)}]}]})))))
                    "test-resources/lein"
                    (fn [m o]
                      (println "message" m)
                      (is (= "Current library targets:\n*librarya:v1*" m))
                      (is (= [{:text "cljs-node-io 0.5.0", :value "cljs-node-io:0.5.0:clojure-project-deps"}] (js->clj o :keywordize-keys true)))
                      (js/Promise.
                       (fn [resolve] (resolve :done)))))))))))

(deftest with-new-goal-tests
  (testing "that an existing goal of librarya/v1 can trigger an update to a new version in application/json form"
    (let [goals {"librarya" "v1"}]
      (async done
             (go
               (done
                (<! (with-new-goal
                      (fn [] (js/Promise.
                              (fn [resolve]
                                (resolve (clj->js {:ChatTeam [{:id "team-id" :preferences [{:name "atomist:fingerprints:clojure:project-deps" :value (json/json-str goals)}]}]})))))
                      (fn [team-id json]
                        (is (= "team-id" team-id))
                        (is (= "{\"librarya\":\"v2\"}" json))
                        (js/Promise.
                         (fn [resolve reject]
                           (resolve :done))))
                      {:name "librarya" :version "v2"}))))))))

(deftest with-new-goal-tests-from-string
  (testing "that an existing goal of librarya/v1 can trigger an update to a new version as string"
    (let [goals {"librarya" "v1"}]
      (async done
             (go
               (done
                (<! (with-new-goal
                      (fn [] (js/Promise.
                              (fn [resolve]
                                (resolve (clj->js {:ChatTeam [{:id "team-id" :preferences [{:name "atomist:fingerprints:clojure:project-deps" :value (json/json-str goals)}]}]})))))
                      (fn [team-id json]
                        (is (= "team-id" team-id))
                        (is (= "{\"librarya\":\"v2\"}" json))
                        (js/Promise.
                         (fn [resolve reject]
                           (resolve :done))))
                      "librarya:v2"))))))))

(deftest check-library-goals-tests
  (testing "that goals of librarya/v1 and a change to v2 will trigger a message of v1"
    (let [goals {"librarya" "v1"}
          message-sent (atom false)]
      (async done
             (go
               (done
                (<! (check-library-goals
                     (fn [] (js/Promise.
                             (fn [resolve reject]
                               (resolve (clj->js {:ChatTeam [{:preferences [{:name "atomist:fingerprints:clojure:project-deps" :value (json/json-str goals)}]}]})))))
                     (fn [text library]
                       (is (= "Target version for library *librarya* is *v1*\nCurrently *v2* in <https://github.com/owner/repo|owner/repo>" text))
                       (is (= {:library {:name "librarya" :version "v1"} :current "v2"} (js->clj library :keywordize-keys true)))
                       (reset! message-sent true)
                       (js/Promise. (fn [resolve] (resolve :done))))
                     {:to {:data {:librarya "v2"}} :owner "owner" :repo "repo"}))))))))

(defmethod report [:cljs.test/default :begin-test-var] [m]
  (println (gstring/format "--------\n:begin-test-var:   %s\n---------\n" (testing-vars-str m))))

(defmethod report [:cljs.test/default :end-test-var] [m]
  (println (gstring/format "--------\n:end-test-var:   %s\n---------\n" (testing-vars-str m)))
  (pprint (get-current-env)))

(comment
 (run-tests))