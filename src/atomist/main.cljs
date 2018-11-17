(ns atomist.main
  (:require-macros [cljs.core.async.macros :refer [go]])
  (:require [cljs-node-io.core :as io :refer [slurp spit]]
            [cljs.core.async :refer [chan <! >!]]
            [cljs.analyzer :as cljs]
            [cljs.spec.alpha :as s]
            [clojure.pprint :refer [pprint]]
            [atomist.cljs-log :as log]
            [atomist.impact :as impact]
            [atomist.fingerprint :as fingerprint]
            [atomist.npm :as npm]
            [atomist.goals :as goals]
            [http.util :as util]
            [goog.string :as gstring]
            [goog.string.format]
            [atomist.deps :as deps]
            [atomist.promise :as promise]
            [hasch.core :as hasch]))

(defn ^:export processPushImpact
  "process a PushImpact event by potentially fetching additional fingerprint data, creating diffs,
   and calling handler functions for certain kinds of fingerprints.

   params
     event - PushImpact event in JS Object form
     get-fingerprint - query function for additional fingerprint data (sha: string, name: string) => Promise<string>
     obj - JS Object containing handler functions

   returns Promise<boolean>"
  [event get-fingerprint obj]
  (let [handlers (js->clj obj :keywordize-keys true)]
    (log/info "processPushImpact " (count handlers) " " handlers)
    (log/info "processPushImpact " (with-out-str (cljs.pprint/pprint (js->clj event :keywordize-keys true))))
    (let [no-diff-handlers (->> handlers
                                (filter #(contains? % :action))
                                (map #(dissoc % :diffAction)))
          diff-handlers (->> handlers
                             (filter #(contains? % :diffAction))
                             (map #(-> %
                                       (assoc :action (:diffAction %))
                                       (dissoc :diffAction))))]
      (promise/chan->promise
       (impact/process-push-impact
        (js->clj event :keywordize-keys true)
        get-fingerprint
        diff-handlers
        no-diff-handlers)))))

(defn ^:export sha256 [s]
  (clj->js (fingerprint/sha-256 (js->clj s))))

(defn ^:export fingerprint [s]
  (deps/get-fingerprint s))

(defn ^:export edit [f1 n v]
  (deps/edit f1 n v))

(defn ^:export applyFingerprint
  "returns void"
  [f1 query-fn fp-name]
  (go
   (let [fp (<! (goals/get-fingerprint-preference query-fn fp-name))]
     (log/info "apply fingerprint " fp " to basedir " f1)
     (deps/apply-fingerprint f1 fp))))

(defn format-list [xs]
  (->> xs
       (map #(gstring/format "`%s`" %))
       (interpose ",")
       (apply str)))

(defn ^:export renderDiff [diff]
  (log/info "renderDiff" (with-out-str (cljs.pprint/pprint (js->clj diff :keywordize-keys true))))
  (let [event (js->clj diff :keywordize-keys true)
        {:keys [owner repo] {:keys [from to]} :data {fp-name :name} :from} event]
    (if (or from to)
      (gstring/format "%s\n%s/%s %s"
                      (str
                       (if from (gstring/format "removed %s" (format-list from)))
                       (if (and from to) ", ")
                       (if to (gstring/format "added: %s" (format-list to))))
                      owner repo fp-name))))

(defn ^:export renderOptions [options]
  (log/info "renderOptions" (with-out-str (cljs.pprint/pprint (js->clj options :keywordize-keys true))))
  (let [event (js->clj options :keywordize-keys true)]
    (with-out-str
      (pprint (->> (seq event)
                   (map (fn [x] [(:text x) (:value x)]))
                   (into {}))))))

(defn ^:export renderData [x]
  (let [event (js->clj x :keywordize-keys true)]
    (with-out-str
     (pprint event))))

(defn ^:export consistentHash [edn]
  (.toString (hasch/uuid5 (hasch/edn-hash (js->clj edn)))))

(defn ^:export withProjectGoals
  "send a message about adding new library goals from the current project

   returns Promise<boolean>"
  [pref-query basedir send-message]
  (log/info "clj-editors withProjectGoals")
  (promise/chan->promise
   (goals/with-project-goals pref-query basedir send-message)))

(defn ^:export withPreferences
  "callback with a an array of maps with {:keys [text value]} maps

   returns Promise<boolean>"
  [pref-query callback]
  (log/info "clj-editors with-preferences")
  (promise/chan->promise
   (goals/with-preferences pref-query callback)))

(defn ^:export withNewGoal
  "update a goal in the current project

   returns Promise<boolean>"
  [pref-query pref-editor pref-namespace lib-goal]
  (log/info "cj-editors withNewGoal")
  (promise/chan->promise
   (goals/with-new-goal pref-query pref-editor (js->clj lib-goal :keywordize-keys true))))

(defn ^:export setGoalFingerprint
  "update a goal in the current project

   returns Promise<boolean>"
  [pref-query query-fingerprint-by-sha pref-editor fp-name fp-sha]
  (log/info "withGoalFingerprint")
  (promise/chan->promise
   (goals/set-fingerprint-preference pref-query query-fingerprint-by-sha pref-editor fp-name fp-sha)))

(defn ^:export withNewIgnore
  "update a goal in the current project

   returns Promise<boolean>"
  [pref-query pref-editor library]
  (log/info "withNewGoal")
  (promise/chan->promise
   (goals/with-new-ignore pref-query pref-editor (js->clj library :keywordize-keys true))))

(defn ^:export checkLibraryGoals
  "check a project for whether it's dependencies are aligned with the current goals

   returns Promise<boolean>"
  [pref-query send-message diff]
  (log/info "checkLibraryGoals")
  (promise/chan->promise
   (goals/check-library-goals pref-query send-message (js->clj diff :keywordize-keys true))))

(defn ^:export checkFingerprintGoals
  "check a project for whether it's dependencies are aligned with the current goals

   returns Promise<boolean>"
  [pref-query send-message diff]
  (log/info "checkFingerprintGoals")
  (promise/chan->promise
   (goals/check-fingerprint-goals pref-query send-message (js->clj diff :keywordize-keys true))))

(defn ^:export broadcast
  "use fingerprints to scan for projects that could be impacted by this new lib version

   returns Promise<any>"
  [fingerprint-query lib cb]
  (log/info "clj-editors broadcast")
  (promise/chan->promise
   (goals/broadcast fingerprint-query (js->clj lib :keywordize-keys true) cb)))

(defn ^:export npmLatest
  ""
  [package]
  (log/info "clj-editors npm latest")
  (js/Promise.
   (fn [resolve reject]
     (try
       (resolve (npm/latest package))
       (catch :default e
         (log/warn "failure to run npm latest " e)
         (reject e))))))

(defn noop [])

(set! *main-cli-fn* noop)