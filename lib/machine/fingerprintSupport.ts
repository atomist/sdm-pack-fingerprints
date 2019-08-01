/*
 * Copyright © 2019 Atomist, Inc.
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
    editModes,
    Project,
} from "@atomist/automation-client";
import {
    AutoMergeMethod,
    AutoMergeMode,
} from "@atomist/automation-client/lib/operations/edit/editModes";
import {
    ExtensionPack,
    Fingerprint,
    Goal,
    metadata,
    PushAwareParametersInvocation,
    PushImpact,
    PushImpactListenerInvocation,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import { toArray } from "@atomist/sdm-core/lib/util/misc/array";
import * as _ from "lodash";
import { checkFingerprintTarget } from "../checktarget/callbacks";
import {
    ignoreCommand,
    messageMaker,
    MessageMaker,
} from "../checktarget/messageMaker";
import {
    applyTarget,
    applyTargetBySha,
    ApplyTargetParameters,
    applyTargets,
    broadcastFingerprintMandate,
} from "../handlers/commands/applyFingerprint";
import { broadcastFingerprintNudge } from "../handlers/commands/broadcast";
import { FingerprintMenu } from "../handlers/commands/fingerprints";
import {
    listFingerprint,
    listFingerprints,
} from "../handlers/commands/list";
import {
    listFingerprintTargets,
    listOneFingerprintTarget,
} from "../handlers/commands/showTargets";
import {
    deleteTargetFingerprint,
    selectTargetFingerprintFromCurrentProject,
    setTargetFingerprint,
    setTargetFingerprintFromLatestMaster,
    updateTargetFingerprint,
} from "../handlers/commands/updateTarget";
import {
    Aspect,
    FingerprintDiffHandler,
    FingerprintHandler,
    FP,
    Vote,
} from "./Aspect";
import {
    computeFingerprints,
    fingerprintRunner,
} from "./runner";

export function forFingerprints(...s: string[]): (fp: FP) => boolean {
    return fp => {
        return s.map(n => (fp.type === n) || (fp.name === n))
            .reduce((acc, v) => acc || v);
    };
}

/**
 * permits customization of EditModes in the FingerprintImpactHandlerConfig
 */
export type EditModeMaker = (cli: PushAwareParametersInvocation<ApplyTargetParameters>, project?: Project) => editModes.EditMode;

/**
 * customize the out of the box strategy for monitoring when fingerprints are out
 * of sync with a target.
 *
 */
export interface FingerprintImpactHandlerConfig {
    complianceGoal?: Goal;
    complianceGoalFailMessage?: string;
    transformPresentation: EditModeMaker;
    messageMaker: MessageMaker;
}

/**
 * Setting up a PushImpactHandler to handle different strategies (FingerprintHandlers) involves giving them the opportunity
 * to configure the sdm, and they'll need all of the current active Aspects.
 */
export type RegisterFingerprintImpactHandler = (sdm: SoftwareDeliveryMachine, registrations: Aspect[]) => FingerprintHandler;

export const DefaultTargetDiffHandler: FingerprintDiffHandler =
    async (ctx, diff, aspect) => {
        const v: Vote = await checkFingerprintTarget(
            ctx.context,
            diff,
            aspect,
            async () => {
                return diff.targets;
            },
        );
        return v;
    };

/**
 * wrap a FingerprintDiffHandler to only check if the shas have changed
 *
 * @param handler the FingerprintDiffHandler to wrap
 */
export function diffOnlyHandler(handler: FingerprintDiffHandler): FingerprintDiffHandler {
    return async (context, diff, aspect) => {
        if (diff.from && diff.to.sha !== diff.from.sha) {
            return handler(context, diff, aspect);
        } else {
            return {
                abstain: true,
            };
        }
    };
}

/**
 * Options to configure the Fingerprint support
 */
export interface FingerprintOptions {

    /**
     * Optional Fingerprint goal that will get configured.
     * If not provided fingerprints need to be registered manually with the goal.
     * @deprecated use pushImpactGoal instead
     */
    // tslint:disable:deprecation
    fingerprintGoal?: Fingerprint;

    /**
     * Optional PushImpact goal that will get configured
     */
    pushImpactGoal?: PushImpact;

    /**
     * Aspects we are managing
     */
    aspects: Aspect | Aspect[];

    /**
     * Register FingerprintHandler factories to handle fingerprint impacts
     * @deprecated embed handlers in Features
     */
    handlers?: RegisterFingerprintImpactHandler | RegisterFingerprintImpactHandler[];

    transformPresentation?: EditModeMaker;
}

export const DefaultEditModeMaker: EditModeMaker = createPullRequestEditModeMaker();

