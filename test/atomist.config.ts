/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    Configuration,
    editModes,
} from "@atomist/automation-client";
import {
    Fingerprint,
    goals,
    Goals,
    GoalWithFulfillment,
    pushTest,
    PushTest,
    SoftwareDeliveryMachine,
    SoftwareDeliveryMachineConfiguration,
    whenPushSatisfies,
} from "@atomist/sdm";
import {
    configureSdm,
    createSoftwareDeliveryMachine,
} from "@atomist/sdm-core";
import {
    fingerprintImpactHandler,
    fingerprintSupport,
    messageMaker,
} from "..";
import {
    applyFingerprint,
    logbackFingerprints,
    cljFunctionFingerprints,
    depsFingerprints,
} from "../fingerprints";
import {
    applyBackpackFingerprint,
    backpackFingerprint,
} from "../lib/fingerprints/backpack";
import {
    applyDockerBaseFingerprint,
    dockerBaseFingerprint,
} from "../lib/fingerprints/dockerFrom";
import {
    applyNpmDepsFingerprint,
    createNpmDepsFingerprints,
} from "../lib/fingerprints/npmDeps";
import {
    checkNpmCoordinatesImpactHandler,
} from "../lib/machine/FingerprintSupport";

const IsNpm: PushTest = pushTest(`contains package.json file`, async pci =>
    !!(await pci.project.getFile("package.json")),
);

const IsClojure: PushTest = pushTest(`contains project.clj file`, async pci =>
    !!(await pci.project.getFile("project.clj")),
);

const backpackComplianceGoal = new GoalWithFulfillment(
    {
        uniqueName: "backpack-react-script-compliance",
        displayName: "backpack-compliance",
    },
).with(
    {
        name: "backpack-react-waiting",
    },
);

export const FingerprintGoal = new Fingerprint();
const FingerprintingGoals: Goals = goals("check fingerprints")
    .plan(FingerprintGoal, backpackComplianceGoal);

export function machineMaker(config: SoftwareDeliveryMachineConfiguration): SoftwareDeliveryMachine {

    const sdm = createSoftwareDeliveryMachine(
        {
            name: `${configuration.name}-test`,
            configuration: config,
        },
        whenPushSatisfies(IsNpm)
            .itMeans("fingerprint an npm project")
            .setGoals(FingerprintingGoals),
        whenPushSatisfies(IsClojure)
            .itMeans("fingerprint a clojure project")
            .setGoals(FingerprintingGoals)
    );

    sdm.addExtensionPacks(
        fingerprintSupport(
            FingerprintGoal,
            [
                {
                    extract: createNpmDepsFingerprints,
                    apply: applyNpmDepsFingerprint,
                    selector: fp => fp.name.startsWith("npm-project-dep"),
                },
                {
                    apply: applyDockerBaseFingerprint,
                    extract: dockerBaseFingerprint,
                    selector: myFp => myFp.name.startsWith("docker-base-image"),
                },
                {
                    extract: backpackFingerprint,
                    apply: applyBackpackFingerprint,
                    selector: fp => fp.name === "backpack-react-scripts",
                },
                {
                    extract: p => logbackFingerprints(p.baseDir),
                    apply: (p, fp) => applyFingerprint(p.baseDir, fp),
                    selector: fp => fp.name === "elk-logback",
                },
                {
                    extract: (p) => depsFingerprints(p.baseDir),
                    apply: (p,fp) => applyFingerprint(p.baseDir,fp),
                    selector: fp => fp.name.startsWith("clojure-project"),
                },
                {
                    extract: (p) => cljFunctionFingerprints(p.baseDir),
                    apply: (p,fp) => applyFingerprint(p.baseDir,fp),
                    selector: fp => fp.name.startsWith("public-defn-bodies"),
                },
            ],
            checkNpmCoordinatesImpactHandler(),
            fingerprintImpactHandler(
                {
                    complianceGoal: backpackComplianceGoal,
                    transformPresentation: ci => {
                        return new editModes.PullRequest(
                            `apply-target-fingerprint-${Date.now()}`,
                            `Apply fingerprint ${ci.parameters.fingerprint} to project`,
                            "Nudge generated by Atomist");
                    },
                    messageMaker,
                },
            ),
        ),
    );

    return sdm;
}

export const configuration: Configuration = {
    postProcessors: [
        configureSdm(machineMaker),
    ],
};