export function createPullRequestEditModeMaker(options: {
    branchPrefix?: string,
    title?: string,
    body?: string,
    message?: string,
    autoMerge?: {
        method?: AutoMergeMethod,
        mode?: AutoMergeMode,
    },
} = { }): EditModeMaker {
    return (ci, p) => {

        // name the branch apply-target-fingerprint with a Date
        // title can be derived from ApplyTargetParameters
        // body can be derived from ApplyTargetParameters
        // optional message is undefined here

        let fingerprint = ci.parameters.fingerprint || ci.parameters.targetfingerprint || ci.parameters.type as string;
        if (!!fingerprint) {
            fingerprint = `[fingerprint:${fingerprint}]`;
        } else {
            fingerprint = ci.parameters.fingerprints as string;
            if (!!fingerprint) {
                fingerprint = fingerprint.split(",").map(f => `[fingerprint:${fingerprint}]`).join(" ");
            }
        }


        const autoMerge = _.get(options, "autoMerge") || {};
        const title = options.title || ci.parameters.title || `Apply fingerprint target (${fingerprint})`;
        const body = options.body || ci.parameters.body || title;
        return new editModes.PullRequest(
            `${options.branchPrefix || "apply-target-fingerprint"}-${Date.now()}`,
            title,
            `${body}

[atomist:generated]${!!fingerprint ? ` ${fingerprint}` : ""}`,
            options.message,
            p.id.branch,
            {
                method: autoMerge.method || AutoMergeMethod.Squash,
                mode: autoMerge.mode || AutoMergeMode.ApprovedReview,
            });
    };
}

/**
 * Install and configure the fingerprint support in this SDM
 */
export function fingerprintSupport(options: FingerprintOptions): ExtensionPack {

    return {
        ...metadata(),
        configure: (sdm: SoftwareDeliveryMachine) => {

            const fingerprints: Aspect[] = toArray(options.aspects);
            // const handlerRegistrations: RegisterFingerprintImpactHandler[]
            //     = Array.isArray(options.handlers) ? options.handlers : [options.handlers];
            // const handlers: FingerprintHandler[] = handlerRegistrations.map(h => h(sdm, fingerprints));
            const handlerRegistrations: RegisterFingerprintImpactHandler[] = [];
            const handlers: FingerprintHandler[] = [];

            const runner = fingerprintRunner(
                fingerprints,
                handlers,
                computeFingerprints,
                {
                    messageMaker,
                    transformPresentation: DefaultEditModeMaker,
                    ...options,
                });

            // tslint:disable:deprecation
            if (!!options.fingerprintGoal) {
                options.fingerprintGoal.with({
                    name: `${options.fingerprintGoal.uniqueName}-fingerprinter`,
                    action: async (i: PushImpactListenerInvocation) => {
                        await runner(i);
                        return [];
                    },
                });
            }
            if (!!options.pushImpactGoal) {
                options.pushImpactGoal.withListener(runner);
            }

            configure(sdm, handlerRegistrations, fingerprints, options.transformPresentation || DefaultEditModeMaker);
        },
    };
}

function configure(
    sdm: SoftwareDeliveryMachine,
    handlers: RegisterFingerprintImpactHandler[],
    aspects: Aspect[],
    editModeMaker: EditModeMaker): void {

    sdm.addCommand(listFingerprints(sdm));
    sdm.addCommand(listFingerprint(sdm));

    // set a target given using the entire JSON fingerprint payload in a parameter
    sdm.addCommand(setTargetFingerprint(aspects));
    // set a different target after noticing that a fingerprint is different from current target
    sdm.addCommand(updateTargetFingerprint(sdm, aspects));
    // Bootstrap a fingerprint target by selecting one from current project
    sdm.addCommand(selectTargetFingerprintFromCurrentProject(sdm));
    // Bootstrap a fingerprint target from project by name
    sdm.addCommand(setTargetFingerprintFromLatestMaster(sdm, aspects));
    sdm.addCommand(deleteTargetFingerprint(sdm));

    // standard actionable message embedding ApplyTargetFingerprint
    sdm.addCommand(broadcastFingerprintNudge(aspects));

    sdm.addCommand(ignoreCommand(aspects));

    sdm.addCommand(listFingerprintTargets(sdm));
    sdm.addCommand(listOneFingerprintTarget(sdm));

    sdm.addCommand(FingerprintMenu);

    sdm.addCodeTransformCommand(applyTarget(sdm, aspects, editModeMaker));
    sdm.addCodeTransformCommand(applyTargets(sdm, aspects, editModeMaker));
    sdm.addCodeTransformCommand(applyTargetBySha(sdm, aspects, editModeMaker));

    sdm.addCommand(broadcastFingerprintMandate(sdm, aspects));

}
